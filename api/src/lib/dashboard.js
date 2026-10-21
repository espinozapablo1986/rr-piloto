import { prisma } from './db.js';
import { cortesiaVigente, planEfectivo } from './planes.js';

// Indicadores del panel de administración. Se calculan al vuelo sobre las
// fichas: a la escala de la beta es más simple y siempre está al día.

const DIA = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const nk = (c) => String(c || '').trim().toLowerCase();

const toMs = (s) => {
  const m = String(s || '').trim().replace(',', '.').match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? Math.round(((+m[1] || 0) * 60 + parseFloat(m[2])) * 1000) : null;
};

const mes = (f) => String(f || '').slice(0, 7);
const ultimosMeses = (n) => {
  const r = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i -= 1) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    r.push(iso(x).slice(0, 7));
  }
  return r;
};

export const calcularDashboard = async ({ deporte, dias }) => {
  const ahora = Date.now();
  const desde = dias ? iso(new Date(ahora - dias * DIA)) : '';
  const d30 = iso(new Date(ahora - 30 * DIA));
  const d60 = iso(new Date(ahora - 60 * DIA));
  const meses = ultimosMeses(12);

  const [us, ads, contenido] = await Promise.all([
    prisma.usuario.findMany({ where: { rol: 'PILOTO' }, include: { ficha: true } }),
    prisma.anuncio.findMany({
      select: { id: true, sponsor: true, titulo: true, activo: true, impresiones: true, clics: true },
      orderBy: { impresiones: 'desc' },
    }),
    prisma.contenido.count({ where: { publicado: true } }),
  ]);

  const k = {
    pilotos: us.length, pendientes: 0, aprobados: 0, rechazados: 0,
    planes: { GRATIS: 0, PLUS: 0, PRO: 0 }, cortesias: 0, nuevos30: 0,
    activos30: 0, inactivos60: 0, sinSesiones: 0, mailing: 0, proConAnuncios: 0,
    sesiones: 0, entradas: 0, vueltas: 0, minutos: 0, conActividad: 0,
  };
  const porDeporte = {};
  const registros = Object.fromEntries(meses.map((m) => [m, 0]));
  const sesMes = Object.fromEntries(meses.map((m) => [m, 0]));
  const circ = new Map();
  const ranking = [];

  for (const u of us) {
    k[u.estado.toLowerCase() + 's'] += 1;
    if (registros[mes(iso(u.creado))] != null) registros[mes(iso(u.creado))] += 1;
    if (iso(u.creado) >= d30) k.nuevos30 += 1;
    const deps = u.deportes?.length ? u.deportes : ['moto'];
    for (const d of deps) {
      porDeporte[d] ??= { pilotos: 0, sesiones: 0 };
      porDeporte[d].pilotos += 1;
    }
    if (u.estado !== 'APROBADO') continue;

    const plan = planEfectivo(u);
    k.planes[plan] += 1;
    if (cortesiaVigente(u)) k.cortesias += 1;
    if (u.consentimiento?.mailing) k.mailing += 1;
    if (plan === 'PRO' && u.anunciosPro) k.proConAnuncios += 1;

    const datos = u.ficha?.datos || {};
    const perfil = datos.perfil || {};
    const nombre = perfil.nombre || u.email;
    const motos = new Map((datos.motos || []).map((m) => [m.id, m]));
    const todas = (datos.sesiones || []).filter((s) => {
      const dd = s.deporte || 'moto';
      porDeporte[dd] ??= { pilotos: 0, sesiones: 0 };
      porDeporte[dd].sesiones += 1;
      return !deporte || dd === deporte;
    });
    for (const s of todas) if (sesMes[mes(s.fecha)] != null) sesMes[mes(s.fecha)] += 1;

    const ultima = todas.reduce((m, s) => (String(s.fecha || '') > m ? String(s.fecha) : m), '');
    if (!todas.length) k.sinSesiones += 1;
    else if (ultima >= d30) k.activos30 += 1;
    else if (ultima < d60) k.inactivos60 += 1;

    const r = {
      id: u.id, nombre, email: u.email, telefono: perfil.telefono || '', plan,
      mailing: Boolean(u.consentimiento?.mailing), deportes: deps,
      sesiones: 0, entradas: 0, vueltas: 0, minutos: 0, ultima, circuitos: {},
    };
    for (const s of todas) {
      if (desde && String(s.fecha || '') < desde) continue;
      const key = nk(s.circuito);
      if (!key) continue;
      r.sesiones += 1;
      let c = circ.get(key);
      if (!c) {
        c = { nombres: {}, sesiones: 0, minutos: 0, pilotos: new Set(), mejores: new Map(), trazados: new Map() };
        circ.set(key, c);
      }
      c.nombres[s.circuito] = (c.nombres[s.circuito] || 0) + 1;
      c.sesiones += 1;
      c.pilotos.add(u.id);
      for (const e of s.entradas || []) {
        const min = +e.minutos || 0;
        const vu = +e.vueltas || 0;
        r.entradas += 1; r.minutos += min; r.vueltas += vu;
        r.circuitos[s.circuito] = (r.circuitos[s.circuito] || 0) + min;
        c.minutos += min;
        const ms = toMs(e.mejor);
        if (!ms) continue;
        const veh = motos.get(e.motoId);
        const marca = { ms, piloto: nombre, id: u.id, fecha: s.fecha || '', trazado: e.trazado || '',
          vehiculo: veh ? (veh.apodo || `${veh.marca || ''} ${veh.modelo || ''}`.trim()) : '' };
        const prev = c.mejores.get(u.id);
        if (!prev || ms < prev.ms) c.mejores.set(u.id, marca);
        const tz = nk(e.trazado) || '—';
        const pt = c.trazados.get(tz);
        if (!pt || ms < pt.ms) c.trazados.set(tz, { ...marca, trazado: e.trazado || 'Sin especificar' });
      }
    }
    k.sesiones += r.sesiones; k.entradas += r.entradas; k.vueltas += r.vueltas; k.minutos += r.minutos;
    if (r.sesiones) k.conActividad += 1;
    r.circuitos = Object.entries(r.circuitos).sort((a, b) => b[1] - a[1]).map(([n, m]) => ({ n, m }));
    ranking.push(r);
  }

  const circuitos = [...circ.values()].map((c) => {
    const nombre = Object.entries(c.nombres).sort((a, b) => b[1] - a[1])[0][0];
    const top = [...c.mejores.values()].sort((a, b) => a.ms - b.ms).slice(0, 10);
    return {
      nombre, sesiones: c.sesiones, minutos: c.minutos, pilotos: c.pilotos.size,
      top, trazados: [...c.trazados.values()].sort((a, b) => a.ms - b.ms),
    };
  }).sort((a, b) => b.sesiones - a.sesiones);

  ranking.sort((a, b) => b.minutos - a.minutos || b.sesiones - a.sesiones);
  const impresiones = ads.reduce((t, a) => t + a.impresiones, 0);
  const clics = ads.reduce((t, a) => t + a.clics, 0);

  return {
    filtro: { deporte: deporte || '', dias: dias || 0, desde },
    kpis: { ...k, circuitos: circuitos.length, contenido },
    porDeporte,
    series: {
      registros: meses.map((m) => ({ m, n: registros[m] })),
      sesiones: meses.map((m) => ({ m, n: sesMes[m] })),
    },
    ranking,
    circuitos,
    anuncios: { total: ads.length, activos: ads.filter((a) => a.activo).length, impresiones, clics, top: ads.slice(0, 5) },
  };
};
