import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db.js';
import { asyncHandler, notFound, parse } from '../lib/http.js';
import { DEPORTES, planEfectivo } from '../lib/planes.js';
import { calcularDashboard } from '../lib/dashboard.js';
import { requireAdmin, revokeSessions, toPublicUser } from '../auth/session.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// Resumen de la ficha para la lista: lo justo para reconocer al piloto.
const resumen = (u) => {
  const d = u.ficha?.datos || {};
  const p = d.perfil || {};
  const ses = Array.isArray(d.sesiones) ? d.sesiones : [];
  return {
    ...toPublicUser(u),
    creado: u.creado,
    aprobado: u.aprobado,
    cortesiaGuardada: u.cortesia,
    cortesiaHastaGuardada: u.cortesiaHasta ? u.cortesiaHasta.toISOString().slice(0, 10) : null,
    nombre: p.nombre || '',
    anunciosPro: u.anunciosPro,
    rut: p.rut || '',
    telefono: p.telefono || '',
    sesiones: ses.length,
    pistas: new Set(ses.map((s) => String(s.circuito || '').trim().toLowerCase()).filter(Boolean)).size,
    actualizada: u.ficha?.actualizada || null,
  };
};

adminRouter.get('/usuarios', asyncHandler(async (_req, res) => {
  const us = await prisma.usuario.findMany({
    where: { rol: 'PILOTO' },
    include: { ficha: true },
    orderBy: { creado: 'desc' },
  });
  res.json({ usuarios: us.map(resumen) });
}));

const buscar = async (id) => {
  const u = await prisma.usuario.findFirst({ where: { id, rol: 'PILOTO' }, include: { ficha: true } });
  if (!u) throw notFound('Piloto no encontrado.');
  return u;
};

adminRouter.get('/usuarios/:id', asyncHandler(async (req, res) => {
  const u = await buscar(req.params.id);
  res.json({ usuario: resumen(u), datos: u.ficha?.datos || {} });
}));

const plan = z.enum(['GRATIS', 'PLUS', 'PRO']);
const Cambio = z.object({
  estado: z.enum(['PENDIENTE', 'APROBADO', 'RECHAZADO']).optional(),
  plan: plan.optional(),
  // null quita la cortesía; la fecha es opcional (sin ella no caduca).
  cortesia: plan.nullable().optional(),
  cortesiaHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida.').nullable().optional(),
});

adminRouter.patch('/usuarios/:id', asyncHandler(async (req, res) => {
  const d = parse(Cambio, req.body);
  const u = await buscar(req.params.id);
  const data = {};
  if (d.estado) {
    data.estado = d.estado;
    if (d.estado === 'APROBADO' && !u.aprobado) data.aprobado = new Date();
  }
  if (d.plan) data.plan = d.plan;
  if (d.cortesia !== undefined) data.cortesia = d.cortesia === 'GRATIS' ? null : d.cortesia;
  if (d.cortesiaHasta !== undefined) data.cortesiaHasta = d.cortesiaHasta ? new Date(d.cortesiaHasta) : null;
  if (data.cortesia === null) data.cortesiaHasta = null;

  const r = await prisma.usuario.update({ where: { id: u.id }, data, include: { ficha: true } });
  // Al rechazar una cuenta se la saca de cualquier dispositivo donde esté.
  if (d.estado === 'RECHAZADO') await revokeSessions(u.id);
  res.json({ usuario: resumen(r), planEfectivo: planEfectivo(r) });
}));

adminRouter.delete('/usuarios/:id', asyncHandler(async (req, res) => {
  const u = await buscar(req.params.id);
  await prisma.usuario.delete({ where: { id: u.id } });
  res.json({ ok: true });
}));

/* Material y beneficios del plan Pro */

const Contenido = z.object({
  tipo: z.enum(['MATERIAL', 'BENEFICIO']),
  titulo: z.string().trim().min(1, 'Falta el título.').max(200),
  categoria: z.string().trim().max(80).optional().default(''),
  resumen: z.string().trim().max(500).optional().default(''),
  cuerpo: z.string().max(20000).optional().default(''),
  // Solo http(s): el enlace se muestra como botón a los pilotos.
  enlace: z.union([z.literal(''), z.string().trim().max(500)
    .regex(/^https?:\/\/[^\s]+$/i, 'El enlace debe ser una URL completa (https://…).')])
    .optional().default(''),
  publicado: z.boolean().optional().default(true),
  orden: z.number().int().min(-9999).max(9999).optional().default(0),
});

adminRouter.get('/contenido', asyncHandler(async (_req, res) => {
  const items = await prisma.contenido.findMany({ orderBy: [{ orden: 'asc' }, { creado: 'desc' }] });
  res.json({ items });
}));

adminRouter.post('/contenido', asyncHandler(async (req, res) => {
  const item = await prisma.contenido.create({ data: parse(Contenido, req.body) });
  res.status(201).json({ item });
}));

adminRouter.put('/contenido/:id', asyncHandler(async (req, res) => {
  const data = parse(Contenido, req.body);
  const ok = await prisma.contenido.findUnique({ where: { id: req.params.id } });
  if (!ok) throw notFound();
  res.json({ item: await prisma.contenido.update({ where: { id: req.params.id }, data }) });
}));

adminRouter.delete('/contenido/:id', asyncHandler(async (req, res) => {
  await prisma.contenido.deleteMany({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

/* Dashboard */

adminRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const deporte = DEPORTES.includes(req.query.deporte) ? req.query.deporte : '';
  const dias = [30, 90, 180, 365].includes(+req.query.dias) ? +req.query.dias : 0;
  res.json(await calcularDashboard({ deporte, dias }));
}));

/* Publicidad de sponsors */

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida.');
const Anuncio = z.object({
  sponsor: z.string().trim().min(1, 'Falta el sponsor.').max(120),
  titulo: z.string().trim().min(1, 'Falta el título.').max(160),
  texto: z.string().trim().max(400).optional().default(''),
  // El panel ya entrega el banner reducido a JPEG; el tope evita abusos.
  imagen: z.union([z.literal(''), z.string().startsWith('data:image/').max(900_000, 'La imagen es demasiado pesada.')])
    .optional().default(''),
  enlace: z.union([z.literal(''), z.string().trim().max(500)
    .regex(/^https?:\/\/[^\s]+$/i, 'El enlace debe ser una URL completa (https://…).')]).optional().default(''),
  lugares: z.array(z.enum(['INICIO', 'SESIONES', 'DATOS'])).min(1, 'Elige al menos un lugar.'),
  deportes: z.array(z.enum(DEPORTES)).optional().default([]),
  desde: fecha.nullable().optional().default(null),
  hasta: fecha.nullable().optional().default(null),
  activo: z.boolean().optional().default(true),
  peso: z.number().int().min(1).max(100).optional().default(1),
});
const aDatos = (d) => ({ ...d, desde: d.desde ? new Date(d.desde) : null, hasta: d.hasta ? new Date(d.hasta) : null });

adminRouter.get('/anuncios', asyncHandler(async (_req, res) => {
  res.json({ items: await prisma.anuncio.findMany({ orderBy: [{ activo: 'desc' }, { creado: 'desc' }] }) });
}));

adminRouter.post('/anuncios', asyncHandler(async (req, res) => {
  res.status(201).json({ item: await prisma.anuncio.create({ data: aDatos(parse(Anuncio, req.body)) }) });
}));

adminRouter.put('/anuncios/:id', asyncHandler(async (req, res) => {
  const data = aDatos(parse(Anuncio, req.body));
  if (!(await prisma.anuncio.findUnique({ where: { id: req.params.id } }))) throw notFound();
  res.json({ item: await prisma.anuncio.update({ where: { id: req.params.id }, data }) });
}));

adminRouter.post('/anuncios/:id/reiniciar', asyncHandler(async (req, res) => {
  await prisma.anuncio.updateMany({ where: { id: req.params.id }, data: { impresiones: 0, clics: 0 } });
  res.json({ ok: true });
}));

adminRouter.delete('/anuncios/:id', asyncHandler(async (req, res) => {
  await prisma.anuncio.deleteMany({ where: { id: req.params.id } });
  res.json({ ok: true });
}));
