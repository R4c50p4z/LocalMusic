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
};

let currentUrl = null;
let loadToken = 0;
let countedPlay = false;

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
  const blob = await lib.getAudio(song.id);
  if (token !== loadToken) return; // llegó otra petición mientras tanto
  if (!blob) { emit('error', { message: 'No se encontró el audio de esta canción' }); return; }
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  audio.src = currentUrl;
  if (startAt) {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  }
  updateMediaSession(song);
  emit('track', { song });
  if (autoplay) {
    try { await audio.play(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
  }
  saveState();
}

export function toggle() {
  if (!current()) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
export function play() { if (current()) audio.play().catch(() => {}); }
export function pause() { audio.pause(); }

export async function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.index < state.queue.length - 1) state.index++;
  else if (state.repeat === 'all' || !auto) {
    state.index = 0;
    if (auto && state.shuffle) state.queue = shuffled(state.original);
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
  if (audio.currentTime > 3 || state.index === 0) {
    audio.currentTime = 0;
    return;
  }
  state.index--;
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
      shuffle: state.shuffle, repeat: state.repeat, context: state.context,
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

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* no soportado */ } };
  h('play', play);
  h('pause', pause);
  h('previoustrack', prev);
  h('nexttrack', () => next());
  h('seekto', (e) => seek(e.seekTime));
  h('seekbackward', (e) => seek(audio.currentTime - (e.seekOffset || 10)));
  h('seekforward', (e) => seek(audio.currentTime + (e.seekOffset || 10)));
}

/* ------------------------------ Eventos audio ------------------------------ */

audio.addEventListener('play', () => { emit('state'); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { emit('state'); saveState(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('ended', () => next(true));
audio.addEventListener('loadedmetadata', updatePositionState);
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  emit('error', { message: 'Este formato no se puede reproducir en este navegador' });
});

let lastSaved = 0;
audio.addEventListener('timeupdate', () => {
  emit('time');
  const t = audio.currentTime;
  if (Math.abs(t - lastSaved) > 5) { lastSaved = t; saveState(); updatePositionState(); }
  // Cuenta una reproducción al pasar 30 s (o la mitad si es corta)
  const song = current();
  if (!countedPlay && song && t > Math.min(30, (audio.duration || 60) / 2)) {
    countedPlay = true;
    lib.notePlayed(song.id, null);
  }
});
