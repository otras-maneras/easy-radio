import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildApp } from '../src/app.js';

test('authenticated library: upload, validation, order, persistence and deletion', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'stream-radio-test-'));
  const config = { dataDir, password: 'test-password-12345', secret: 'test-secret-long-enough-for-session-signing', logger: false };
  let app = await buildApp(config);
  const headers = { origin: 'http://localhost:80' };
  const login = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/login', headers, payload: { password: config.password } });
    assert.equal(response.statusCode, 200, response.body);
    return String(response.headers['set-cookie']).split(';')[0];
  };
  try {
    assert.equal((await app.inject('/api/tracks')).statusCode, 401);
    for (const url of ['/%61pi/tracks', '/%61%70%69/tracks']) {
      assert.equal((await app.inject(url)).statusCode, 401, `encoded library: ${url}`);
      assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 401, `encoded upload: ${url}`);
    }
    for (const [method, url] of [['GET', '/%61pi/audio/test'], ['DELETE', '/%61pi/tracks/test'], ['PUT', '/%61pi/order'], ['PUT', '/%61pi/shuffle'], ['POST', '/%61pi/radio/stop']] as const) {
      assert.equal((await app.inject({ method, url, headers })).statusCode, 401, `encoded protected route: ${url}`);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { password: config.password } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { password: 'wrong' } })).statusCode, 401);
    let cookie = await login();
    const auth = { ...headers, cookie };
    assert.equal((await app.inject({ url: '/api/session', headers: auth })).json().authenticated, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/radio/start', headers: auth })).statusCode, 400);
    const file = join(dataDir, 'fixture.mp3');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'title=<Test & song>', '-metadata', 'artist=Test artist', '-y', file]);
    const audio = await readFile(file);
    async function upload(body: Buffer, filename = 'song.mp3') {
      const boundary = 'radio-test-boundary';
      return app.inject({ method: 'POST', url: '/api/tracks', headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`), body, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    }
    assert.equal((await upload(Buffer.from('not audio'))).statusCode, 400);
    assert.equal((await upload(audio, 'not-allowed.txt')).statusCode, 400);
    assert.equal((await readdir(join(dataDir, 'music'))).length, 0);
    const first = await upload(audio);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().title, '<Test & song>');
    const second = await upload(audio);
    assert.equal(second.statusCode, 201, second.body);
    const one = first.json().id; const two = second.json().id;
    assert.equal((await app.inject(`/api/audio/${one}`)).statusCode, 401);
    const partial = await app.inject({ url: `/api/audio/${one}`, headers: { ...auth, range: 'bytes=0-99' } });
    assert.equal(partial.statusCode, 206); assert.equal(partial.rawPayload.length, 100);
    assert.match(String(partial.headers['cache-control']), /no-store/, 'authenticated audio must not be cached publicly');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/order', headers: auth, payload: { ids: [one, one] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/order', headers: auth, payload: { ids: [two, one] } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/shuffle', headers: auth, payload: { shuffle: true } })).statusCode, 200);
    let library = (await app.inject({ url: '/api/tracks', headers: auth })).json();
    assert.deepEqual(library.tracks.map((t: { id: string }) => t.id), [two, one]);
    assert.equal(library.shuffle, true);
    assert.ok(!(JSON.stringify(library).includes('filename')));
    await app.close();
    app = await buildApp(config);
    assert.equal((await app.inject({ url: '/api/tracks', headers: { cookie } })).statusCode, 200, 'sessions survive a restart with unchanged credentials');
    cookie = await login();
    library = (await app.inject({ url: '/api/tracks', headers: { cookie } })).json();
    assert.equal(library.tracks.length, 2); assert.equal(library.shuffle, true);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/tracks/${one}`, headers: { ...headers, cookie } })).statusCode, 200);
    assert.equal((await readdir(join(dataDir, 'music'))).length, 1);
    assert.ok(!(await readFile(join(dataDir, 'playlist.m3u'), 'utf8')).includes(one));
    assert.equal((await app.inject({ method: 'POST', url: '/api/radio/invalid', headers: { ...headers, cookie } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/logout', headers: { ...headers, cookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/tracks', headers: { cookie } })).statusCode, 401, 'a copied cookie is revoked after logout');
    assert.equal((await app.inject({ url: '/api/session', headers: { cookie } })).json().authenticated, false);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
