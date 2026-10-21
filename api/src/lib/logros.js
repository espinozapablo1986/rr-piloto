// Progreso del piloto para medallas, copas y niveles. Debe calcular lo mismo
// que la app (PREMIOS en web/campos.js): 1 punto por minuto en pista y 30 por
// cada récord personal roto.
export const NIVELES = [0, 120, 400, 900, 1800, 3500, 6000];
const PUNTOS_RECORD = 30;

const toMs = (s) => {
  const m = String(s || '').trim().replace(',', '.').match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? Math.round(((+m[1] || 0) * 60 + parseFloat(m[2])) * 1000) : null;
};
const nk = (c) => String(c || '').trim().toLowerCase();

export const progreso = (datos) => {
  const ses = [...(datos?.sesiones || [])].sort((a, b) =>
    String(a.fecha || '').localeCompare(String(b.fecha || '')) || String(a.id).localeCompare(String(b.id)));
  const mejor = {};
  let minutos = 0;
  let records = 0;
  for (const s of ses) {
    let b = null;
    for (const e of s.entradas || []) {
      minutos += +e.minutos || 0;
      const ms = toMs(e.mejor);
      if (ms && (b == null || ms < b)) b = ms;
    }
    const k = `${s.deporte || 'moto'}|${nk(s.circuito)}`;
    if (b && nk(s.circuito)) {
      if (mejor[k] != null && b < mejor[k]) records += 1;
      if (mejor[k] == null || b < mejor[k]) mejor[k] = b;
    }
  }
  const puntos = Math.round(minutos) + records * PUNTOS_RECORD;
  let nivel = 1;
  NIVELES.forEach((u, i) => { if (puntos >= u) nivel = i + 1; });
  return { minutos: Math.round(minutos), records, puntos, nivel };
};
