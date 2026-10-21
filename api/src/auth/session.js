import crypto from 'node:crypto';
import { prisma } from '../lib/db.js';
import { env, isHttps } from '../lib/env.js';
import { forbidden, unauthorized } from '../lib/http.js';
import { cortesiaVigente, planEfectivo } from '../lib/planes.js';

export const COOKIE_NAME = 'rr_sesion';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const createSession = async (usuarioId) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const expira = new Date(Date.now() + env.sessionMaxAgeHours * 3600 * 1000);
  await prisma.acceso.create({ data: { tokenHash: hashToken(token), usuarioId, expira } });
  return token;
};

export const cookieOptions = () => ({
  httpOnly: true,
  // `secure` solo con HTTPS real: en desarrollo por http el navegador
  // descartaría la cookie y el login parecería no funcionar.
  secure: isHttps,
  sameSite: 'lax',
  path: '/',
  maxAge: env.sessionMaxAgeHours * 3600 * 1000,
});

export const destroySession = async (token) => {
  if (!token) return;
  await prisma.acceso.deleteMany({ where: { tokenHash: hashToken(token) } });
};

export const revokeSessions = (usuarioId, keepToken) =>
  prisma.acceso.deleteMany({
    where: { usuarioId, ...(keepToken ? { NOT: { tokenHash: hashToken(keepToken) } } : {}) },
  });

export const purgeExpiredSessions = () =>
  prisma.acceso.deleteMany({ where: { expira: { lt: new Date() } } });

export const toPublicUser = (u) => ({
  id: u.id,
  email: u.email,
  usuario: u.usuario,
  nombre: u.nombre,
  rol: u.rol,
  estado: u.estado,
  plan: u.plan,
  cortesia: cortesiaVigente(u) ? u.cortesia : null,
  cortesiaHasta: cortesiaVigente(u) && u.cortesiaHasta ? u.cortesiaHasta.toISOString().slice(0, 10) : null,
  planEfectivo: planEfectivo(u),
  // Las cuentas anteriores al multideporte eran de motociclismo de pista.
  deportes: u.deportes?.length ? u.deportes : ['moto'],
  anunciosPro: u.anunciosPro,
  consentimiento: u.consentimiento,
});

// Resuelve la sesión de la petición sin exigirla.
export const loadUser = async (req, _res, next) => {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    req.sessionToken = token || null;
    req.user = null;
    if (token) {
      const a = await prisma.acceso.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { usuario: true },
      });
      if (a && a.expira > new Date()) req.user = a.usuario;
      else if (a) await prisma.acceso.delete({ where: { id: a.id } }).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  next();
};

// Las cuentas en espera pueden entrar y ver su estado, pero no registrar nada.
export const requireAprobado = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.estado !== 'APROBADO') return next(forbidden('Tu cuenta aún no ha sido aprobada.'));
  next();
};

export const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.rol !== 'ADMIN') return next(forbidden('Necesitas permisos de administrador.'));
  next();
};
