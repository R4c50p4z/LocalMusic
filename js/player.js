// Motor de reproducción: cola, aleatorio, repetir, pantalla de bloqueo.
import * as lib from './library.js';
import * as db from './db.js';

export const audio = document.getElementById('audio');
export const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const state = {
  queue: [],          // ids en orden de reproducción
  original: [],       // orden original (para desactivar aleatorio)
  index: -1,
  shuffle: false,
  repeat: 'off',      // 'off' | 'all' | 'one'
  context: null,      // { type, id, label, href }
  autoplay: true,     // al acabar la lista, seguir con otras canciones (como Spotify)
  autoNextId: null,   // canción elegida para la reproducción automática
};

let currentUrl = null;
let loadToken = 0;
let countedPlay = false;
// La siguiente canción se deja preparada en memoria para cambiar sin silencios:
// con la pantalla apagada, un hueco sin sonido basta para que Android congele la
// página y entregue los controles de la pantalla de bloqueo a otra app.
let preloaded = { id: null, url: null };

export function current() { return lib.songs.get(state.queue[state.index]) || null; }
export function isPlaying() { return !audio.paused && !audio.ended; }

function shuffled(ids, firstId) {
  const a = ids.filter(id => id !== firstId);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return firstId ? [firstId, ...a] : a;
}

/** Reproduce una lista de canciones empezando por `start` (índice o -1 para aleatorio). */
export async function playList(ids, start = 0, context = null, opts = {}) {
  if (!ids.length) return;
  if (opts.shuffle !== undefined) state.shuffle = opts.shuffle;
  state.original = [...ids];
  state.context = context;
  let first = start >= 0 ? ids[start] : ids[Math.floor(Math.random() * ids.length)];
  if (state.shuffle) {
    state.queue = shuffled(ids, first);
    state.index = 0;
  } else {
    state.queue = [...ids];
    state.index = ids.indexOf(first);
  }
  emit('queue');
  await load(true);
  if (context) lib.notePlayed(null, context);
}

async function load(autoplay, startAt = 0) {
  const token = ++loadToken;
  const song = current();
  if (!song) return;
  countedPlay = false;
  let url;
  if (preloaded.id === song.id && preloaded.url) {
    // Camino rápido: sin esperas, todo ocurre en el mismo instante en que acaba la anterior
    url = preloaded.url;
    preloaded = { id: null, url: null };
  } else {
    const blob = await lib.getAudio(song.id);
    if (token !== loadToken) return; // llegó otra petición mientras tanto
    if (!blob) { emit('error', { message: 'No se encontró el audio de esta canción' }); return; }
    url = URL.createObjectURL(blob);
  }
  if (currentUrl && currentUrl !== url) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
  updateMediaSession(song);
  audio.src = url;
  applyLoop();
  if (startAt) {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  }
  const playing = autoplay ? audio.play() : null;
  emit('track', { song });
  saveState();
  if (playing) {
    try { await playing; } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
  }
  preloadNext();
}

/** Qué canción sonará después de la actual (o null). */
function upcomingId() {
  if (state.repeat === 'one' || !state.queue.length) return null;
  if (state.index < state.queue.length - 1) return state.queue[state.index + 1];
  if (state.repeat === 'all') return state.queue[0];
  if (state.autoplay) return pickAutoNext();
  return null;
}

/** Reproducción automática: una canción al azar que no haya sonado en esta cola. */
function pickAutoNext() {
  if (state.autoNextId && lib.songs.has(state.autoNextId) && !state.queue.includes(state.autoNextId)) return state.autoNextId;
  const used = new Set(state.queue);
  let pool = [...lib.songs.keys()].filter(id => !used.has(id));
  if (!pool.length) pool = [...lib.songs.keys()].filter(id => id !== state.queue[state.index]);
  state.autoNextId = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  return state.autoNextId;
}

export function setAutoplay(on) {
  state.autoplay = !!on;
  state.autoNextId = null;
  preloadNext();
  saveState();
}

let preloadToken = 0;
async function preloadNext() {
  const id = upcomingId();
  if (!id || preloaded.id === id) return;
  const token = ++preloadToken;
  const blob = await lib.getAudio(id).catch(() => null);
  if (!blob || token !== preloadToken || upcomingId() !== id) return;
  if (preloaded.url && preloaded.url !== currentUrl) URL.revokeObjectURL(preloaded.url);
  preloaded = { id, url: URL.createObjectURL(blob) };
}

// Repetir una canción con el bucle nativo del navegador: no hay «fin», así que nunca se corta
function applyLoop() { audio.loop = state.repeat === 'one'; }

export function toggle() {
  if (!current()) return;
  if (audio.paused) audio.play().catch(() => {}); else pause();
}
export function play() {
  if (!current()) return;
  // Si el navegador descartó el audio mientras estaba en pausa, se vuelve a cargar
  if (!audio.currentSrc || audio.error) load(true, audio.currentTime || 0);
  else audio.play().catch(() => {});
}
let userPaused = false;
let endHandledFor = null; // canción cuyo final ya se gestionó
export function pause() { userPaused = true; audio.pause(); }

export async function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') { // por si el bucle nativo no estaba activo
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.index < state.queue.length - 1) state.index++;
  else if (state.repeat === 'all') {
    state.index = 0;
    // Nueva vuelta en aleatorio: se baraja de nuevo, empezando por la ya preparada
    if (auto && state.shuffle) state.queue = shuffled(state.original, state.queue[0]);
  } else if (state.autoplay && pickAutoNext()) {
    // Fin de la lista: seguir con otra canción de tu biblioteca
    state.queue.push(state.autoNextId);
    state.autoNextId = null;
    state.index++;
    if (state.context?.type !== 'auto') state.context = { type: 'auto', label: 'Reproducción automática' };
  } else if (!auto) {
    state.index = 0;
  } else {
    audio.pause();
    audio.currentTime = 0;
    emit('state');
    return;
  }
  emit('queue');
  await load(true);
}

export async function prev() {
  if (!state.queue.length) return;
  // Si ya lleva unos segundos, «anterior» vuelve al principio (como en cualquier reproductor)
  const atStart = state.index === 0 && state.repeat !== 'all';
  if (audio.currentTime > 3 || atStart || state.queue.length === 1) {
    audio.currentTime = 0;
    if (audio.paused) play();
    return;
  }
  state.index = state.index === 0 ? state.queue.length - 1 : state.index - 1;
  emit('queue');
  await load(true);
}

export async function jumpTo(queueIndex) {
  if (queueIndex < 0 || queueIndex >= state.queue.length) return;
  state.index = queueIndex;
  emit('queue');
  await load(true);
}

export function seek(seconds) {
  if (!Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
}

export function toggleShuffle() {
  state.shuffle = !state.shuffle;
  const cur = state.queue[state.index];
  if (state.shuffle) {
    const rest = state.queue.slice(state.index + 1);
    const before = state.queue.slice(0, state.index + 1);
    state.queue = [...before, ...shuffled(rest)];
  } else if (cur) {
    // Vuelve al orden original, manteniendo lo añadido manualmente al final
    const extra = state.queue.filter(id => !state.original.includes(id));
    state.queue = [...state.original, ...extra];
    state.index = state.queue.indexOf(cur);
  }
  emit('queue');
  emit('state');
  saveState();
}

export function cycleRepeat() {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  applyLoop();
  preloadNext();
  emit('state');
  saveState();
}

export function addToQueue(ids) {
  const wasEmpty = !state.queue.length;
  state.queue.push(...ids);
  if (wasEmpty) {
    state.original = [...ids];
    state.index = 0;
    state.context = { type: 'queue', label: 'Tu cola' };
    load(true);
  }
  emit('queue');
  saveState();
}

export function playNext(ids) {
  if (!state.queue.length) return addToQueue(ids);
  state.queue.splice(state.index + 1, 0, ...ids);
  emit('queue');
  saveState();
}

export function removeFromQueue(queueIndex) {
  if (queueIndex === state.index) return;
  state.queue.splice(queueIndex, 1);
  if (queueIndex < state.index) state.index--;
  emit('queue');
  saveState();
}

/** Quita de la cola canciones borradas de la biblioteca. */
export function purge() {
  const cur = state.queue[state.index];
  state.queue = state.queue.filter(id => lib.songs.has(id));
  state.original = state.original.filter(id => lib.songs.has(id));
  if (!lib.songs.has(cur)) {
    audio.pause();
    audio.removeAttribute('src');
    state.index = Math.min(state.index, state.queue.length - 1);
    if (state.index >= 0) load(false); else emit('track', { song: null });
  } else state.index = state.queue.indexOf(cur);
  emit('queue');
  saveState();
}

/* ------------------------- Persistencia del estado ------------------------- */

let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.put('kv', {
      queue: state.queue, original: state.original, index: state.index,
      shuffle: state.shuffle, repeat: state.repeat, context: state.context, autoplay: state.autoplay,
      position: audio.currentTime || 0,
    }, 'player').catch(() => {});
  }, 300);
}

export async function restore() {
  const s = await db.get('kv', 'player');
  if (!s) return;
  state.queue = (s.queue || []).filter(id => lib.songs.has(id));
  state.original = (s.original || []).filter(id => lib.songs.has(id));
  state.shuffle = !!s.shuffle;
  state.repeat = s.repeat || 'off';
  state.context = s.context || null;
  state.autoplay = s.autoplay !== false;
  const cur = s.queue?.[s.index];
  state.index = state.queue.indexOf(cur);
  if (state.index < 0 && state.queue.length) state.index = 0;
  emit('queue');
  emit('state');
  if (state.index >= 0) await load(false, s.position || 0);
}

/* ----------------------------- Media Session ----------------------------- */

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  const art = lib.songCover(song);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist,
    album: song.album,
    artwork: art ? [{ src: art, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration, playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch { /* ignorar */ }
}

// Controles de la pantalla de bloqueo, auriculares y Centro de control.
// Sólo canción anterior/siguiente: si se registran «avanzar/retroceder 10 s»,
// el iPhone los muestra EN LUGAR de los de cambiar de canción.
function registerMediaHandlers() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const h = (action, fn) => {
    try {
      ms.setActionHandler(action, fn && ((details) => {
        try { fn(details); } catch (err) { console.warn('Acción', action, err); }
      }));
    } catch { /* acción no soportada en este navegador */ }
  };
  h('play', () => play());
  h('pause', () => pause());
  h('stop', () => pause());
  h('previoustrack', () => prev());
  h('nexttrack', () => next());
  h('seekto', (e) => seek(e.seekTime));
  h('seekbackward', null);
  h('seekforward', null);
}
registerMediaHandlers();

/* ------------------------------ Eventos audio ------------------------------ */

audio.addEventListener('play', () => { registerMediaHandlers(); emit('state'); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { emit('state'); saveState(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
// Al acabar, la siguiente arranca en el mismo instante (está precargada) y la
// pantalla de bloqueo sigue mostrando «reproduciendo» durante el cambio.
audio.addEventListener('ended', () => {
  const id = current()?.id;
  if (id && endHandledFor === id) return; // el vigilante ya pasó a la siguiente
  endHandledFor = id;
  if ('mediaSession' in navigator && upcomingId()) navigator.mediaSession.playbackState = 'playing';
  next(true);
});
bus.addEventListener('queue', () => setTimeout(preloadNext, 0));

// Safari en iPhone calcula mal la duración de muchos MP3 (bitrate variable): la
// canción se para un poco antes del final que él cree y nunca avisa de que ha
// terminado. Si el audio deja de avanzar cerca del final, se pasa a la siguiente.
let watchPos = -1, watchStill = 0;
function nearEnd() {
  const song = current();
  const d = Math.min(audio.duration || Infinity, song?.duration || Infinity);
  return Number.isFinite(d) && d > 0 && audio.currentTime >= d - Math.max(3, d * 0.04);
}
function forceEnded(reason) {
  const id = current()?.id;
  if (!id || endHandledFor === id || audio.loop) return;
  endHandledFor = id;
  console.info('Fin de canción forzado:', reason);
  if ('mediaSession' in navigator && upcomingId()) navigator.mediaSession.playbackState = 'playing';
  next(true);
}
bus.addEventListener('track', () => { endHandledFor = null; watchPos = -1; watchStill = 0; });
setInterval(() => {
  if (audio.paused || audio.loop || !current()) { watchStill = 0; return; }
  if (Math.abs(audio.currentTime - watchPos) < 0.05) watchStill++; else watchStill = 0;
  watchPos = audio.currentTime;
  if (watchStill >= 2 && nearEnd()) forceEnded('el audio dejó de avanzar');
}, 1000);
for (const ev of ['stalled', 'waiting', 'suspend']) {
  audio.addEventListener(ev, () => {
    if (audio.paused || audio.loop || !nearEnd()) return;
    const at = audio.currentTime;
    setTimeout(() => { if (!audio.paused && Math.abs(audio.currentTime - at) < 0.05 && nearEnd()) forceEnded(ev); }, 1500);
  });
}
// Algunas versiones de iOS lanzan «pause» en vez de «ended» al acabar
audio.addEventListener('pause', () => {
  if (!audio.ended && !userPaused && nearEnd() && audio.currentTime >= (audio.duration || Infinity) - 0.6) forceEnded('pausa al final');
  userPaused = false;
});

// Cada vuelta del bucle de «repetir una» cuenta como una reproducción nueva
let lastPos = 0;
audio.addEventListener('seeking', () => {
  if (audio.loop && audio.duration && lastPos > audio.duration - 1.5 && audio.currentTime < 1.5) {
    countedPlay = false;
    emit('loop');
  }
});
audio.addEventListener('loadedmetadata', updatePositionState);
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  emit('error', { message: 'Este formato no se puede reproducir en este navegador' });
});

let lastSaved = 0;
audio.addEventListener('timeupdate', () => {
  emit('time');
  const t = audio.currentTime;
  lastPos = t;
  if (Math.abs(t - lastSaved) > 5) { lastSaved = t; saveState(); updatePositionState(); }
  // Cuenta una reproducción al pasar 30 s (o la mitad si es corta)
  const song = current();
  if (!countedPlay && song && t > Math.min(30, (audio.duration || 60) / 2)) {
    countedPlay = true;
    lib.notePlayed(song.id, null);
  }
});
