import express from 'express';
import cookieParser from 'cookie-parser';

import { env } from './lib/env.js';
import { prisma } from './lib/db.js';
import { HttpError } from './lib/http.js';
import { hashPassword } from './auth/password.js';
import { loadUser, purgeExpiredSessions } from './auth/session.js';
import { authRouter } from './routes/auth.js';
import { pilotoRouter } from './routes/piloto.js';
import { adminRouter } from './routes/admin.js';
import { cargarDeportes, deportes } from './lib/deportes.js';

const app = express();

// El Proxy Manager y el nginx del stack terminan la conexión. Sin esto `req.ip`
// sería la del proxy y el limitador trataría a todos como uno solo.
app.set('trust proxy', true);
app.disable('x-powered-by');

// La ficha viaja entera, con la foto y las imágenes de pistas en Base64.
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Las escrituras solo se aceptan como JSON: un formulario de otro sitio no
// puede enviarlo sin permiso CORS, lo que cierra la puerta a CSRF.
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Se esperaba JSON.' });
  }
  next();
});
app.use(loadUser);

app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'base de datos no disponible' });
  }
});

// Fotos de circuitos: públicas y con caché larga (cada foto nueva tiene otro id).
app.get('/api/img/circuito/:id', async (req, res, next) => {
  try {
    const i = await prisma.circuitoImagen.findUnique({ where: { id: req.params.id }, select: { datos: true, tipo: true } });
    if (!i) return res.status(404).end();
    res.set('Content-Type', i.tipo);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(i.datos));
  } catch (e) { next(e); }
});

// Lista pública de deportes: la necesitan el registro y la app antes de entrar.
app.get('/api/deportes', (_req, res) => res.json({ deportes: deportes() }));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', pilotoRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Los datos son demasiado pesados. Prueba con imágenes más livianas.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON no válido.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// Crea el administrador inicial la primera vez. Si la cuenta ya existe no se
// toca: su contraseña pudo cambiarse desde la app.
const crearAdmin = async () => {
  if (!env.adminEmail || !env.adminPassword) return;
  const ya = await prisma.usuario.findUnique({ where: { email: env.adminEmail } });
  if (ya) return;
  await prisma.usuario.create({
    data: {
      email: env.adminEmail,
      hash: await hashPassword(env.adminPassword),
      rol: 'ADMIN',
      estado: 'APROBADO',
      aprobado: new Date(),
    },
  });
  console.log(`[rr-piloto-api] administrador inicial creado: ${env.adminEmail}`);
};

const server = app.listen(env.port, () => {
  console.log(`[rr-piloto-api] escuchando en :${env.port} · origen ${env.appUrl}`);
});

cargarDeportes().catch((e) => console.error('[rr-piloto-api] no se pudieron cargar los deportes', e));
crearAdmin().catch((e) => console.error('[rr-piloto-api] no se pudo crear el administrador', e));
purgeExpiredSessions().catch(() => {});
setInterval(() => purgeExpiredSessions().catch(() => {}), 6 * 3600 * 1000).unref();

const shutdown = async (signal) => {
  console.log(`[rr-piloto-api] ${signal} recibido, cerrando`);
  server.close();
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
