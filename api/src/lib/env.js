// Configuración leída del entorno. Se valida al arrancar para fallar de
// inmediato y no a mitad de una petición.

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
};

export const env = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  appUrl: (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  sessionMaxAgeHours: Number(process.env.SESSION_MAX_AGE_HOURS || 720), // 30 días

  // Administrador inicial. Se crea al arrancar si aún no existe una cuenta con
  // ese correo; si ya existe no se toca, para no pisar una contraseña cambiada
  // desde la app.
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',
};

export const isHttps = env.appUrl.startsWith('https://');
