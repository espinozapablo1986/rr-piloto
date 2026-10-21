import { prisma } from './db.js';

// Clave de comparación de nombres de circuito: «Autódromo Codegua » y
// «autódromo codegua» son el mismo.
export const clave = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Fotos sin el binario, ordenadas con la principal primero.
export const conImagenes = { imagenes: { select: { id: true, principal: true, orden: true }, orderBy: [{ principal: 'desc' }, { orden: 'asc' }, { creado: 'asc' }] } };
const img = (i) => ({ id: i.id, principal: i.principal, url: `/api/img/circuito/${i.id}` });

const publico = (c) => ({
  id: c.id, nombre: c.nombre, ciudad: c.ciudad, region: c.region, pais: c.pais,
  deportes: c.deportes, trazados: c.trazados, longitud: c.longitud, estado: c.estado,
  imagenes: (c.imagenes || []).map(img),
});
export const circuitoPublico = publico;

// Consolida en `destino` las sesiones de todas las fichas que apunten a alguno
// de los circuitos `ids` o que tengan escrito a mano alguno de los `nombres`
// (sin circuito asignado). Devuelve cuántas sesiones cambió.
export const vincular = async ({ ids = [], nombres = [], destino }) => {
  const claves = new Set(nombres.map(clave));
  const fichas = await prisma.ficha.findMany({ select: { usuarioId: true, datos: true, version: true } });
  let n = 0;
  for (const f of fichas) {
    const ses = Array.isArray(f.datos?.sesiones) ? f.datos.sesiones : [];
    let cambio = false;
    for (const s of ses) {
      const porId = s.circuitoId && ids.includes(s.circuitoId);
      const porNombre = !s.circuitoId && claves.has(clave(s.circuito));
      if (!porId && !porNombre) continue;
      if (destino) { s.circuitoId = destino.id; s.circuito = destino.nombre; } else delete s.circuitoId;
      cambio = true; n += 1;
    }
    // Sube la versión: si el piloto tiene la app abierta, recargará la ficha
    // antes de volver a guardar en lugar de pisar el cambio.
    if (cambio) {
      await prisma.ficha.update({ where: { usuarioId: f.usuarioId }, data: { datos: { ...f.datos, sesiones: ses }, version: f.version + 1 } });
    }
  }
  return n;
};

// Igual que vincular, pero para muchos circuitos en una sola pasada por las
// fichas (importación masiva). `lote` es una lista de { destino, nombres }.
export const vincularLote = async (lote) => {
  const porClave = new Map();
  for (const { destino, nombres } of lote) for (const n of nombres) porClave.set(clave(n), destino);
  if (!porClave.size) return 0;
  const fichas = await prisma.ficha.findMany({ select: { usuarioId: true, datos: true, version: true } });
  let n = 0;
  for (const f of fichas) {
    const ses = Array.isArray(f.datos?.sesiones) ? f.datos.sesiones : [];
    let cambio = false;
    for (const s of ses) {
      if (s.circuitoId) continue;
      const d = porClave.get(clave(s.circuito));
      if (!d) continue;
      s.circuitoId = d.id; s.circuito = d.nombre; cambio = true; n += 1;
    }
    if (cambio) {
      await prisma.ficha.update({ where: { usuarioId: f.usuarioId }, data: { datos: { ...f.datos, sesiones: ses }, version: f.version + 1 } });
    }
  }
  return n;
};

// Uso de cada circuito y nombres escritos a mano que aún no están en el catálogo.
export const usoCircuitos = async () => {
  const fichas = await prisma.ficha.findMany({ select: { datos: true } });
  const porId = {};
  const sueltos = new Map();
  for (const f of fichas) {
    for (const s of f.datos?.sesiones || []) {
      if (s.circuitoId) porId[s.circuitoId] = (porId[s.circuitoId] || 0) + 1;
      else if (clave(s.circuito)) {
        const k = clave(s.circuito);
        const x = sueltos.get(k) || { clave: k, nombre: s.circuito, sesiones: 0 };
        x.sesiones += 1;
        sueltos.set(k, x);
      }
    }
  }
  return { porId, sueltos: [...sueltos.values()].sort((a, b) => b.sesiones - a.sesiones) };
};
