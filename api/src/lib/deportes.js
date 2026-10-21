import { z } from 'zod';
import { prisma } from './db.js';

// Deportes de la plataforma, editables en el panel (Ajuste «deportes»). El id
// no cambia nunca: lo guardan las cuentas, las sesiones, los circuitos y los
// anuncios. El tipo de vehículo define el nombre de la pestaña (Moto, Kart…).
export const VEHICULOS = ['moto', 'kart', 'auto', 'otro'];
// Íconos que se pueden elegir (deben existir en web/iconos.js).
export const ICONOS_DEP = ['moto', 'mx', 'enduro', 'casco', 'kart', 'auto', 'cuatri', 'bote', 'velocimetro', 'camion', 'sesiones', 'trofeo', 'llama', 'estrella', 'mapa'];

export const DEPORTES_DEF = [
  { id: 'moto', nombre: 'Motociclismo de pista', vehiculo: 'moto', hashtag: 'Motociclismo', icono: 'moto', activo: true },
  { id: 'mx', nombre: 'Motocross', vehiculo: 'moto', hashtag: 'Motocross', icono: 'mx', activo: true },
  { id: 'enduro', nombre: 'Enduro', vehiculo: 'moto', hashtag: 'Enduro', icono: 'enduro', activo: true },
  { id: 'supermoto', nombre: 'Supermoto', vehiculo: 'moto', hashtag: 'Supermoto', icono: 'casco', activo: true },
  { id: 'karting', nombre: 'Karting', vehiculo: 'kart', hashtag: 'Karting', icono: 'kart', activo: true },
  { id: 'auto', nombre: 'Automovilismo', vehiculo: 'auto', hashtag: 'Automovilismo', icono: 'auto', activo: true },
];

let lista = DEPORTES_DEF;

export const deportes = () => lista;
export const esDeporte = (id) => lista.some((d) => d.id === id);

export const cargarDeportes = async () => {
  const a = await prisma.ajuste.findUnique({ where: { clave: 'deportes' } });
  if (a && Array.isArray(a.valor) && a.valor.length) lista = a.valor;
  return lista;
};

export const guardarDeportes = async (valor) => {
  await prisma.ajuste.upsert({ where: { clave: 'deportes' }, update: { valor }, create: { clave: 'deportes', valor } });
  lista = valor;
  return valor;
};

// Validación contra la lista vigente (puede cambiar sin reiniciar la API).
export const deporteId = z.string().refine((v) => esDeporte(v), { message: 'Deporte no válido.' });

// Cuántos pilotos, sesiones, circuitos y anuncios usan cada deporte.
export const usoDeportes = async () => {
  const [us, fichas, cs, ads] = await Promise.all([
    prisma.usuario.findMany({ where: { rol: 'PILOTO' }, select: { deportes: true } }),
    prisma.ficha.findMany({ select: { datos: true } }),
    prisma.circuito.findMany({ select: { deportes: true } }),
    prisma.anuncio.findMany({ select: { deportes: true } }),
  ]);
  const uso = {};
  const sumar = (id, k) => { uso[id] ??= { pilotos: 0, sesiones: 0, circuitos: 0, anuncios: 0 }; uso[id][k] += 1; };
  // Las cuentas sin deportes son de antes del multideporte: motociclismo de pista.
  for (const u of us) for (const d of (u.deportes.length ? u.deportes : ['moto'])) sumar(d, 'pilotos');
  for (const f of fichas) for (const s of f.datos?.sesiones || []) sumar(s.deporte || 'moto', 'sesiones');
  for (const c of cs) for (const d of c.deportes) sumar(d, 'circuitos');
  for (const a of ads) for (const d of a.deportes) sumar(d, 'anuncios');
  return uso;
};
