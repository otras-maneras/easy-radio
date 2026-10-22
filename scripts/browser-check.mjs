import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const base = process.env.SMOKE_URL || 'http://127.0.0.1:4173';
const env = await readFile('.env', 'utf8');
const password = env.match(/^ADMIN_PASSWORD=(.+)$/m)[1];
const dir = await mkdtemp(join(tmpdir(), 'radio-browser-'));
const browser = await chromium.launch();
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let id;
try {
  await page.goto(base);
  await page.getByRole('button',{name:'Administrar',exact:true}).click();
  await page.getByLabel('Contraseña de administración').fill(password);
  await page.getByRole('button',{name:'Entrar a mi estación'}).click();
  await page.getByRole('button',{name:'Cerrar sesión'}).waitFor();
  const fixture=join(dir,'fixture.mp3');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=10','-metadata','title=Browser test <song>','-metadata','artist=Test artist','-y',fixture]);
  await page.locator('#file-input').setInputFiles(fixture);
  await page.getByText('Browser test <song>',{exact:true}).waitFor();
  const library=await (await page.request.get(`${base}/api/tracks`)).json();
  id=library.tracks.find(t=>t.title==='Browser test <song>').id;
  await page.getByLabel('Buscar canciones').fill('not-a-song');
  await page.locator('#no-results').waitFor();
  await page.getByLabel('Buscar canciones').fill('Browser test');
  await page.getByRole('button',{name:'Preescuchar Browser test <song>',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('audio').paused);
  await page.getByRole('button',{name:'Pausar escucha',exact:true}).click();
  await mkdir('artifacts',{recursive:true});
  for (const [name,width,height] of [['library-desktop',1440,1000],['library-mobile',390,844]]) {
    await page.setViewportSize({width,height});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} overflow`);
    await page.screenshot({path:`artifacts/${name}.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);
  console.log('Browser: login, upload, safe metadata rendering, search, playback and responsive layout OK.');
} finally {
  if(id) await page.request.delete(`${base}/api/tracks/${id}`,{headers:{Origin:base}});
  await browser.close();await rm(dir,{recursive:true,force:true});
}
