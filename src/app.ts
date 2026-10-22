import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile, unlink, statfs, chmod } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { Transform } from 'node:stream';
import { createSessions, sameSecret } from './sessions.js';
import { readLimits, type Limits } from './limits.js';

const execFileAsync = promisify(execFile);
type Track = { id: string; title: string; artist: string; filename: string; duration: number; bytes: number; position: number; added: string };
type Options = { dataDir?: string; password?: string; secret?: string; logger?: boolean; limits?: Partial<Limits> };

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
  const limits = readLimits(options.limits);
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const musicDir = join(dataDir, 'music');
  await mkdir(musicDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'radio.sqlite'));
  await chmod(join(dataDir, 'radio.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, filename TEXT NOT NULL, duration REAL NOT NULL, bytes INTEGER NOT NULL, position INTEGER NOT NULL, added TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('shuffle', 'false');`);
  const sessions = createSessions(db, password, secret);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 64 * 1024, requestTimeout: 60_000, connectionTimeout: 60_000, keepAliveTimeout: 5000 });
  app.server.maxConnections = 256;
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: limits.maxUploadBytes, files: 1, fields: 0, parts: 1 } });
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
    if (path.startsWith('/api/') && !publicPaths.includes(path) && !sessions.authenticated(request.headers.cookie)) {
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
  app.get('/api/session', async request => ({ authenticated: sessions.authenticated(request.headers.cookie) }));
  app.post<{ Body: { password?: string } }>('/api/login', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (typeof request.body?.password !== 'string' || !sameSecret(request.body.password, password)) return reply.code(401).send({ error: 'La contraseña no es correcta.' });
    const secure = originFor(request.headers.host).startsWith('https:') ? '; Secure' : '';
    reply.header('Set-Cookie', `session=${sessions.create()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
    return { ok: true };
  });
  app.post('/api/logout', async (request, reply) => {
    sessions.revoke(request.headers.cookie);
    const secure = originFor(request.headers.host).startsWith('https:') ? '; Secure' : '';
    reply.header('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
    return { ok: true };
  });
  app.get('/api/tracks', async () => ({ tracks: tracks().map(({ filename, ...track }) => track), shuffle: shuffle() }));
  let activeUploads = 0;
  let reservedUploadBytes = 0;
  app.post('/api/tracks', async (request, reply) => {
    if (activeUploads >= limits.maxConcurrentUploads) return reply.code(429).header('Retry-After', '2').send({ error: 'Hay otras subidas en curso. Vuelve a intentarlo en unos segundos.' });
    const usage = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM tracks').get()!;
    if (Number(usage.count) + activeUploads >= limits.maxTracks) return reply.code(507).send({ error: 'Se alcanzó el número máximo de canciones.' });
    const capacity = Math.min(limits.maxUploadBytes, limits.maxLibraryBytes - Number(usage.bytes) - reservedUploadBytes);
    if (capacity <= 0) return reply.code(507).send({ error: 'La biblioteca ha alcanzado su límite de espacio.' });
    // Reserve capacity before awaiting I/O, so concurrent requests cannot all
    // claim the same remaining disk/library space.
    activeUploads++;
    reservedUploadBytes += capacity;
    let destination: string | undefined;
    let inserted = false;
    try {
      const disk = await statfs(dataDir);
      if (disk.bavail * disk.bsize - reservedUploadBytes < limits.minFreeDiskBytes) return reply.code(507).send({ error: 'No queda suficiente espacio libre en el servidor.' });
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: 'Selecciona un archivo de audio.' });
      const extension = extname(file.filename).toLowerCase();
      if (!['.mp3', '.ogg', '.flac', '.m4a', '.wav'].includes(extension)) { file.file.resume(); return reply.code(400).send({ error: 'Formatos: MP3, OGG, FLAC, M4A o WAV.' }); }
      const id = randomUUID();
      const filename = `${id}${extension}`;
      destination = join(musicDir, filename);
      let bytes = 0;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > capacity) callback(Object.assign(new Error('El archivo supera el espacio disponible para esta subida.'), { statusCode: 413 }));
        else callback(null, chunk);
      } });
      await pipeline(file.file, meter, createWriteStream(destination, { flags: 'wx' }));
      if (file.file.truncated) return reply.code(413).send({ error: 'El archivo supera el tamaño permitido.' });
      let metadata;
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v', 'error', '-protocol_whitelist', 'file',
          '-format_whitelist', 'mp3,ogg,flac,wav,mov,mp4,m4a,3gp,3g2,mj2',
          '-probesize', '5242880', '-analyzeduration', '5000000',
          '-select_streams', 'a', '-show_format', '-show_streams', '-of', 'json', destination
        ], { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/tmp' } });
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
    } finally {
      activeUploads--;
      reservedUploadBytes -= capacity;
      if (destination && !inserted) await unlink(destination).catch(() => {});
    }
  });
  app.delete<{ Params: { id: string } }>('/api/tracks/:id', async (request, reply) => {
    const track = db.prepare('SELECT * FROM tracks WHERE id=?').get(request.params.id) as Track | undefined;
    if (!track) return reply.code(404).send({ error: 'Canción no encontrada.' });
    db.prepare('DELETE FROM tracks WHERE id=?').run(track.id);
    await syncPlaylist();
    await unlink(join(musicDir, track.filename)).catch(() => {});
    return { ok: true };
  });
  app.put<{ Body: { ids?: string[] } }>('/api/order', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const ids = request.body?.ids;
    const current = tracks();
    const currentIds = new Set(current.map(t => t.id));
    if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !currentIds.has(id))) return reply.code(400).send({ error: 'El orden debe incluir todas las canciones una sola vez.' });
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
  let activePreviews = 0;
  app.get<{ Params: { id: string } }>('/api/audio/:id', async (request, reply) => {
    const track = db.prepare('SELECT filename FROM tracks WHERE id=?').get(request.params.id);
    if (!track) return reply.code(404).send({ error: 'Canción no encontrada.' });
    if (activePreviews >= limits.maxPreviews) return reply.code(429).header('Retry-After', '2').send({ error: 'Hay demasiadas preescuchas abiertas.' });
    activePreviews++;
    let released = false;
    const release = () => { if (!released) { released = true; activePreviews--; } };
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
    return reply.sendFile(String(track.filename), musicDir, { cacheControl: false });
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
  let activeStreams = 0;
  app.get('/stream', async (_request, reply) => {
    if (activeStreams >= limits.maxStreams) return reply.code(503).header('Retry-After', '10').send({ error: 'La radio ha alcanzado su límite de oyentes. Vuelve a intentarlo más tarde.' });
    activeStreams++;
    let released = false;
    let streaming = false;
    const release = () => { if (!released) { released = true; activeStreams--; } };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    reply.raw.once('close', () => { controller.abort(); release(); });
    reply.raw.once('finish', release);
    try {
      const response = await fetch(`${icecastUrl}/radio.mp3`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok || !response.body) return reply.code(503).send({ error: 'La radio no está emitiendo.' });
      reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'no-store');
      streaming = true;
      return reply.send(response.body);
    } catch { return reply.code(503).send({ error: 'La radio no está disponible.' }); }
    finally { clearTimeout(timeout); if (!streaming) release(); }
  });
  await app.register(staticFiles, { root: resolve('dist/public'), maxAge: 0 });
  app.addHook('onClose', async () => { await playlistWrite; db.close(); });
  return app;
}
