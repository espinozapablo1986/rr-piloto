// Planes simulados de la beta. El nivel ordena los planes: cada uno incluye
// todo lo del anterior.
export const NIVEL = { GRATIS: 0, PLUS: 1, PRO: 2 };

const hoy = () => new Date().toISOString().slice(0, 10);

export const cortesiaVigente = (u) =>
  Boolean(u.cortesia) && (!u.cortesiaHasta || u.cortesiaHasta.toISOString().slice(0, 10) >= hoy());

// El plan que de verdad rige: el mayor entre el elegido y la cortesía vigente.
export const planEfectivo = (u) => {
  if (cortesiaVigente(u) && NIVEL[u.cortesia] > NIVEL[u.plan]) return u.cortesia;
  return u.plan;
};

export const nivel = (u) => NIVEL[planEfectivo(u)];

// Ids válidos de deporte (deben coincidir con DEPORTES en web/campos.js).
export const DEPORTES = ['moto', 'mx', 'enduro', 'supermoto', 'karting', 'auto'];

// Gratis y Plus ven publicidad; Pro solo si la activó.
export const veAnuncios = (u) => nivel(u) < 2 || u.anunciosPro;
