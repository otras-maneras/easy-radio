import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const password = randomBytes(12).toString('hex');
const content = [
  'HOST=127.0.0.1', 'PORT=4173', `ADMIN_PASSWORD=${password}`,
  `SESSION_SECRET=${randomBytes(32).toString('hex')}`,
  `ICECAST_PASSWORD=${randomBytes(24).toString('hex')}`,
  `ICECAST_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}`,
  'DATA_DIR=./data', 'LIQUIDSOAP_HOST=127.0.0.1', 'LIQUIDSOAP_PORT=1234',
  'ICECAST_URL=http://127.0.0.1:8000', '# PUBLIC_ORIGIN=https://radio.example.com', ''
].join('\n');
try {
  await writeFile('.env', content, { flag: 'wx', mode: 0o600 });
  console.log('Archivo .env creado con contraseñas aleatorias. Consulta ADMIN_PASSWORD en ese archivo para entrar.');
} catch (error) { if (error.code === 'EEXIST') console.log('.env ya existe. No se ha modificado.'); else throw error; }
