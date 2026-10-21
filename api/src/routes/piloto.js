import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db.js';
import { asyncHandler, conflict, forbidden, parse } from '../lib/http.js';
import { fichaVacia, sanear } from '../lib/ficha.js';
import { DEPORTES, nivel, veAnuncios } from '../lib/planes.js';
import { circuitoPublico, clave, conImagenes } from '../lib/circuitos.js';
import { progreso } from '../lib/logros.js';
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

const Deportes = z.object({ deportes: z.array(z.enum(DEPORTES)).min(1, 'Elige al menos un deporte.').max(DEPORTES.length) });

pilotoRouter.put('/cuenta/deportes', asyncHandler(async (req, res) => {
  const { deportes } = parse(Deportes, req.body);
  const u = await prisma.usuario.update({ where: { id: req.user.id }, data: { deportes: [...new Set(deportes)] } });
  res.json({ user: toPublicUser(u) });
}));

const Ads = z.object({ activo: z.boolean() });

// Solo tiene efecto en el plan Pro: los demás planes siempre ven anuncios.
pilotoRouter.put('/cuenta/anuncios', asyncHandler(async (req, res) => {
  const { activo } = parse(Ads, req.body);
  const u = await prisma.usuario.update({ where: { id: req.user.id }, data: { anunciosPro: activo } });
  res.json({ user: toPublicUser(u) });
}));

const LUGARES = ['INICIO', 'SESIONES', 'DATOS'];
const hoy = () => new Date(new Date().toISOString().slice(0, 10));

// Entrega un anuncio para un espacio de la app y cuenta la impresión. Si el
// piloto no debe ver publicidad, o no hay anuncios vigentes, responde null.
pilotoRouter.get('/anuncios', asyncHandler(async (req, res) => {
  const lugar = String(req.query.lugar || '');
  const deporte = String(req.query.deporte || '');
  if (!veAnuncios(req.user) || !LUGARES.includes(lugar)) return res.json({ anuncio: null });
  const d = hoy();
  const lista = await prisma.anuncio.findMany({
    where: {
      activo: true,
      lugares: { has: lugar },
      AND: [
        { OR: [{ desde: null }, { desde: { lte: d } }] },
        { OR: [{ hasta: null }, { hasta: { gte: d } }] },
      ],
    },
    select: { id: true, sponsor: true, titulo: true, texto: true, imagen: true, enlace: true, deportes: true, peso: true },
  });
  const ok = lista.filter((a) => !a.deportes.length || a.deportes.includes(deporte));
  if (!ok.length) return res.json({ anuncio: null });
  // Sorteo ponderado por peso.
  let r = Math.random() * ok.reduce((t, a) => t + Math.max(1, a.peso), 0);
  const a = ok.find((x) => (r -= Math.max(1, x.peso)) < 0) || ok[0];
  await prisma.anuncio.update({ where: { id: a.id }, data: { impresiones: { increment: 1 } } });
  const { deportes: _d, peso: _p, ...anuncio } = a;
  res.json({ anuncio });
}));

pilotoRouter.post('/anuncios/:id/clic', asyncHandler(async (req, res) => {
  await prisma.anuncio.updateMany({ where: { id: req.params.id }, data: { clics: { increment: 1 } } });
  res.json({ ok: true });
}));

/* Circuitos: catálogo aprobado más las propuestas propias en revisión */

pilotoRouter.get('/circuitos', asyncHandler(async (req, res) => {
  const deporte = DEPORTES.includes(req.query.deporte) ? req.query.deporte : '';
  const lista = await prisma.circuito.findMany({
    where: {
      AND: [
        { OR: [{ estado: 'APROBADO' }, { estado: 'PROPUESTO', propuestoPor: req.user.id }] },
        // Sin deportes asignados = sirve para todos.
        ...(deporte ? [{ OR: [{ deportes: { isEmpty: true } }, { deportes: { has: deporte } }] }] : []),
      ],
    },
    orderBy: { nombre: 'asc' },
    include: conImagenes,
  });
  res.json({ circuitos: lista.map(circuitoPublico) });
}));

const Propuesta = z.object({
  nombre: z.string().trim().min(2, 'Indica el nombre del circuito.').max(120),
  ciudad: z.string().trim().max(120).optional().default(''),
  pais: z.string().trim().max(60).optional().default('Chile'),
  trazados: z.array(z.string().trim().min(1).max(60)).max(10).optional().default([]),
  nota: z.string().trim().max(500).optional().default(''),
  deporte: z.enum(DEPORTES),
});

// El circuito propuesto se puede usar de inmediato en las sesiones del piloto;
// queda provisorio hasta que el administrador lo consolida.
pilotoRouter.post('/circuitos', asyncHandler(async (req, res) => {
  const d = parse(Propuesta, req.body);
  const k = clave(d.nombre);
  const existe = await prisma.circuito.findFirst({
    where: { clave: k, OR: [{ estado: 'APROBADO' }, { estado: 'PROPUESTO', propuestoPor: req.user.id }] },
  });
  if (existe) return res.json({ circuito: circuitoPublico(existe), existente: true });
  const pendientes = await prisma.circuito.count({ where: { estado: 'PROPUESTO', propuestoPor: req.user.id } });
  if (pendientes >= 10) throw forbidden('Tienes 10 circuitos en revisión. Espera a que Rubus Racing los revise.');
  const c = await prisma.circuito.create({
    data: {
      nombre: d.nombre.replace(/\s+/g, ' '), clave: k, ciudad: d.ciudad || null, pais: d.pais || null,
      trazados: [...new Set(d.trazados)], deportes: [d.deporte], estado: 'PROPUESTO',
      propuestoPor: req.user.id, nota: d.nota || null,
    },
  });
  res.status(201).json({ circuito: circuitoPublico(c) });
}));

// Recompensas por nivel: solo cuentas de pago. El código de cada premio se
// entrega únicamente cuando el nivel calculado en el servidor lo desbloquea.
pilotoRouter.get('/recompensas', asyncHandler(async (req, res) => {
  if (nivel(req.user) < 1) throw forbidden('Las recompensas son para cuentas Plus y Pro.');
  const f = await prisma.ficha.findUnique({ where: { usuarioId: req.user.id } });
  const p = progreso(f?.datos);
  const lista = await prisma.recompensa.findMany({ where: { activo: true }, orderBy: [{ nivel: 'asc' }, { orden: 'asc' }] });
  res.json({
    progreso: p,
    items: lista.map((r) => {
      const ok = p.nivel >= r.nivel;
      return {
        id: r.id, nivel: r.nivel, titulo: r.titulo, descripcion: r.descripcion, sponsor: r.sponsor,
        desbloqueada: ok, codigo: ok ? r.codigo : null, enlace: ok ? r.enlace : null,
      };
    }),
  });
}));

pilotoRouter.get('/contenido', asyncHandler(async (req, res) => {
  if (nivel(req.user) < 2) throw forbidden('El material y los beneficios son parte del plan Pro.');
  const items = await prisma.contenido.findMany({
    where: { publicado: true },
    orderBy: [{ orden: 'asc' }, { creado: 'desc' }],
    select: { id: true, tipo: true, titulo: true, categoria: true, resumen: true, cuerpo: true, enlace: true },
  });
  res.json({ items });
}));
