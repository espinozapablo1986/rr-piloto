import { badRequest, forbidden } from './http.js';

// Campos de una entrada a pista que exigen el plan Plus. El plan Gratis solo
// registra tiempos: minutos, vueltas, mejor vuelta, clima y posición.
const TECNICOS = [
  'trazado', 'sentido', 'obsPista', 'motoId', 'pinon', 'corona', 'neum',
  'combustible', 'ajustes', 'sensaciones', 'nivel', 'mejorado', 'mejorar',
];

const MAX_TXT = 5000;
const MAX_IMG = 2_500_000;
const CLAVE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

export const fichaVacia = (perfil = {}) => ({ perfil, motos: [], sesiones: [], pistas: {}, foto: '' });

// Objeto plano de textos: descarta claves raras, anida nada y recorta largos.
const plano = (o, keep = []) => {
  const r = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return r;
  for (const [k, v] of Object.entries(o).slice(0, 80)) {
    if (!CLAVE.test(k) || keep.includes(k)) continue;
    if (typeof v === 'string') r[k] = v.slice(0, MAX_TXT);
    else if (typeof v === 'number' && Number.isFinite(v)) r[k] = String(v);
  }
  return r;
};

const imagen = (s) => (typeof s === 'string' && s.startsWith('data:image/') && s.length <= MAX_IMG ? s : '');
const nk = (c) => String(c || '').trim().toLowerCase();

// La foto de la moto es la única imagen dentro de una moto; el resto son textos.
const moto = (m) => {
  const r = plano(m, ['foto']);
  const foto = imagen(m?.foto);
  return foto ? { ...r, foto } : r;
};

const sesion = (s) => {
  const base = plano(s, ['entradas']);
  if (!base.id) throw badRequest('Cada sesión necesita un identificador.');
  const entradas = Array.isArray(s.entradas) ? s.entradas.slice(0, 50).map((e) => plano(e)) : [];
  return { ...base, entradas };
};

// La única pista del plan Gratis: la de la sesión más antigua registrada.
// La app calcula lo mismo para bloquear el campo del circuito.
export const pistaGratis = (sesiones) => {
  const s = [...sesiones].sort((a, b) =>
    String(a.fecha || '').localeCompare(String(b.fecha || '')) || String(a.id).localeCompare(String(b.id)))[0];
  return s ? nk(s.circuito) : null;
};

// Limpia el documento que manda la app y aplica las reglas del plan. Lo que el
// plan no permite tocar se conserva tal como estaba guardado, de modo que bajar
// de plan nunca borra datos: solo los congela.
export const sanear = (entrante, guardada, nivel) => {
  if (!entrante || typeof entrante !== 'object') throw badRequest('Ficha no válida.');
  const prev = { ...fichaVacia(), ...guardada };

  const datos = {
    perfil: plano(entrante.perfil),
    motos: Array.isArray(entrante.motos) ? entrante.motos.slice(0, 30).map(moto) : [],
    sesiones: Array.isArray(entrante.sesiones) ? entrante.sesiones.slice(0, 2000).map(sesion) : [],
    pistas: {},
    foto: imagen(entrante.foto),
  };
  if (entrante.pistas && typeof entrante.pistas === 'object') {
    for (const [k, v] of Object.entries(entrante.pistas).slice(0, 100)) {
      const img = imagen(v);
      if (img) datos.pistas[k.slice(0, 120)] = img;
    }
  }

  if (nivel >= 1) return datos;

  datos.motos = prev.motos;
  datos.pistas = prev.pistas;

  const antes = new Map(prev.sesiones.map((s) => [s.id, s]));
  const pista = pistaGratis(prev.sesiones) ?? pistaGratis(datos.sesiones);

  for (const s of datos.sesiones) {
    const old = antes.get(s.id);
    // Una sesión ya guardada en otra pista (de cuando tenía un plan de pago)
    // puede seguir editándose mientras no cambie de circuito.
    const mismaPista = old && nk(old.circuito) === nk(s.circuito);
    if (!mismaPista && nk(s.circuito) !== pista) {
      throw forbidden('El plan Gratis permite registrar una sola pista. Cambia de plan para agregar más.');
    }
    s.entradas = s.entradas.map((e, i) => {
      const o = old?.entradas?.[i] || {};
      const r = { ...e };
      for (const k of TECNICOS) {
        if (o[k] != null) r[k] = o[k];
        else delete r[k];
      }
      return r;
    });
  }
  return datos;
};
