const icons: Record<string, string> = {
  radio: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="m5 7 13-5M7 12h5M7 16h2"/><circle cx="16" cy="15" r="2"/>',
  library: '<path d="M4 4v16M9 4v16M14 4l5 16"/>',
  music: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  antenna: '<circle cx="12" cy="10" r="2"/><path d="m9 21 3-9 3 9M7 5a7 7 0 0 0 0 10M17 5a7 7 0 0 1 0 10M4 2a11 11 0 0 0 0 16M20 2a11 11 0 0 1 0 16"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  play: '<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  share: '<path d="M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8"/>',
  headphones: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
  signal: '<path d="M5 19v-4M10 19v-7M15 19V8M20 19V4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  shuffle: '<path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-3 5-6m3-4c1-1 2-2 4-2h3m-4-4 4 4-4 4"/>',
  upload: '<path d="M12 16V3m-4 4 4-4 4 4M4 16v5h16v-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  volume: '<path d="M3 9h4l5-4v14l-5-4H3Zm13-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16"/>',
  link: '<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 1)"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>'
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.music}</svg>`;
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => { el.innerHTML = svg(el.dataset.icon!); });
function el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
type Track = { id: string; title: string; artist: string; duration: number; bytes: number; added: string };
type Status = { connected: boolean; live: boolean; listeners: number; title: string; artist: string };
let tracks: Track[] = [];
let authenticated = false;
let shuffle = false;
let view = 'radio';
let preview: Track | null = null;
let status: Status = { connected: false, live: false, listeners: 0, title: '', artist: '' };
let uploading = false;
const audio = el<HTMLAudioElement>('audio');
const login = el<HTMLDialogElement>('login-dialog');
audio.volume = 0.8;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) { el('toast').textContent = message; el('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el('toast').hidden = true; }, 6000); }
async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  if (response.status === 401 && path !== '/login') { authenticated = false; render(); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'No se pudo completar la operación.');
  return data;
}
function openLogin() { if (!login.open) login.showModal(); setTimeout(() => el<HTMLInputElement>('password').focus(), 30); }
function chooseUpload() { if (!authenticated) return openLogin(); el<HTMLInputElement>('file-input').click(); }
function setView(next: string) {
  if (next === 'library' && !authenticated) return openLogin();
  view = next;
  document.querySelectorAll<HTMLElement>('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  el('breadcrumb-current').textContent = view === 'library' ? 'Biblioteca' : 'Tu estación';
  el('section-title').textContent = view === 'library' ? 'Tu biblioteca' : 'Tu música, en un solo lugar';
  el('section-kicker').textContent = view === 'library' ? 'TU SELECCIÓN, SIN LÍMITES' : 'EL SONIDO DE TU ESTACIÓN';
  render();
  if (view === 'library') el('section-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function render() {
  el('station-hero').hidden = authenticated;
  el('account-label').textContent = authenticated ? 'Cerrar sesión' : 'Administrar';
  el('broadcast-controls').hidden = !authenticated;
  el('upload-button').hidden = !authenticated;
  el('empty-upload').hidden = !authenticated;
  el('empty-title').textContent = authenticated ? 'Toda gran radio empieza con una canción.' : 'Tu próxima canción favorita está por sonar.';
  el('empty-description').textContent = authenticated ? 'Arrastra tus archivos aquí o sube tus primeras canciones. Tú pones el sonido.' : 'Sintoniza la estación con el botón de reproducir. Si esta es tu radio, entra en Administrar para añadir música.';
  el('section-description').textContent = authenticated ? 'Construye la colección que da vida a tu radio.' : 'Una selección musical para acompañar tu día.';
  el('nav-count').textContent = String(tracks.length);
  el('collection-count').textContent = authenticated ? `${tracks.length} canciones` : 'Tu biblioteca musical';
  el('track-total').textContent = authenticated ? String(tracks.length) : '—';
  el('duration-total').textContent = tracks.length ? `${Math.round(tracks.reduce((sum, t) => sum + t.duration, 0) / 60)} min de música` : 'Tu selección musical';
  el('tab-count').textContent = String(tracks.length);
  const hasTracks = authenticated && tracks.length > 0;
  el('drop-zone').hidden = hasTracks;
  el('track-table').hidden = !hasTracks;
  el('library-toolbar').hidden = !hasTracks;
  el('shuffle-button').classList.toggle('active', shuffle);
  el('shuffle-button').setAttribute('aria-pressed', String(shuffle));
  const shuffleLabel = shuffle ? 'Desactivar orden aleatorio' : 'Activar orden aleatorio';
  el('shuffle-button').setAttribute('aria-label', shuffleLabel); el('shuffle-button').title = shuffleLabel;
  const search = el<HTMLInputElement>('search').value.toLocaleLowerCase();
  const filtered = tracks.filter(t => `${t.title} ${t.artist}`.toLocaleLowerCase().includes(search));
  el('no-results').hidden = !hasTracks || filtered.length > 0;
  el('track-rows').innerHTML = filtered.map(t => {
    const i = tracks.indexOf(t);
    return `<div class="track-row ${preview?.id === t.id ? 'selected' : ''}"><span class="row-number">${i + 1}</span><div class="track-title-cell"><button class="track-cover" data-action="preview" data-id="${t.id}" title="Preescuchar canción" aria-label="Preescuchar ${escapeHtml(t.title)}">${svg(preview?.id === t.id && !audio.paused ? 'pause' : 'play')}</button><div class="track-text"><strong class="track-name">${escapeHtml(t.title)}</strong><span class="track-artist">${escapeHtml(t.artist)}</span></div></div><span class="track-date">${new Date(t.added).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</span><span class="track-length">${duration(t.duration)}</span><div class="row-actions"><button class="icon-button" data-action="up" data-id="${t.id}" title="Subir en la lista" aria-label="Subir ${escapeHtml(t.title)}" ${i === 0 ? 'disabled' : ''}>${svg('up')}</button><button class="icon-button" data-action="down" data-id="${t.id}" title="Bajar en la lista" aria-label="Bajar ${escapeHtml(t.title)}" ${i === tracks.length - 1 ? 'disabled' : ''}>${svg('down')}</button><button class="icon-button delete-button" data-action="delete" data-id="${t.id}" title="Eliminar canción" aria-label="Eliminar ${escapeHtml(t.title)}">${svg('trash')}</button></div></div>`;
  }).join('');
}
async function loadTracks() {
  if (!authenticated) { tracks = []; render(); return; }
  const data = await api<{ tracks: Track[]; shuffle: boolean }>('/tracks');
  tracks = data.tracks; shuffle = data.shuffle; render();
}
function updatePlayer() {
  const playing = !audio.paused;
  el('player-play').innerHTML = svg(playing ? 'pause' : 'play');
  el('player-play').setAttribute('aria-label', playing ? 'Pausar escucha' : preview ? 'Reproducir preescucha' : 'Escuchar radio');
  el('hero-play').innerHTML = `${svg(playing && !preview ? 'pause' : 'play')}${playing && !preview ? 'Pausar escucha' : 'Escuchar radio'}`;
  el('now-title').textContent = preview?.title || status.title || 'Tu próxima canción favorita';
  el('now-artist').textContent = preview?.artist || status.artist || (status.live ? 'Frecuencia · En directo' : 'Sintoniza tu frecuencia');
  el('playing-badge').hidden = Boolean(preview) || !status.live;
  el('player-mode').textContent = preview ? 'PREESCUCHA PRIVADA' : 'TU RADIO INDEPENDIENTE';
  el('elapsed').textContent = preview ? duration(audio.currentTime || 0) : 'EN DIRECTO';
  el('track-duration').textContent = preview ? duration(preview.duration) : '∞';
  el('timeline-progress').style.width = preview ? `${Math.min(100, audio.currentTime / preview.duration * 100)}%` : playing ? '100%' : '0%';
}
async function toggleAudio(live = false) {
  if (live && preview) { audio.pause(); preview = null; audio.removeAttribute('src'); }
  if (!audio.paused) {
    audio.pause();
    // Release the live connection and its listener slot while paused.
    if (!preview) { audio.removeAttribute('src'); audio.load(); }
    return;
  }
  if (!preview && !status.live) { toast(status.connected ? 'La emisión está detenida. Iníciala desde la cabina.' : 'El servidor de radio aún no está conectado. Inicia los servicios de Docker.'); return; }
  if (!preview) audio.src = `/stream?t=${Date.now()}`;
  try { await audio.play(); } catch { toast('No se pudo reproducir el audio. Comprueba la emisión y vuelve a intentarlo.'); }
  updatePlayer(); render();
}
async function refreshStatus() {
  try {
    status = await api<Status>('/status');
    el('connection-dot').classList.toggle('offline', !status.live);
    el('connection-text').textContent = status.live ? 'En directo' : status.connected ? 'Fuera del aire' : 'Sin conexión';
    el('listeners').textContent = status.connected ? String(status.listeners) : '—';
    el<HTMLButtonElement>('start-broadcast').disabled = status.live;
    el<HTMLButtonElement>('stop-broadcast').disabled = !status.live;
    el<HTMLButtonElement>('skip-broadcast').disabled = !status.live || tracks.length === 0;
    updatePlayer();
  } catch { el('connection-text').textContent = 'Sin conexión'; el('connection-dot').classList.add('offline'); }
}
async function uploadFiles(files: File[]) {
  if (!authenticated) return openLogin();
  if (uploading) return toast('Espera a que termine la carga actual.');
  if (!files.length) return;
  uploading = true;
  el('upload-progress').hidden = false;
  let added = 0;
  const failures: string[] = [];
  for (const [i, file] of files.entries()) {
    el('upload-message').textContent = `${i + 1} de ${files.length} · ${file.name}`;
    if (file.size > 50 * 1024 * 1024) { failures.push(`${file.name}: supera 50 MB`); continue; }
    const body = new FormData(); body.append('file', file);
    try { await api('/tracks', { method: 'POST', body }); added++; }
    catch (error) { failures.push(`${file.name}: ${(error as Error).message}`); }
  }
  uploading = false;
  el('upload-progress').hidden = true;
  el<HTMLInputElement>('file-input').value = '';
  await loadTracks().catch(e => toast(e.message));
  toast(failures.length ? `${added} añadidas. ${failures.slice(0, 2).join(' · ')}${failures.length > 2 ? ` · ${failures.length - 2} errores más` : ''}` : `${added} ${added === 1 ? 'canción añadida' : 'canciones añadidas'} a tu biblioteca.`);
}
document.querySelectorAll<HTMLElement>('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view!)));
for (const id of ['upload-button', 'empty-upload', 'sidebar-upload']) el(id).addEventListener('click', chooseUpload);
el('account-button').addEventListener('click', async () => {
  if (!authenticated) return openLogin();
  try { await api('/logout', { method: 'POST' }); authenticated = false; tracks = []; if (preview) { audio.pause(); preview = null; audio.removeAttribute('src'); } setView('radio'); updatePlayer(); toast('Has cerrado la sesión.'); } catch (e) { toast((e as Error).message); }
});
el('close-login').addEventListener('click', () => login.close());
el('login-form').addEventListener('submit', async event => {
  event.preventDefault(); el('login-error').textContent = ''; el<HTMLButtonElement>('login-submit').disabled = true;
  try { await api('/login', { method: 'POST', body: JSON.stringify({ password: el<HTMLInputElement>('password').value }) }); authenticated = true; el<HTMLInputElement>('password').value = ''; login.close(); await loadTracks(); await refreshStatus(); }
  catch (e) { el('login-error').textContent = (e as Error).message; }
  finally { el<HTMLButtonElement>('login-submit').disabled = false; }
});
el<HTMLInputElement>('file-input').addEventListener('change', e => { void uploadFiles(Array.from((e.target as HTMLInputElement).files ?? [])); });
// Accept dropped files anywhere in the library; prevent the browser opening them.
window.addEventListener('dragover', e => { e.preventDefault(); if (authenticated) el('drop-zone').classList.add('dragging'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) el('drop-zone').classList.remove('dragging'); });
window.addEventListener('drop', e => { e.preventDefault(); el('drop-zone').classList.remove('dragging'); void uploadFiles(Array.from(e.dataTransfer?.files ?? [])); });
el('search').addEventListener('input', render);
el('shuffle-button').addEventListener('click', async () => {
  try { await api('/shuffle', { method: 'PUT', body: JSON.stringify({ shuffle: !shuffle }) }); shuffle = !shuffle; render(); toast(shuffle ? 'Orden de emisión mezclado. Se repite esta selección hasta volver a mezclar.' : 'Emisión en el orden de la biblioteca.'); }
  catch (e) { toast((e as Error).message); }
});
el('track-rows').addEventListener('click', async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  const track = tracks.find(t => t.id === button.dataset.id); if (!track) return;
  try {
    if (button.dataset.action === 'preview') {
      if (preview?.id === track.id) return void toggleAudio();
      audio.pause(); preview = track; audio.src = `/api/audio/${track.id}`; await audio.play(); updatePlayer(); render();
    } else if (button.dataset.action === 'delete') {
      if (!confirm(`¿Eliminar «${track.title}» de la biblioteca?`)) return;
      await api(`/tracks/${track.id}`, { method: 'DELETE' });
      if (preview?.id === track.id) { audio.pause(); preview = null; audio.removeAttribute('src'); updatePlayer(); }
      await loadTracks(); toast('Canción eliminada. Si estaba emitiéndose, puede terminar antes de salir de la lista.');
    } else {
      const index = tracks.indexOf(track); const next = index + (button.dataset.action === 'up' ? -1 : 1);
      if (next < 0 || next >= tracks.length) return;
      const ordered = [...tracks]; [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
      await api('/order', { method: 'PUT', body: JSON.stringify({ ids: ordered.map(t => t.id) }) }); tracks = ordered; render();
    }
  } catch (e) { toast((e as Error).message); }
});
el('player-play').addEventListener('click', () => { void toggleAudio(); });
el('hero-play').addEventListener('click', () => { void toggleAudio(true); });
el('return-live').addEventListener('click', () => { void toggleAudio(true); });
el<HTMLInputElement>('volume').addEventListener('input', e => { audio.volume = Number((e.target as HTMLInputElement).value); });
audio.addEventListener('timeupdate', updatePlayer);
audio.addEventListener('play', () => { updatePlayer(); render(); });
audio.addEventListener('pause', () => { updatePlayer(); render(); });
audio.addEventListener('ended', () => { updatePlayer(); render(); });
audio.addEventListener('error', () => { updatePlayer(); toast('El audio no está disponible en este momento.'); });
async function copy(text: string) { try { await navigator.clipboard.writeText(text); toast('Enlace copiado.'); } catch { window.prompt('Copia este enlace:', text); } }
el('share-button').addEventListener('click', () => { void copy(location.origin); });
el('copy-stream').addEventListener('click', () => { void copy(`${location.origin}/stream`); });
for (const [id, action] of [['start-broadcast', 'start'], ['stop-broadcast', 'stop'], ['skip-broadcast', 'skip']]) {
  el(id).addEventListener('click', async () => {
    const button = el<HTMLButtonElement>(id); button.disabled = true;
    try { await api(`/radio/${action}`, { method: 'POST' }); toast(action === 'skip' ? 'Pasando a la siguiente canción…' : action === 'start' ? 'Iniciando emisión…' : 'Deteniendo emisión…'); setTimeout(() => { void refreshStatus(); }, 2500); }
    catch (e) { toast((e as Error).message); }
    finally { button.disabled = false; }
  });
}
async function init() {
  try { authenticated = (await api<{ authenticated: boolean }>('/session')).authenticated; await loadTracks(); }
  catch { toast('No se pudo conectar con el servidor.'); }
  render(); await refreshStatus(); setInterval(() => { if (!document.hidden) void refreshStatus(); }, 5000);
}
void init();

export {};
