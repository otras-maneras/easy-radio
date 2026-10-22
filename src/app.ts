import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';

const execFileAsync = promisify(execFile);
type Track = { id: string; title: string; artist: string; filename: string; duration: number; bytes: number; position: number; added: string };
type Options = { dataDir?: string; password?: string; secret?: string; logger?: boolean };

function liquidsoapCommand(command: string) {
  return new Promise<string>((resolveResult, reject) => {
    const socket = createConnection({ host: process.env.LIQUIDSOAP_HOST ?? '127.0.0.1', port: Number(process.env.LIQUIDSOAP_PORT ?? 1234) });
    let output = '';
    socket.setTimeout(3000);
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', data => {
      output += data.toString();
      if (output.includes('END')) {
        socket.destroy();
        if (/ERROR|unknown command/i.test(output)) reject(new Error(output));
        else resolveResult(output);
      }
    });
    socket.on('error', reject);
    socket.on('timeout', () => socket.destroy(new Error('timeout')));
    socket.on('end', () => {
      if (!output.includes('END')) reject(new Error('Liquidsoap closed the connection without a complete reply.'));
    });
  });
}

export async function buildApp(options: Options = {}) {
  const password = options.password ?? process.env.ADMIN_PASSWORD ?? '';
  const secret = options.secret ?? process.env.SESSION_SECRET ?? '';
  if (password.length < 12 || secret.length < 32) throw new Error('Configura ADMIN_PASSWORD (12+ caracteres) y SESSION_SECRET (32+) en .env.');
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const musicDir = join(dataDir, 'music');
  await mkdir(musicDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'radio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, filename TEXT NOT NULL, duration REAL NOT NULL, bytes INTEGER NOT NULL, position INTEGER NOT NULL, added TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('shuffle', 'false');`);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 64 * 1024 });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  const tracks = () => db.prepare('SELECT * FROM tracks ORDER BY position, added').all() as Track[];
  const shuffle = () => db.prepare("SELECT value FROM settings WHERE key='shuffle'").get()?.value === 'true';
  let playlistWrite = Promise.resolve();
  function syncPlaylist() {
    // Serialize writes so concurrent uploads cannot restore an older playlist.
    playlistWrite = playlistWrite.catch(() => {}).then(async () => {
      const list = tracks();
      if (shuffle()) for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      const playlist = list.map(t => join(musicDir, t.filename)).join('\n') + '\n';
      await writeFile(join(dataDir, 'playlist.m3u.tmp'), playlist);
      await rename(join(dataDir, 'playlist.m3u.tmp'), join(dataDir, 'playlist.m3u'));
      // Reload explicitly after the atomic replacement. Inode-based watches stop
      // seeing future replacements; timed reloads would reset playlist order.
      // Saving the library also works when the optional engine is offline.
      await liquidsoapCommand('library.reload').catch(() => {});
    });
    return playlistWrite;
  }
  await syncPlaylist();
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex');
  const equal = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  function authenticated(cookie = '') {
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    if (!token) return false;
    const [expires, nonce, signature] = token.split('.');
    return Boolean(expires && nonce && signature && Number(expires) > Date.now() && equal(signature, sign(`${expires}.${nonce}`)));
  }
  const originFor = (host?: string) => process.env.PUBLIC_ORIGIN ?? `http://${host}`;
  app.addHook('onRequest', async (request, reply) => {
    // Authorize the matched route, not the raw URL. Fastify decodes static path
    // segments, so /%61pi/tracks reaches /api/tracks as well.
    const path = request.routeOptions.url ?? request.url.split('?')[0];
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (path.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.headers.origin !== originFor(request.headers.host)) {
      return reply.code(403).send({ error: 'Origen no permitido.' });
    }
    const publicPaths = ['/api/login', '/api/session', '/api/status', '/api/health'];
    if (path.startsWith('/api/') && !publicPaths.includes(path) && !authenticated(request.headers.cookie)) {
      return reply.code(401).send({ error: 'Inicia sesión para administrar la radio.' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const detail = error as { statusCode?: number; message?: string };
    const code = detail.statusCode && detail.statusCode >= 400 && detail.statusCode < 500 ? detail.statusCode : 500;
    reply.code(code).send({ error: code === 500 ? 'No se pudo completar la operación.' : detail.message });
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async request => ({ authenticated: authenticated(request.headers.cookie) }));
  app.post<{ Body: { password?: string } }>('/api/login', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (typeof request.body?.password !== 'string' || !equal(request.body.password, password)) return reply.code(401).send({ error: 'La contraseña no es correcta.' });
    const payload = `${Date.now() + 12 * 3600_000}.${randomUUID()}`;
    const secure = originFor(request.headers.host).startsWith('https:') ? '; Secure' : '';
    reply.header('Set-Cookie', `session=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
    return { ok: true };
  });
  app.post('/api/logout', async (_request, reply) => {
    reply.header('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });
  app.get('/api/tracks', async () => ({ tracks: tracks().map(({ filename, ...track }) => track), shuffle: shuffle() }));
  app.post('/api/tracks', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'Selecciona un archivo de audio.' });
    const extension = extname(file.filename).toLowerCase();
    if (!['.mp3', '.ogg', '.flac', '.m4a', '.wav'].includes(extension)) { file.file.resume(); return reply.code(400).send({ error: 'Formatos: MP3, OGG, FLAC, M4A o WAV.' }); }
    const id = randomUUID();
    const filename = `${id}${extension}`;
    const destination = join(musicDir, filename);
    let inserted = false;
    try {
      let bytes = 0;
      file.file.on('data', chunk => { bytes += chunk.length; });
      await pipeline(file.file, createWriteStream(destination, { flags: 'wx' }));
      if (file.file.truncated) return reply.code(413).send({ error: 'El archivo supera el límite de 50 MB.' });
      let metadata;
      try {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', destination], { timeout: 15000, maxBuffer: 1024 * 1024 });
        metadata = JSON.parse(stdout);
      } catch { return reply.code(400).send({ error: 'El archivo no contiene audio válido o no se pudo analizar.' }); }
      const duration = Number(metadata.format?.duration);
      if (!metadata.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0) return reply.code(400).send({ error: 'El archivo debe contener audio con una duración válida.' });
      const tags = metadata.format?.tags ?? {};
      const clean = (v: unknown) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 250);
      const title = clean(tags.title ?? tags.TITLE) || clean(file.filename.slice(0, -extension.length));
      const artist = clean(tags.artist ?? tags.ARTIST) || 'Artista desconocido';
      db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, title, artist, filename, duration, bytes, Number(db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tracks').get()!.next), new Date().toISOString());
      inserted = true;
      await syncPlaylist();
      return reply.code(201).send({ id, title, artist, duration, bytes });
    } finally { if (!inserted) await unlink(destination).catch(() => {}); }
  });
  app.delete<{ Params: { id: string } }>('/api/tracks/:id', async (request, reply) => {
    const track = db.prepare('SELECT * FROM tracks WHERE id=?').get(request.params.id) as Track | undefined;
    if (!track) return reply.code(404).send({ error: 'Canción no encontrada.' });
    db.prepare('DELETE FROM tracks WHERE id=?').run(track.id);
    await syncPlaylist();
    await unlink(join(musicDir, track.filename)).catch(() => {});
    return { ok: true };
  });
  app.put<{ Body: { ids?: string[] } }>('/api/order', async (request, reply) => {
    const ids = request.body?.ids;
    const current = tracks();
    if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.some(t => t.id === id))) return reply.code(400).send({ error: 'El orden debe incluir todas las canciones una sola vez.' });
    db.exec('BEGIN');
    try { ids.forEach((id, i) => db.prepare('UPDATE tracks SET position=? WHERE id=?').run(i, id)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    await syncPlaylist();
    return { ok: true };
  });
  app.put<{ Body: { shuffle?: boolean } }>('/api/shuffle', async (request, reply) => {
    if (typeof request.body?.shuffle !== 'boolean') return reply.code(400).send({ error: 'Modo aleatorio no válido.' });
    db.prepare("UPDATE settings SET value=? WHERE key='shuffle'").run(String(request.body.shuffle));
    await syncPlaylist();
    return { shuffle: shuffle() };
  });
  app.get<{ Params: { id: string } }>('/api/audio/:id', async (request, reply) => {
    const track = db.prepare('SELECT filename FROM tracks WHERE id=?').get(request.params.id);
    if (!track) return reply.code(404).send({ error: 'Canción no encontrada.' });
    return reply.sendFile(String(track.filename), musicDir);
  });
  const icecastUrl = process.env.ICECAST_URL ?? 'http://127.0.0.1:8000';
  let cachedStatus: { at: number; value: unknown } | undefined;
  app.get('/api/status', async () => {
    if (cachedStatus && Date.now() - cachedStatus.at < 2000) return cachedStatus.value;
    let value;
    try {
      const response = await fetch(`${icecastUrl}/status-json.xsl`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error('Icecast unavailable');
      const data = await response.json() as { icestats?: { source?: Record<string, unknown> | Record<string, unknown>[] } };
      const sources = data.icestats?.source;
      const source = (Array.isArray(sources) ? sources : sources ? [sources] : []).find(s => String(s.listenurl).endsWith('/radio.mp3'));
      value = { connected: true, live: Boolean(source), listeners: Number(source?.listeners ?? 0), title: String(source?.title ?? ''), artist: String(source?.artist ?? ''), bitrate: 128 };
    } catch { value = { connected: false, live: false, listeners: 0, title: '', artist: '', bitrate: 128 }; }
    cachedStatus = { at: Date.now(), value };
    return value;
  });
  app.post<{ Params: { action: string } }>('/api/radio/:action', async (request, reply) => {
    const commands: Record<string, string> = { start: 'broadcast.start', stop: 'broadcast.stop', skip: 'library.skip' };
    const command = commands[request.params.action];
    if (!command) return reply.code(400).send({ error: 'Control no válido.' });
    if (request.params.action === 'start' && tracks().length === 0) return reply.code(400).send({ error: 'Sube al menos una canción antes de emitir.' });
    try {
      await liquidsoapCommand(command);
      cachedStatus = undefined;
      return { ok: true };
    } catch { return reply.code(503).send({ error: 'No se pudo contactar con Liquidsoap. Comprueba los servicios de Docker.' }); }
  });
  app.get('/stream', async (request, reply) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    reply.raw.on('close', () => controller.abort());
    try {
      const response = await fetch(`${icecastUrl}/radio.mp3`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok || !response.body) return reply.code(503).send({ error: 'La radio no está emitiendo.' });
      reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'no-store');
      return reply.send(response.body);
    } catch { return reply.code(503).send({ error: 'La radio no está disponible.' }); }
    finally { clearTimeout(timeout); }
  });
  await app.register(staticFiles, { root: resolve('dist/public'), maxAge: 0 });
  app.addHook('onClose', async () => { await playlistWrite; db.close(); });
  return app;
}
