import bcrypt from 'bcryptjs';

const ROUNDS = 12;
// Hash de relleno: si el correo no existe se compara igual contra él, para que
// el tiempo de respuesta no delate qué correos están registrados.
const DUMMY = bcrypt.hashSync('sin-cuenta', ROUNDS);

// `rondas` menor solo para importaciones masivas de claves temporales: con 12
// rondas, cientos de cuentas tardarían minutos.
export const hashPassword = (plain, rondas = ROUNDS) => bcrypt.hash(plain, rondas);

export const verifyPassword = async (plain, hash) => {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY);
    return false;
  }
  return bcrypt.compare(plain, hash);
};
