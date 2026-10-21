// Envoltorio para manejadores asíncronos: cualquier promesa rechazada llega al
// middleware de errores en lugar de quedar como rechazo sin capturar.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Debes iniciar sesión.') => new HttpError(401, msg);
export const forbidden = (msg = 'No tienes permiso para esto.') => new HttpError(403, msg);
export const notFound = (msg = 'No encontrado.') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

// Valida un cuerpo con un esquema de zod y devuelve los datos ya limpios.
export const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('Datos no válidos.', r.error.issues.map((i) => i.message));
  return r.data;
};
