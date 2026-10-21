import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db.js';
import crypto from 'node:crypto';
import { asyncHandler, badRequest, conflict, notFound, parse } from '../lib/http.js';
import { planEfectivo } from '../lib/planes.js';
import { DEPORTES_DEF, ICONOS_DEP, VEHICULOS, deporteId, deportes, esDeporte, guardarDeportes, usoDeportes } from '../lib/deportes.js';
import { calcularDashboard } from '../lib/dashboard.js';
import { guardarPremios, leerPremios } from '../lib/logros.js';
import { clave, conImagenes, circuitoPublico, usoCircuitos, vincular, vincularLote } from '../lib/circuitos.js';
import { requireAdmin, revokeSessions, toPublicUser } from '../auth/session.js';
import { hashPassword } from '../auth/password.js';
import { fichaVacia, limpiarPerfil, limpiarSesion } from '../lib/ficha.js';

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
  email: z.string().trim().toLowerCase().email('Correo no válido.').max(160).optional(),
  deportes: z.array(deporteId).min(1, 'Elige al menos un deporte.').optional(),
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
  if (d.deportes) data.deportes = [...new Set(d.deportes)];
  if (d.email && d.email !== u.email) {
    const otro = await prisma.usuario.findFirst({ where: { OR: [{ email: d.email }, { usuario: d.email }], NOT: { id: u.id } } });
    if (otro) throw conflict('Ese correo ya está en uso.');
    data.email = d.email;
  }
  if (d.cortesia !== undefined) data.cortesia = d.cortesia === 'GRATIS' ? null : d.cortesia;
  if (d.cortesiaHasta !== undefined) data.cortesiaHasta = d.cortesiaHasta ? new Date(d.cortesiaHasta) : null;
  if (data.cortesia === null) data.cortesiaHasta = null;

  const r = await prisma.usuario.update({ where: { id: u.id }, data, include: { ficha: true } });
  // Al rechazar una cuenta se la saca de cualquier dispositivo donde esté.
  if (d.estado === 'RECHAZADO') await revokeSessions(u.id);
  res.json({ usuario: resumen(r), planEfectivo: planEfectivo(r) });
}));

// Alta de un piloto desde el panel (por ejemplo, un alumno de las clases). Queda
// aprobado; al entrar por primera vez deberá aceptar los términos.
const NuevoPiloto = z.object({
  email: z.string().trim().toLowerCase().email('Correo no válido.').max(160),
  nombre: z.string().trim().min(2, 'Indica el nombre.').max(120),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200),
  plan: plan.optional().default('GRATIS'),
  deportes: z.array(deporteId).min(1, 'Elige al menos un deporte.'),
});

adminRouter.post('/usuarios', asyncHandler(async (req, res) => {
  const d = parse(NuevoPiloto, req.body);
  if (await prisma.usuario.findFirst({ where: { OR: [{ email: d.email }, { usuario: d.email }] } })) {
    throw conflict('Ya existe una cuenta con ese correo.');
  }
  const u = await prisma.usuario.create({
    data: {
      email: d.email, hash: await hashPassword(d.password), plan: d.plan, deportes: [...new Set(d.deportes)],
      estado: 'APROBADO', aprobado: new Date(),
      ficha: { create: { datos: fichaVacia({ nombre: d.nombre, correo: d.email }) } },
    },
    include: { ficha: true },
  });
  res.status(201).json({ usuario: resumen(u) });
}));

// Importación de pilotos desde CSV (el panel ya lo convirtió en filas). Cruza
// por correo: crea la cuenta (aprobada) o actualiza plan, deportes y datos
// básicos de la ficha. Si una cuenta nueva no trae contraseña se genera una y
// se devuelve para que el administrador se la entregue al piloto.
const FilaPiloto = z.object({
  email: z.string().trim().toLowerCase().email('Correo no válido.').max(160),
  nombre: z.string().trim().max(120).optional().default(''),
  password: z.union([z.literal(''), z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200)]).optional().default(''),
  plan: z.union([z.literal(''), plan]).optional().default(''),
  deportes: z.array(deporteId).optional().default([]),
  telefono: z.string().trim().max(60).optional().default(''),
  rut: z.string().trim().max(20).optional().default(''),
});
const ImportarPilotos = z.object({ filas: z.array(z.record(z.string(), z.unknown())).min(1, 'El archivo no tiene filas.').max(300, 'Máximo 300 pilotos por archivo.') });
const claveTemporal = () => crypto.randomBytes(9).toString('base64url').slice(0, 10);

adminRouter.post('/usuarios/importar', asyncHandler(async (req, res) => {
  const { filas } = parse(ImportarPilotos, req.body);
  const resultado = [];
  const vistos = new Set();
  for (let i = 0; i < filas.length; i += 1) {
    const nf = Number(filas[i]._fila) || i + 2;
    const r = FilaPiloto.safeParse(filas[i]);
    if (!r.success) { resultado.push({ fila: nf, email: String(filas[i].email || ''), accion: 'error', error: r.error.issues.map((x) => x.message).join(' ') }); continue; }
    const d = r.data;
    if (vistos.has(d.email)) { resultado.push({ fila: nf, email: d.email, accion: 'error', error: 'Correo repetido en el archivo.' }); continue; }
    vistos.add(d.email);
    const u = await prisma.usuario.findFirst({ where: { OR: [{ email: d.email }, { usuario: d.email }] }, include: { ficha: true } });
    if (u && u.rol !== 'PILOTO') { resultado.push({ fila: nf, email: d.email, accion: 'error', error: 'Ese correo es de un administrador.' }); continue; }
    if (u) {
      const perfil = { ...(u.ficha?.datos?.perfil || {}) };
      if (d.nombre) perfil.nombre = d.nombre;
      if (d.telefono) perfil.telefono = d.telefono;
      if (d.rut) perfil.rut = d.rut;
      await prisma.usuario.update({
        where: { id: u.id },
        data: { ...(d.plan ? { plan: d.plan } : {}), ...(d.deportes.length ? { deportes: [...new Set(d.deportes)] } : {}) },
      });
      const datos = { ...(u.ficha?.datos || fichaVacia()), perfil: limpiarPerfil(perfil) };
      await prisma.ficha.upsert({
        where: { usuarioId: u.id },
        update: { datos, version: (u.ficha?.version || 0) + 1 },
        create: { usuarioId: u.id, datos, version: 1 },
      });
      resultado.push({ fila: nf, email: d.email, accion: 'actualizado' });
      continue;
    }
    if (d.nombre.length < 2) { resultado.push({ fila: nf, email: d.email, accion: 'error', error: 'Falta el nombre del piloto nuevo.' }); continue; }
    const generada = d.password ? '' : claveTemporal();
    await prisma.usuario.create({
      data: {
        email: d.email, hash: await hashPassword(d.password || generada, 10), plan: d.plan || 'GRATIS',
        deportes: d.deportes.length ? [...new Set(d.deportes)] : ['moto'], estado: 'APROBADO', aprobado: new Date(),
        ficha: { create: { datos: fichaVacia(limpiarPerfil({ nombre: d.nombre, correo: d.email, telefono: d.telefono, rut: d.rut })) } },
      },
    });
    resultado.push({ fila: nf, email: d.email, nombre: d.nombre, accion: 'creado', ...(generada ? { password: generada } : {}) });
  }
  res.json({
    creados: resultado.filter((x) => x.accion === 'creado').length,
    actualizados: resultado.filter((x) => x.accion === 'actualizado').length,
    errores: resultado.filter((x) => x.accion === 'error').length,
    resultado,
  });
}));

const Perfil = z.object({ perfil: z.record(z.string(), z.unknown()) });

// Corrige la ficha personal del piloto. Sube la versión para que la app del
// piloto recargue antes de volver a guardar.
adminRouter.put('/usuarios/:id/perfil', asyncHandler(async (req, res) => {
  const { perfil } = parse(Perfil, req.body);
  const u = await buscar(req.params.id);
  const datos = { ...(u.ficha?.datos || fichaVacia()), perfil: limpiarPerfil(perfil) };
  await prisma.ficha.upsert({
    where: { usuarioId: u.id },
    update: { datos, version: (u.ficha?.version || 0) + 1 },
    create: { usuarioId: u.id, datos, version: 1 },
  });
  res.json({ ok: true });
}));

const Clave = z.object({ password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200) });

adminRouter.put('/usuarios/:id/password', asyncHandler(async (req, res) => {
  const { password } = parse(Clave, req.body);
  const u = await buscar(req.params.id);
  await prisma.usuario.update({ where: { id: u.id }, data: { hash: await hashPassword(password) } });
  await revokeSessions(u.id);
  res.json({ ok: true });
}));

const EditarSesion = z.object({ sesion: z.record(z.string(), z.unknown()) });

// Corrige una sesión del piloto (por ejemplo, un tiempo mal escrito). Conserva
// su id; el circuito se enlaza al catálogo si el nombre coincide con uno
// aprobado. Sube la versión para que la app del piloto recargue.
adminRouter.put('/usuarios/:id/sesiones/:sid', asyncHandler(async (req, res) => {
  const { sesion } = parse(EditarSesion, req.body);
  const u = await buscar(req.params.id);
  const ses = Array.isArray(u.ficha?.datos?.sesiones) ? u.ficha.datos.sesiones : [];
  const i = ses.findIndex((s) => s.id === req.params.sid);
  if (i < 0) throw notFound('Sesión no encontrada.');
  const s = limpiarSesion({ ...sesion, id: req.params.sid });
  if (!clave(s.circuito)) throw badRequest('Falta el circuito.');
  if (s.deporte && !esDeporte(s.deporte)) throw badRequest('Deporte no válido.');
  const c = await prisma.circuito.findFirst({ where: { clave: clave(s.circuito), estado: 'APROBADO' } });
  if (c) { s.circuitoId = c.id; s.circuito = c.nombre; } else delete s.circuitoId;
  ses[i] = s;
  await prisma.ficha.update({
    where: { usuarioId: u.id },
    data: { datos: { ...u.ficha.datos, sesiones: ses }, version: u.ficha.version + 1 },
  });
  res.json({ sesion: s });
}));

// Elimina una sesión del piloto (por ejemplo, un tiempo falso que distorsiona
// los rankings).
adminRouter.delete('/usuarios/:id/sesiones/:sid', asyncHandler(async (req, res) => {
  const u = await buscar(req.params.id);
  const ses = Array.isArray(u.ficha?.datos?.sesiones) ? u.ficha.datos.sesiones : [];
  const quedan = ses.filter((s) => s.id !== req.params.sid);
  if (quedan.length === ses.length) throw notFound('Sesión no encontrada.');
  await prisma.ficha.update({
    where: { usuarioId: u.id },
    data: { datos: { ...u.ficha.datos, sesiones: quedan }, version: u.ficha.version + 1 },
  });
  res.json({ ok: true });
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
  const deporte = esDeporte(req.query.deporte) ? req.query.deporte : '';
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
  deportes: z.array(deporteId).optional().default([]),
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
  deportes: z.array(deporteId).optional().default([]),
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

const Importar = z.object({ filas: z.array(z.record(z.string(), z.unknown())).min(1, 'El archivo no tiene filas.').max(1000, 'Máximo 1.000 filas por archivo.') });

// Importación desde CSV (el panel ya lo convirtió en filas). Cada fila se cruza
// por id o, si no trae, por nombre: actualiza el circuito aprobado que coincida
// o crea uno nuevo. Las filas con errores se informan y no se aplican.
adminRouter.post('/circuitos/importar', asyncHandler(async (req, res) => {
  const { filas } = parse(Importar, req.body);
  const lista = await prisma.circuito.findMany({ where: { estado: 'APROBADO' } });
  const porId = new Map(lista.map((c) => [c.id, c]));
  const porClave = new Map(lista.map((c) => [c.clave, c]));
  const vistas = new Set();
  const errores = [];
  const lote = [];
  const renombrados = [];
  let creados = 0;
  let actualizados = 0;
  for (let i = 0; i < filas.length; i += 1) {
    const r = Circuito.safeParse({ ...filas[i], vincular: [] });
    if (!r.success) { errores.push({ fila: Number(filas[i]._fila) || i + 2, error: r.error.issues.map((x) => x.message).join(' ') }); continue; }
    const d = r.data;
    const k = clave(d.nombre);
    if (vistas.has(k)) { errores.push({ fila: Number(filas[i]._fila) || i + 2, error: `«${d.nombre}» está repetido en el archivo.` }); continue; }
    vistas.add(k);
    const id = String(filas[i].id || '').trim();
    const previo = (id && porId.get(id)) || porClave.get(k);
    const otro = porClave.get(k);
    if (previo && otro && otro.id !== previo.id) { errores.push({ fila: Number(filas[i]._fila) || i + 2, error: `Ya existe otro circuito llamado «${otro.nombre}».` }); continue; }
    const c = previo
      ? await prisma.circuito.update({ where: { id: previo.id }, data: cDatos(d) })
      : await prisma.circuito.create({ data: { ...cDatos(d), estado: 'APROBADO' } });
    if (previo) { actualizados += 1; porClave.delete(previo.clave); if (previo.nombre !== c.nombre) renombrados.push(c); } else creados += 1;
    porId.set(c.id, c); porClave.set(c.clave, c);
    lote.push({ destino: c, nombres: [d.nombre] });
  }
  // Los renombrados se propagan a sus sesiones; los nombres escritos a mano se consolidan.
  for (const c of renombrados) await vincular({ ids: [c.id], destino: c });
  const vinculadas = await vincularLote(lote);
  res.json({ creados, actualizados, errores, vinculadas });
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
  nivel: z.number().int().min(1).max(30),
  titulo: z.string().trim().min(1, 'Falta el título.').max(160),
  descripcion: z.string().trim().max(1000).optional().default(''),
  sponsor: z.string().trim().max(120).optional().default(''),
  codigo: z.string().trim().max(500).optional().default(''),
  enlace: z.union([z.literal(''), z.string().trim().max(500)
    .regex(/^https?:\/\/[^\s]+$/i, 'El enlace debe ser una URL completa (https://…).')]).optional().default(''),
  activo: z.boolean().optional().default(true),
  orden: z.number().int().min(-9999).max(9999).optional().default(0),
});

/* Niveles y reglas de puntos */

const regla = z.number().min(0, 'Los puntos no pueden ser negativos.').max(100000);
const Premios = z.object({
  niveles: z.array(z.object({
    id: z.string().max(40).optional().default(''),
    nombre: z.string().trim().min(1, 'Cada nivel necesita un nombre.').max(40),
    puntos: z.number().int().min(0).max(10_000_000),
  })).min(2, 'Debe haber al menos 2 niveles.').max(30, 'Máximo 30 niveles.'),
  reglas: z.object({
    minuto: regla, record: regla, sesion: regla, vuelta: regla, circuito: regla, competencia: regla, ficha: regla,
  }),
});

adminRouter.get('/premios', asyncHandler(async (_req, res) => res.json(await leerPremios())));

// Guarda niveles y reglas. Los niveles se ordenan por puntos; las recompensas
// siguen a su nivel aunque cambie de posición, y las de un nivel eliminado
// pasan al nivel anterior que siga existiendo.
adminRouter.put('/premios', asyncHandler(async (req, res) => {
  const d = parse(Premios, req.body);
  const niveles = d.niveles
    .map((n) => ({ ...n, id: n.id || `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }))
    .sort((a, b) => a.puntos - b.puntos);
  if (niveles[0].puntos !== 0) throw badRequest('El primer nivel debe empezar en 0 puntos.');
  if (new Set(niveles.map((n) => n.puntos)).size !== niveles.length) throw badRequest('Dos niveles no pueden pedir los mismos puntos.');
  const antes = (await leerPremios()).niveles;
  const nuevoIdx = new Map(niveles.map((n, i) => [n.id, i + 1]));
  const destino = (nivelViejo) => {
    for (let i = Math.min(nivelViejo, antes.length) - 1; i >= 0; i -= 1) {
      const n = nuevoIdx.get(antes[i].id);
      if (n) return n;
    }
    return 1;
  };
  const rs = await prisma.recompensa.findMany({ select: { id: true, nivel: true } });
  for (const r of rs) {
    const n = Math.min(destino(r.nivel), niveles.length);
    if (n !== r.nivel) await prisma.recompensa.update({ where: { id: r.id }, data: { nivel: n } });
  }
  res.json(await guardarPremios({ niveles, reglas: d.reglas }));
}));

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

/* Deportes: nombre, tipo de vehículo, hashtag, ícono y estado */

const Deporte = z.object({
  id: z.string().trim().max(40).optional().default(''),
  nombre: z.string().trim().min(2, 'Cada deporte necesita un nombre.').max(60),
  vehiculo: z.enum(VEHICULOS, { message: 'Tipo de vehículo no válido.' }),
  hashtag: z.string().trim().transform((v) => v.replace(/^#/, ''))
    .pipe(z.string().regex(/^[\p{L}\p{N}_]{0,40}$/u, 'El hashtag solo admite letras, números y guion bajo.')).optional().default(''),
  icono: z.enum(ICONOS_DEP, { message: 'Ícono no válido.' }),
  activo: z.boolean().optional().default(true),
});
const Deportes = z.object({ deportes: z.array(Deporte).min(1).max(50) });
const slug = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'deporte';

adminRouter.get('/deportes', asyncHandler(async (_req, res) => {
  res.json({ deportes: deportes(), uso: await usoDeportes(), iconos: ICONOS_DEP });
}));

// Guarda la lista completa en el orden recibido. Un deporte en uso no se
// puede eliminar: se desactiva (deja de ofrecerse, pero sus datos siguen).
adminRouter.put('/deportes', asyncHandler(async (req, res) => {
  const d = parse(Deportes, req.body).deportes;
  const antes = deportes();
  const ids = new Set();
  const lista = d.map((x) => {
    let id = antes.some((a) => a.id === x.id) ? x.id : '';
    if (!id) {
      const base = slug(x.nombre);
      id = base;
      for (let i = 2; ids.has(id) || antes.some((a) => a.id === id); i += 1) id = `${base}-${i}`;
    }
    if (ids.has(id)) throw badRequest(`«${x.nombre}» está repetido.`);
    ids.add(id);
    return { ...x, id, hashtag: x.hashtag || x.nombre.replace(/[^\p{L}\p{N}]+/gu, '') };
  });
  if (new Set(lista.map((x) => x.nombre.toLowerCase())).size !== lista.length) throw badRequest('Dos deportes no pueden tener el mismo nombre.');
  if (!lista.some((x) => x.activo)) throw badRequest('Debe quedar al menos un deporte activo.');
  const quitados = antes.filter((a) => !ids.has(a.id));
  if (quitados.length) {
    const uso = await usoDeportes();
    const ocupado = quitados.find((q) => uso[q.id]);
    if (ocupado) {
      const u = uso[ocupado.id];
      throw conflict(`«${ocupado.nombre}» está en uso (${u.pilotos} pilotos, ${u.sesiones} sesiones, ${u.circuitos} circuitos, ${u.anuncios} anuncios). Desactívalo en lugar de eliminarlo.`);
    }
  }
  res.json({ deportes: await guardarDeportes(lista), uso: await usoDeportes(), iconos: ICONOS_DEP });
}));

// Vuelve a la lista original (solo si no se pierde ninguno en uso).
adminRouter.post('/deportes/restablecer', asyncHandler(async (_req, res) => {
  const uso = await usoDeportes();
  const faltan = deportes().filter((d) => !DEPORTES_DEF.some((x) => x.id === d.id) && uso[d.id]);
  if (faltan.length) throw conflict(`«${faltan[0].nombre}» está en uso y no forma parte de la lista original.`);
  res.json({ deportes: await guardarDeportes(DEPORTES_DEF), uso, iconos: ICONOS_DEP });
}));
