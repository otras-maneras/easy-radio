import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';

const credentials = { password: 'test-password-12345', secret: 'test-secret-long-enough-for-session-signing', logger: false };
const origin = 'http://localhost:80';
function multipart(audio: Buffer, filename = 'fixture.mp3') {
  const boundary = 'limits-test-boundary';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`), audio, Buffer.from(`\r\n--${boundary}--\r\n`)])
  };
}
async function login(app: Awaited<ReturnType<typeof buildApp>>, host = origin) {
  const r = await app.inject({ method: 'POST', url: '/api/login', headers: { origin: host, host: host === origin ? 'localhost:80' : new URL(host).host }, payload: { password: credentials.password } });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.headers['set-cookie']).split(';')[0];
}

test('library quota, track cap, parser restrictions and file cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radio-limits-'));
  const fixture = join(dir, 'fixture.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-y', fixture]);
  const audio = await readFile(fixture);
  let app = await buildApp({ ...credentials, dataDir: join(dir, 'quota'), limits: { maxLibraryBytes: audio.length * 2 - 1 } });
  try {
    let cookie = await login(app);
    const upload = (data: Buffer, filename?: string) => {
      const body = multipart(data, filename);
      return app.inject({ method: 'POST', url: '/api/tracks', headers: { origin, cookie, 'content-type': body.contentType }, payload: body.payload });
    };
    const first = await upload(audio); assert.equal(first.statusCode, 201, first.body);
    assert.equal((await upload(audio)).statusCode, 413, 'quota is enforced while streaming a file');
    assert.equal((await readdir(join(dir, 'quota/music'))).length, 1, 'partial rejected files are removed');
    await app.inject({ method: 'DELETE', url: `/api/tracks/${first.json().id}`, headers: { origin, cookie } });
    assert.equal((await upload(audio)).statusCode, 201, 'a failed upload releases its reservation');
    await app.close();
    app = await buildApp({ ...credentials, dataDir: join(dir, 'parsers'), limits: { maxTracks: 1 } });
    cookie = await login(app);
    // A playlist disguised as MP3 must not be treated as a supported demuxer.
    assert.equal((await upload(Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/private\n'))).statusCode, 400);
    assert.equal((await readdir(join(dir, 'parsers/music'))).length, 0);
    assert.equal((await upload(audio)).statusCode, 201);
    assert.equal((await upload(audio)).statusCode, 507, 'track count is bounded');
    await app.close();
    app = await buildApp({ ...credentials, dataDir: join(dir, 'file-limit'), limits: { maxUploadBytes: audio.length - 1 } });
    cookie = await login(app);
    assert.equal((await upload(audio)).statusCode, 413);
    assert.equal((await readdir(join(dir, 'file-limit/music'))).length, 0);
    await app.close();
    app = await buildApp({ ...credentials, dataDir: join(dir, 'disk-limit'), limits: { minFreeDiskBytes: Number.MAX_SAFE_INTEGER } });
    cookie = await login(app);
    assert.equal((await upload(audio)).statusCode, 507, 'disk reserve is enforced before writing');
    assert.equal((await readdir(join(dir, 'disk-limit/music'))).length, 0);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a slow upload cannot bypass the concurrency cap and disconnect releases its slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radio-concurrency-'));
  const app = await buildApp({ ...credentials, dataDir: dir, limits: { maxConcurrentUploads: 1 } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const cookie = await login(app, base);
  const slow = httpRequest(`${base}/api/tracks`, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'multipart/form-data; boundary=slow-boundary' } });
  slow.on('error', () => {});
  try {
    slow.write('--slow-boundary\r\nContent-Disposition: form-data; name="file"; filename="slow.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n');
    // Receiving the file headers ensures the first handler owns its slot.
    await new Promise(r => setTimeout(r, 100));
    const body = multipart(Buffer.from('invalid audio'));
    const blocked = await fetch(`${base}/api/tracks`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': body.contentType }, body: body.payload });
    assert.equal(blocked.status, 429); await blocked.body?.cancel();
    slow.destroy();
    let recovered = false;
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${base}/api/tracks`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': body.contentType }, body: body.payload });
      const code = response.status; await response.body?.cancel();
      if (code === 400) { recovered = true; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(recovered, 'aborted uploads release the slot');
    assert.equal((await readdir(join(dir, 'music'))).length, 0);
  } finally { slow.destroy(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('public stream slots are bounded and released on disconnect or upstream failure', async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.write(Buffer.alloc(1024)); });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const oldUrl = process.env.ICECAST_URL;
  process.env.ICECAST_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), 'radio-streams-'));
  const app = await buildApp({ ...credentials, dataDir: dir, limits: { maxStreams: 1 } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  try {
    const first = await fetch(`${base}/stream`, { signal: controller.signal });
    assert.equal(first.status, 200); await first.body!.getReader().read();
    const blocked = await fetch(`${base}/stream`); assert.equal(blocked.status, 503); await blocked.body?.cancel();
    controller.abort();
    let recovered = false;
    for (let i = 0; i < 20; i++) {
      const retry = await fetch(`${base}/stream`); const code = retry.status; await retry.body?.cancel();
      if (code === 200) { recovered = true; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(recovered);
    upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r()));
    for (let i = 0; i < 2; i++) {
      const failed = await fetch(`${base}/stream`); assert.equal(failed.status, 503); await failed.body?.cancel();
    }
  } finally {
    controller.abort(); upstream.closeAllConnections(); upstream.close(); await app.close();
    if (oldUrl === undefined) delete process.env.ICECAST_URL; else process.env.ICECAST_URL = oldUrl;
    await rm(dir, { recursive: true, force: true });
  }
});
