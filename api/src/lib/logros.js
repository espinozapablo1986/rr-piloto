import { prisma } from './db.js';

// Progreso del piloto para medallas, copas y niveles. Los niveles y las reglas
// de puntos se editan en el panel (Ajuste «premios»); la app calcula lo mismo
// con la configuración que le entrega GET /api/premios.

// Configuración inicial: la que regía antes de poder editarla.
export const PREMIOS_DEF = {
  niveles: [
    { id: 'n1', nombre: 'Novato', puntos: 0 },
    { id: 'n2', nombre: 'Aprendiz', puntos: 120 },
    { id: 'n3', nombre: 'Piloto', puntos: 400 },
    { id: 'n4', nombre: 'Competidor', puntos: 900 },
    { id: 'n5', nombre: 'Experto', puntos: 1800 },
    { id: 'n6', nombre: 'Élite', puntos: 3500 },
    { id: 'n7', nombre: 'Leyenda', puntos: 6000 },
  ],
  // Puntos por cada: minuto en pista, récord personal, sesión registrada,
  // vuelta, circuito nuevo, competencia (clasificación, carrera o campeonato)
  // y, una sola vez, por tener la ficha de emergencia completa.
  reglas: { minuto: 1, record: 30, sesion: 0, vuelta: 0, circuito: 0, competencia: 0, ficha: 0 },
};

let cache = null;

export const leerPremios = async () => {
  if (cache) return cache;
  const a = await prisma.ajuste.findUnique({ where: { clave: 'premios' } });
  cache = a ? { ...PREMIOS_DEF, ...a.valor, reglas: { ...PREMIOS_DEF.reglas, ...a.valor.reglas } } : PREMIOS_DEF;
  return cache;
};

export const guardarPremios = async (valor) => {
  await prisma.ajuste.upsert({ where: { clave: 'premios' }, update: { valor }, create: { clave: 'premios', valor } });
  cache = valor;
  return valor;
};

const toMs = (s) => {
  const m = String(s || '').trim().replace(',', '.').match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? Math.round(((+m[1] || 0) * 60 + parseFloat(m[2])) * 1000) : null;
};
const nk = (c) => String(c || '').trim().toLowerCase();
const COMPETENCIA = /Clasificación|Carrera|Campeonato/;
// Campos que cuentan para la ficha de emergencia completa (igual que pct() en la app).
const FICHA = ['nombre', 'rut', 'telefono', 'correo', 'emNombre', 'emTel', 'prevision'];

export const progreso = (datos, cfg = PREMIOS_DEF) => {
  const r = cfg.reglas;
  const ses = [...(datos?.sesiones || [])].sort((a, b) =>
    String(a.fecha || '').localeCompare(String(b.fecha || '')) || String(a.id).localeCompare(String(b.id)));
  const mejor = {};
  let minutos = 0;
  let vueltas = 0;
  let records = 0;
  let competencias = 0;
  const circuitos = new Set();
  for (const s of ses) {
    let b = null;
    for (const e of s.entradas || []) {
      minutos += +e.minutos || 0;
      vueltas += +e.vueltas || 0;
      const ms = toMs(e.mejor);
      if (ms && (b == null || ms < b)) b = ms;
    }
    const k = `${s.deporte || 'moto'}|${nk(s.circuito)}`;
    if (nk(s.circuito)) circuitos.add(k);
    if (COMPETENCIA.test(s.tipo || '')) competencias += 1;
    if (b && nk(s.circuito)) {
      if (mejor[k] != null && b < mejor[k]) records += 1;
      if (mejor[k] == null || b < mejor[k]) mejor[k] = b;
    }
  }
  const p = datos?.perfil || {};
  const ficha = FICHA.every((f) => p[f]);
  minutos = Math.round(minutos);
  const puntos = Math.round(minutos * r.minuto + records * r.record + ses.length * r.sesion + vueltas * r.vuelta
    + circuitos.size * r.circuito + competencias * r.competencia + (ficha ? r.ficha : 0));
  let nivel = 1;
  cfg.niveles.forEach((n, i) => { if (puntos >= n.puntos) nivel = i + 1; });
  return { minutos, records, puntos, nivel, sesiones: ses.length, vueltas, circuitos: circuitos.size, competencias, ficha };
};
