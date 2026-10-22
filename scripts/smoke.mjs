// Exercise a running stack with synthetic audio; remove the fixture afterwards.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const base = process.env.SMOKE_URL || 'http://127.0.0.1:4173';
const env = await readFile('.env', 'utf8');
const password = env.match(/^ADMIN_PASSWORD=(.+)$/m)?.[1];
let cookie = '';
async function api(path, method='GET', body) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { Origin: base, ...(cookie ? {Cookie:cookie}:{}), ...(body && !(body instanceof FormData) ? {'Content-Type':'application/json'}:{}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const json = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(json)}`);
  if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return json;
}
const dir = await mkdtemp(join(tmpdir(), 'radio-smoke-'));
let id;
try {
  await api('/login','POST',{password});
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=30','-metadata','title=Radio smoke test','-metadata','artist=Integration test','-y',join(dir,'test.mp3')]);
  const data = new FormData(); data.append('file',new Blob([await readFile(join(dir,'test.mp3'))],{type:'audio/mpeg'}),'test.mp3');
  const track = await api('/tracks','POST',data); id=track.id;
  console.log('Upload and metadata OK');
  await api('/radio/start','POST');
  let live;
  for(let i=0;i<15;i++) {
    live=await api('/status');
    if(live.live && live.title.includes('Radio smoke test'))break;
    await new Promise(r=>setTimeout(r,2000));
  }
  assert.ok(live.live,'stream should be live');
  assert.ok(live.title.includes('Radio smoke test'),`metadata should match: ${JSON.stringify(live)}`);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5000);
  const response=await fetch(`${base}/stream`,{signal:controller.signal});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/audio\/mpeg/);
  const {value}=await response.body.getReader().read();assert.ok(value.length>0);controller.abort();clearTimeout(timeout);
  console.log('Live MP3 bytes and current song OK');
  await api('/radio/skip','POST');console.log('Skip command OK');
  await api('/radio/stop','POST');
  await new Promise(r=>setTimeout(r,2500));
  assert.equal((await api('/status')).live,false);console.log('Stop command OK');
  await api('/radio/start','POST');
  await new Promise(r=>setTimeout(r,3000));
  assert.equal((await api('/status')).live,true);console.log('Start command OK');
} finally {
  if(id) await api(`/tracks/${id}`,'DELETE');
  await api('/radio/stop','POST').catch(()=>{});
  await rm(dir,{recursive:true,force:true});
}
