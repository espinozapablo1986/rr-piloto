import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db.js';
import { asyncHandler, conflict, forbidden, parse } from '../lib/http.js';
import { fichaVacia, sanear } from '../lib/ficha.js';
import { nivel } from '../lib/planes.js';
import { COOKIE_NAME, cookieOptions, requireAprobado, toPublicUser } from '../auth/session.js';

// Todo lo que hace un piloto con su cuenta ya aprobada.
export const pilotoRouter = Router();
pilotoRouter.use(requireAprobado);

pilotoRouter.get('/ficha', asyncHandler(async (req, res) => {
  const f = await prisma.ficha.upsert({
    where: { usuarioId: req.user.id },
    update: {},
    create: { usuarioId: req.user.id, datos: fichaVacia({ correo: req.user.email }) },
  });
  res.json({ datos: f.datos, version: f.version });
}));

const Guardar = z.object({ datos: z.record(z.string(), z.unknown()), version: z.number().int().min(0) });

pilotoRouter.put('/ficha', asyncHandler(async (req, res) => {
  const d = parse(Guardar, req.body);
  const f = await prisma.ficha.findUnique({ where: { usuarioId: req.user.id } });
  const actual = f?.version ?? 0;
  if (d.version !== actual) {
    throw conflict('Tu ficha cambió en otro dispositivo. Recarga para ver la versión más reciente.');
  }
  const datos = sanear(d.datos, f?.datos, nivel(req.user));
  // La versión también va en el filtro: si otra petición guardó entremedio,
  // no se actualiza nada y se responde con conflicto.
  const r = await prisma.ficha.updateMany({
    where: { usuarioId: req.user.id, version: actual },
    data: { datos, version: actual + 1 },
  });
  if (!r.count) {
    if (f) throw conflict('Tu ficha cambió en otro dispositivo. Recarga para ver la versión más reciente.');
    await prisma.ficha.create({ data: { usuarioId: req.user.id, datos, version: 1 } });
  }
  res.json({ datos, version: actual + 1 });
}));

const CambioPlan = z.object({ plan: z.enum(['GRATIS', 'PLUS', 'PRO']) });

// Simulado: cambiar de plan no cobra nada durante la beta.
pilotoRouter.put('/cuenta/plan', asyncHandler(async (req, res) => {
  const { plan } = parse(CambioPlan, req.body);
  const u = await prisma.usuario.update({ where: { id: req.user.id }, data: { plan } });
  res.json({ user: toPublicUser(u) });
}));

const Mailing = z.object({ mailing: z.boolean() });

pilotoRouter.put('/cuenta/mailing', asyncHandler(async (req, res) => {
  const { mailing } = parse(Mailing, req.body);
  const u = await prisma.usuario.update({
    where: { id: req.user.id },
    data: { consentimiento: { ...(req.user.consentimiento || {}), mailing } },
  });
  res.json({ user: toPublicUser(u) });
}));

// Derecho a eliminación: borra la cuenta y, en cascada, la ficha y sus sesiones.
pilotoRouter.delete('/cuenta', asyncHandler(async (req, res) => {
  if (req.user.rol === 'ADMIN') throw forbidden('Una cuenta de administrador no se borra desde aquí.');
  await prisma.usuario.delete({ where: { id: req.user.id } });
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}));

pilotoRouter.get('/contenido', asyncHandler(async (req, res) => {
  if (nivel(req.user) < 2) throw forbidden('El material y los beneficios son parte del plan Pro.');
  const items = await prisma.contenido.findMany({
    where: { publicado: true },
    orderBy: [{ orden: 'asc' }, { creado: 'desc' }],
    select: { id: true, tipo: true, titulo: true, resumen: true, cuerpo: true, enlace: true },
  });
  res.json({ items });
}));
