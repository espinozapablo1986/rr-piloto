// Limitador en memoria para los endpoints de credenciales. Basta para una sola
// instancia; si algún día se replica el contenedor habrá que moverlo a la base
// de datos.
const buckets = new Map();

export const rateLimit = ({ windowMs, max, message }) => (req, res, next) => {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }

  entry.count += 1;
  if (entry.count > max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: message, retryAfter });
  }
  next();
};

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) if (now > entry.resetAt) buckets.delete(key);
}, 10 * 60 * 1000).unref();
