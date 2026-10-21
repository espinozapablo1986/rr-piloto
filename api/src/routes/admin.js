import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db.js';
import { asyncHandler, badRequest, conflict, notFound, parse } from '../lib/http.js';
import { DEPORTES, planEfectivo } from '../lib/planes.js';
import { calcularDashboard } from '../lib/dashboard.js';
import { clave, conImagenes, circuitoPublico, usoCircuitos, vincular } from '../lib/circuitos.js';
import { requireAdmin, revokeSessions, toPublicUser } from '../auth/session.js';
import { hashPassword } from '../auth/password.js';

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

/* Catálogo de circuitos y solicitudes de los pilotos */

const Circuito = z.object({
  nombre: z.string().trim().min(2, 'Falta el nombre.').max(120),
  ciudad: z.string().trim().max(120).optional().default(''),
  region: z.string().trim().max(120).optional().default(''),
  pais: z.string().trim().max(60).optional().default('Chile'),
  deportes: z.array(z.enum(DEPORTES)).optional().default([]),
  trazados: z.array(z.string().trim().min(1).max(60)).max(20).optional().default([]),
  longitud: z.number().int().min(0).max(100000).nullable().optional().default(null),
  // Nombres escritos a mano por los pilotos que se consolidan en este circuito.
  vincular: z.array(z.string().max(160)).max(50).optional().default([]),
});
const cDatos = (d) => ({
  nombre: d.nombre.replace(/\s+/g, ' '), clave: clave(d.nombre), ciudad: d.ciudad || null, region: d.region || null,
  pais: d.pais || null, deportes: [...new Set(d.deportes)], trazados: [...new Set(d.trazados)], longitud: d.longitud,
});
const duplicado = async (k, id) => {
  const o = await prisma.circuito.findFirst({ where: { clave: k, estado: 'APROBADO', ...(id ? { NOT: { id } } : {}) } });
  if (o) throw conflict(`Ya existe «${o.nombre}» en el catálogo. Fusiona en lugar de duplicar.`);
};

adminRouter.get('/circuitos', asyncHandler(async (_req, res) => {
  const [lista, uso] = await Promise.all([prisma.circuito.findMany({ orderBy: { nombre: 'asc' }, include: conImagenes }), usoCircuitos()]);
  const ids = [...new Set(lista.map((c) => c.propuestoPor).filter(Boolean))];
  const us = await prisma.usuario.findMany({ where: { id: { in: ids } }, include: { ficha: { select: { datos: true } } } });
  const quien = Object.fromEntries(us.map((u) => [u.id, { id: u.id, email: u.email, nombre: u.ficha?.datos?.perfil?.nombre || u.email }]));
  const conUso = (c) => ({ ...c, imagenes: circuitoPublico(c).imagenes, sesiones: uso.porId[c.id] || 0, propuesto: c.propuestoPor ? quien[c.propuestoPor] || null : null });
  // Los nombres escritos a mano que ya coinciden con un circuito aprobado
  // también se ofrecen para consolidar.
  const aprob = new Map(lista.filter((c) => c.estado === 'APROBADO').map((c) => [c.clave, c]));
  res.json({
    catalogo: lista.filter((c) => c.estado === 'APROBADO').map(conUso),
    solicitudes: lista.filter((c) => c.estado === 'PROPUESTO').map(conUso),
    sueltos: uso.sueltos.map((x) => ({ ...x, coincide: aprob.get(x.clave)?.id || null })),
  });
}));

adminRouter.post('/circuitos', asyncHandler(async (req, res) => {
  const d = parse(Circuito, req.body);
  await duplicado(clave(d.nombre));
  const c = await prisma.circuito.create({ data: { ...cDatos(d), estado: 'APROBADO' } });
  const n = await vincular({ nombres: [...d.vincular, d.nombre], destino: c });
  res.status(201).json({ circuito: c, vinculadas: n });
}));

adminRouter.put('/circuitos/:id', asyncHandler(async (req, res) => {
  const d = parse(Circuito, req.body);
  const c0 = await prisma.circuito.findUnique({ where: { id: req.params.id } });
  if (!c0) throw notFound();
  await duplicado(clave(d.nombre), c0.id);
  const c = await prisma.circuito.update({ where: { id: c0.id }, data: cDatos(d) });
  // Un cambio de nombre se propaga a las sesiones que ya lo usan.
  const n = await vincular({ ids: [c.id], nombres: d.vincular, destino: c });
  res.json({ circuito: c, vinculadas: n });
}));

// Aprobar una propuesta: se publica (con los datos que corrija el admin) y las
// sesiones que la usaban quedan consolidadas.
adminRouter.post('/circuitos/:id/aprobar', asyncHandler(async (req, res) => {
  const d = parse(Circuito, req.body);
  const p = await prisma.circuito.findFirst({ where: { id: req.params.id, estado: 'PROPUESTO' } });
  if (!p) throw notFound('Solicitud no encontrada.');
  await duplicado(clave(d.nombre), p.id);
  const c = await prisma.circuito.update({ where: { id: p.id }, data: { ...cDatos(d), estado: 'APROBADO' } });
  const n = await vincular({ ids: [c.id], nombres: d.vincular, destino: c });
  res.json({ circuito: c, vinculadas: n });
}));

const Fusion = z.object({ destinoId: z.string().min(1) });

// Fusionar una propuesta (o un nombre escrito a mano) en un circuito existente.
adminRouter.post('/circuitos/:id/fusionar', asyncHandler(async (req, res) => {
  const { destinoId } = parse(Fusion, req.body);
  const [p, dst] = await Promise.all([
    prisma.circuito.findUnique({ where: { id: req.params.id } }),
    prisma.circuito.findFirst({ where: { id: destinoId, estado: 'APROBADO' } }),
  ]);
  if (!p || !dst || p.id === dst.id) throw notFound('Circuito no encontrado.');
  const n = await vincular({ ids: [p.id], destino: dst });
  if (p.trazados.length) {
    await prisma.circuito.update({ where: { id: dst.id }, data: { trazados: [...new Set([...dst.trazados, ...p.trazados])] } });
  }
  await prisma.circuito.delete({ where: { id: p.id } });
  res.json({ ok: true, vinculadas: n });
}));

const Suelto = z.object({ nombre: z.string().min(1).max(160), destinoId: z.string().min(1) });

adminRouter.post('/circuitos/vincular', asyncHandler(async (req, res) => {
  const d = parse(Suelto, req.body);
  const dst = await prisma.circuito.findFirst({ where: { id: d.destinoId, estado: 'APROBADO' } });
  if (!dst) throw notFound('Circuito no encontrado.');
  res.json({ ok: true, vinculadas: await vincular({ nombres: [d.nombre], destino: dst }) });
}));

// Rechazar: las sesiones conservan el nombre escrito, sin circuito asignado.
adminRouter.post('/circuitos/:id/rechazar', asyncHandler(async (req, res) => {
  const p = await prisma.circuito.findFirst({ where: { id: req.params.id, estado: 'PROPUESTO' } });
  if (!p) throw notFound('Solicitud no encontrada.');
  await vincular({ ids: [p.id], destino: null });
  await prisma.circuito.update({ where: { id: p.id }, data: { estado: 'RECHAZADO' } });
  res.json({ ok: true });
}));

adminRouter.delete('/circuitos/:id', asyncHandler(async (req, res) => {
  await vincular({ ids: [req.params.id], destino: null });
  await prisma.circuito.deleteMany({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

/* Fotos de circuitos (máximo 5, una principal) */

const MAX_FOTOS = 5;
const Foto = z.object({
  datos: z.string().regex(/^data:image\/(jpeg|png|webp);base64,/, 'Imagen no válida.').max(2_000_000, 'La imagen es demasiado pesada.'),
  principal: z.boolean().optional().default(false),
});

adminRouter.post('/circuitos/:id/imagenes', asyncHandler(async (req, res) => {
  const d = parse(Foto, req.body);
  const c = await prisma.circuito.findUnique({ where: { id: req.params.id }, include: { _count: { select: { imagenes: true } } } });
  if (!c) throw notFound();
  if (c._count.imagenes >= MAX_FOTOS) throw conflict(`Cada circuito admite hasta ${MAX_FOTOS} fotos.`);
  const [, tipo, b64] = d.datos.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
  // La primera foto es la principal; si se marca otra, deja de serlo la anterior.
  const principal = d.principal || c._count.imagenes === 0;
  if (principal) await prisma.circuitoImagen.updateMany({ where: { circuitoId: c.id }, data: { principal: false } });
  const i = await prisma.circuitoImagen.create({
    data: { circuitoId: c.id, datos: Buffer.from(b64, 'base64'), tipo, principal, orden: c._count.imagenes },
    select: { id: true },
  });
  res.status(201).json({ id: i.id });
}));

adminRouter.post('/circuitos/:id/imagenes/:img/principal', asyncHandler(async (req, res) => {
  const i = await prisma.circuitoImagen.findFirst({ where: { id: req.params.img, circuitoId: req.params.id }, select: { id: true } });
  if (!i) throw notFound();
  await prisma.circuitoImagen.updateMany({ where: { circuitoId: req.params.id }, data: { principal: false } });
  await prisma.circuitoImagen.update({ where: { id: i.id }, data: { principal: true } });
  res.json({ ok: true });
}));

adminRouter.delete('/circuitos/:id/imagenes/:img', asyncHandler(async (req, res) => {
  const i = await prisma.circuitoImagen.findFirst({ where: { id: req.params.img, circuitoId: req.params.id } });
  if (!i) throw notFound();
  await prisma.circuitoImagen.delete({ where: { id: i.id } });
  // Si se borró la principal, la siguiente pasa a serlo.
  if (i.principal) {
    const otra = await prisma.circuitoImagen.findFirst({ where: { circuitoId: req.params.id }, orderBy: { orden: 'asc' } });
    if (otra) await prisma.circuitoImagen.update({ where: { id: otra.id }, data: { principal: true } });
  }
  res.json({ ok: true });
}));

/* Recompensas por nivel */

const Recompensa = z.object({
  nivel: z.number().int().min(1).max(7),
  titulo: z.string().trim().min(1, 'Falta el título.').max(160),
  descripcion: z.string().trim().max(1000).optional().default(''),
  sponsor: z.string().trim().max(120).optional().default(''),
  codigo: z.string().trim().max(500).optional().default(''),
  enlace: z.union([z.literal(''), z.string().trim().max(500)
    .regex(/^https?:\/\/[^\s]+$/i, 'El enlace debe ser una URL completa (https://…).')]).optional().default(''),
  activo: z.boolean().optional().default(true),
  orden: z.number().int().min(-9999).max(9999).optional().default(0),
});

adminRouter.get('/recompensas', asyncHandler(async (_req, res) => {
  res.json({ items: await prisma.recompensa.findMany({ orderBy: [{ nivel: 'asc' }, { orden: 'asc' }] }) });
}));

adminRouter.post('/recompensas', asyncHandler(async (req, res) => {
  res.status(201).json({ item: await prisma.recompensa.create({ data: parse(Recompensa, req.body) }) });
}));

adminRouter.put('/recompensas/:id', asyncHandler(async (req, res) => {
  const data = parse(Recompensa, req.body);
  if (!(await prisma.recompensa.findUnique({ where: { id: req.params.id } }))) throw notFound();
  res.json({ item: await prisma.recompensa.update({ where: { id: req.params.id }, data }) });
}));

adminRouter.delete('/recompensas/:id', asyncHandler(async (req, res) => {
  await prisma.recompensa.deleteMany({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

/* Administradores: con nombre de usuario, correo o ambos */

const usuarioId = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9._-]{3,40}$/, 'El usuario debe tener de 3 a 40 caracteres: letras, números, punto, guion o guion bajo.');
const correo = z.union([z.literal(''), z.string().trim().toLowerCase().email('Correo no válido.').max(160)]);
const Admin = z.object({
  usuario: z.union([z.literal(''), usuarioId]).optional().default(''),
  email: correo.optional().default(''),
  nombre: z.string().trim().max(120).optional().default(''),
  password: z.union([z.literal(''), z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200)]).optional().default(''),
});
const pubAdmin = (u) => ({ id: u.id, usuario: u.usuario, email: u.email, nombre: u.nombre, creado: u.creado });

const libre = async (d, id) => {
  if (!d.usuario && !d.email) throw badRequest('Indica un nombre de usuario o un correo.');
  const otro = await prisma.usuario.findFirst({
    where: {
      OR: [...(d.usuario ? [{ usuario: d.usuario }, { email: d.usuario }] : []), ...(d.email ? [{ email: d.email }, { usuario: d.email }] : [])],
      ...(id ? { NOT: { id } } : {}),
    },
  });
  if (otro) throw conflict('Ese usuario o correo ya está en uso.');
};

adminRouter.get('/admins', asyncHandler(async (req, res) => {
  const us = await prisma.usuario.findMany({ where: { rol: 'ADMIN' }, orderBy: { creado: 'asc' } });
  res.json({ items: us.map(pubAdmin), yo: req.user.id });
}));

adminRouter.post('/admins', asyncHandler(async (req, res) => {
  const d = parse(Admin, req.body);
  if (!d.password) throw badRequest('Indica una contraseña.');
  await libre(d);
  const u = await prisma.usuario.create({
    data: {
      usuario: d.usuario || null, email: d.email || null, nombre: d.nombre || null,
      hash: await hashPassword(d.password), rol: 'ADMIN', estado: 'APROBADO', aprobado: new Date(),
    },
  });
  res.status(201).json({ item: pubAdmin(u) });
}));

// Contraseña vacía = no se cambia. Si se cambia, se cierran sus sesiones
// (salvo la del administrador que edita su propia cuenta).
adminRouter.put('/admins/:id', asyncHandler(async (req, res) => {
  const d = parse(Admin, req.body);
  const u0 = await prisma.usuario.findFirst({ where: { id: req.params.id, rol: 'ADMIN' } });
  if (!u0) throw notFound('Administrador no encontrado.');
  await libre(d, u0.id);
  const u = await prisma.usuario.update({
    where: { id: u0.id },
    data: {
      usuario: d.usuario || null, email: d.email || null, nombre: d.nombre || null,
      ...(d.password ? { hash: await hashPassword(d.password) } : {}),
    },
  });
  if (d.password) await revokeSessions(u.id, u.id === req.user.id ? req.sessionToken : undefined);
  res.json({ item: pubAdmin(u) });
}));

adminRouter.delete('/admins/:id', asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) throw badRequest('No puedes eliminar tu propia cuenta.');
  const n = await prisma.usuario.count({ where: { rol: 'ADMIN' } });
  if (n <= 1) throw badRequest('Debe quedar al menos un administrador.');
  await prisma.usuario.deleteMany({ where: { id: req.params.id, rol: 'ADMIN' } });
  res.json({ ok: true });
}));
