import bcrypt from 'bcryptjs';

const ROUNDS = 12;
// Hash de relleno: si el correo no existe se compara igual contra él, para que
// el tiempo de respuesta no delate qué correos están registrados.
const DUMMY = bcrypt.hashSync('sin-cuenta', ROUNDS);

export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);

export const verifyPassword = async (plain, hash) => {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY);
    return false;
  }
  return bcrypt.compare(plain, hash);
};
