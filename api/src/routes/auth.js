import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db.js';
import { asyncHandler, badRequest, conflict, forbidden, parse, unauthorized } from '../lib/http.js';
import { rateLimit } from '../lib/rateLimit.js';
import { fichaVacia } from '../lib/ficha.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  COOKIE_NAME, cookieOptions, createSession, destroySession, requireAuth, revokeSessions, toPublicUser,
} from '../auth/session.js';

export const authRouter = Router();

const limiteCredenciales = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
});

const email = z.string().trim().toLowerCase().email('Correo no válido.').max(160);
const clave = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200);

const Registro = z.object({
  email,
  password: clave,
  nombre: z.string().trim().min(2, 'Indica tu nombre.').max(120),
  plan: z.enum(['GRATIS', 'PLUS', 'PRO']),
  consentimiento: z.object({
    terminos: z.literal(true, { message: 'Debes aceptar los términos.' }),
    salud: z.literal(true, { message: 'Debes autorizar el uso de los datos de emergencia.' }),
    mailing: z.boolean(),
    menor: z.boolean(),
    tutor: z.string().trim().max(120).optional().default(''),
    tutorRut: z.string().trim().max(20).optional().default(''),
    version: z.string().max(10),
  }),
});

const entrar = async (res, usuario) => {
  const token = await createSession(usuario.id);
  res.cookie(COOKIE_NAME, token, cookieOptions());
};

authRouter.post('/registro', limiteCredenciales, asyncHandler(async (req, res) => {
  const d = parse(Registro, req.body);
  if (d.consentimiento.menor && (!d.consentimiento.tutor || !d.consentimiento.tutorRut)) {
    throw badRequest('Indica nombre y RUT del apoderado.');
  }
  if (await prisma.usuario.findUnique({ where: { email: d.email } })) {
    throw conflict('Ya existe una cuenta con ese correo. Inicia sesión.');
  }
  const usuario = await prisma.usuario.create({
    data: {
      email: d.email,
      hash: await hashPassword(d.password),
      plan: d.plan,
      consentimiento: { ...d.consentimiento, fecha: new Date().toISOString().slice(0, 10) },
      ficha: { create: { datos: fichaVacia({ nombre: d.nombre, correo: d.email }) } },
    },
  });
  await entrar(res, usuario);
  res.status(201).json({ user: toPublicUser(usuario) });
}));

const Login = z.object({ email, password: z.string().min(1).max(200) });

authRouter.post('/login', limiteCredenciales, asyncHandler(async (req, res) => {
  const d = parse(Login, req.body);
  const usuario = await prisma.usuario.findUnique({ where: { email: d.email } });
  const ok = await verifyPassword(d.password, usuario?.hash);
  if (!usuario || !ok) throw unauthorized('Correo o contraseña incorrectos.');
  if (usuario.estado === 'RECHAZADO') {
    throw forbidden('Tu solicitud de acceso no fue aprobada. Escríbenos si crees que es un error.');
  }
  await entrar(res, usuario);
  res.json({ user: toPublicUser(usuario) });
}));

authRouter.post('/logout', asyncHandler(async (req, res) => {
  await destroySession(req.sessionToken);
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: toPublicUser(req.user) }));

const CambioClave = z.object({ actual: z.string().min(1).max(200), nueva: clave });

authRouter.put('/password', requireAuth, limiteCredenciales, asyncHandler(async (req, res) => {
  const d = parse(CambioClave, req.body);
  if (!(await verifyPassword(d.actual, req.user.hash))) throw badRequest('La contraseña actual no es correcta.');
  await prisma.usuario.update({ where: { id: req.user.id }, data: { hash: await hashPassword(d.nueva) } });
  // Cierra el resto de dispositivos: quien cambia la clave suele querer eso.
  await revokeSessions(req.user.id, req.sessionToken);
  res.json({ ok: true });
}));
