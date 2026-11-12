// Estadísticas de escucha, guardadas sólo en el móvil (IndexedDB, almacén "history").
// Cada escucha es un registro: { id, songId, fileKey, title, artist, album, albumKey,
// start (ms), seconds (tiempo realmente escuchado), duration }.
import * as db from './db.js';
import * as lib from './library.js';
import * as player from './player.js';

let history = [];          // todos los registros, en memoria (son pequeños)
let loaded = false;

export async function load() {
  history = await db.getAll('history');
  history.sort((a, b) => a.start - b.start);
  loaded = true;
}

/* ----------------------------- Seguimiento ----------------------------- */
// Sólo se suma el tiempo que la canción suena de verdad: los saltos con la barra
// de progreso, las pausas y el tiempo en segundo plano sin sonar no cuentan.

const audio = player.audio;
let session = null;   // escucha en curso
let lastT = null;     // última posición vista del audio
let saving = Promise.resolve();
let savedSeconds = 0;

function startSession(song) {
  session = {
    songId: song.id, fileKey: song.fileKey, title: song.title, artist: song.artist,
    album: song.album, albumKey: lib.albumKey(song), coverId: song.coverId || null,
    start: Date.now(), seconds: 0, duration: song.duration || audio.duration || 0,
  };
  savedSeconds = 0;
}

function flush() {
  const s = session;
  if (!s || s.seconds < 5 || s.seconds === savedSeconds) return saving;
  savedSeconds = s.seconds;
  saving = saving.then(async () => {
    const rec = { ...s, seconds: Math.round(s.seconds * 10) / 10 };
    if (!rec.id) delete rec.id;
    const id = await db.putGetKey('history', rec);
    if (!s.id) { s.id = id; history.push({ ...rec, id }); }
    else {
      const i = history.findIndex(h => h.id === id);
      if (i >= 0) history[i] = { ...rec, id };
    }
  }).catch(err => console.warn('No se pudo guardar la escucha', err));
  return saving;
}

function endSession() {
  flush();
  session = null;
  lastT = null;
}

audio.addEventListener('timeupdate', () => {
  if (audio.paused || audio.seeking) return;
  const t = audio.currentTime;
  const song = player.current();
  if (!song) return;
  if (session && session.songId !== song.id) endSession();
  if (lastT !== null) {
    const d = t - lastT;
    // Un avance normal entre eventos es < 1 s; algo mayor es un salto, no escucha
    if (d > 0 && d < 2.5 * (audio.playbackRate || 1)) {
      if (!session) startSession(song);
      session.seconds += d;
      if (session.seconds - savedSeconds >= 15) flush();
    }
  }
  lastT = t;
});
audio.addEventListener('seeking', () => { lastT = null; });
audio.addEventListener('play', () => { lastT = audio.currentTime; });
audio.addEventListener('pause', () => { flush(); lastT = null; });
audio.addEventListener('ended', endSession);
player.bus.addEventListener('track', endSession);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
window.addEventListener('pagehide', flush);

/* ------------------------------- Cálculos ------------------------------- */

const DAY = 86400000;
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monthKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}`; };

// Incluye la escucha en curso para que las cifras estén al día
function records() {
  if (session && session.seconds >= 5 && !session.id) return [...history, session];
  if (session?.id) return history.map(h => (h.id === session.id ? { ...h, seconds: session.seconds } : h));
  return history;
}

/** ¿Cuenta como «reproducción»? Al menos 30 s, o la mitad si la canción es corta. */
export const isPlay = (r) => r.seconds >= Math.min(30, (r.duration || 60) / 2);

export function periodStart(period, now = Date.now()) {
  const today = dayStart(now);
  if (period === '7d') return today - 6 * DAY;
  if (period === '30d') return today - 29 * DAY;
  if (period === 'year') return new Date(new Date(now).getFullYear(), 0, 1).getTime();
  return 0;
}

export function compute(period = '7d', now = Date.now()) {
  const all = records();
  const from = periodStart(period, now);
  const list = all.filter(r => r.start >= from && r.start <= now);

  const total = list.reduce((a, r) => a + r.seconds, 0);
  const plays = list.filter(isPlay).length;

  // Gráfica: por días (7/30 días) o por meses (año / siempre)
  let buckets = [];
  if (period === '7d' || period === '30d') {
    const n = period === '7d' ? 7 : 30;
    const map = new Map();
    for (let i = n - 1; i >= 0; i--) {
      const t = dayStart(now) - i * DAY;
      const b = { key: dayKey(t), t, seconds: 0, kind: 'day' };
      map.set(b.key, b);
      buckets.push(b);
    }
    for (const r of list) { const b = map.get(dayKey(r.start)); if (b) b.seconds += r.seconds; }
  } else {
    const first = period === 'year' ? from : (list[0]?.start ?? now);
    const d = new Date(first); d.setDate(1); d.setHours(0, 0, 0, 0);
    const end = new Date(now);
    const map = new Map();
    while (d <= end) {
      const b = { key: monthKey(d.getTime()), t: d.getTime(), seconds: 0, kind: 'month' };
      map.set(b.key, b);
      buckets.push(b);
      d.setMonth(d.getMonth() + 1);
    }
    if (buckets.length > 24) buckets = buckets.slice(-24);
    for (const r of list) { const b = map.get(monthKey(r.start)); if (b) b.seconds += r.seconds; }
  }

  // Por hora del día
  const hours = new Array(24).fill(0);
  for (const r of list) hours[new Date(r.start).getHours()] += r.seconds;

  // Tops
  const group = (keyFn, make) => {
    const m = new Map();
    for (const r of list) {
      const k = keyFn(r);
      let g = m.get(k);
      if (!g) { g = { ...make(r), seconds: 0, plays: 0 }; m.set(k, g); }
      g.seconds += r.seconds;
      if (isPlay(r)) g.plays++;
      if (!g.coverId && r.coverId) g.coverId = r.coverId;
    }
    return [...m.values()].sort((a, b) => b.seconds - a.seconds);
  };
  const topSongs = group(r => r.fileKey || r.songId, r => ({ songId: currentId(r), title: r.title, artist: r.artist, album: r.album, coverId: r.coverId }));
  const topArtists = group(r => r.artist.toLowerCase(), r => ({ name: r.artist, key: r.artist.toLowerCase() }));
  const topAlbums = group(r => r.albumKey, r => ({ name: r.album, artist: r.artist, key: r.albumKey }));

  // Días con escucha (≥ 1 min) para rachas
  const daySecs = new Map();
  for (const r of all) daySecs.set(dayKey(r.start), (daySecs.get(dayKey(r.start)) || 0) + r.seconds);
  const active = (t) => (daySecs.get(dayKey(t)) || 0) >= 60;
  let streak = 0;
  let t = dayStart(now);
  if (!active(t)) t -= DAY; // si hoy aún no has escuchado, la racha sigue viva desde ayer
  while (active(t)) { streak++; t -= DAY; }
  let best = 0, run = 0, prev = null;
  for (const k of [...daySecs.keys()].filter(k => daySecs.get(k) >= 60).sort()) {
    const tk = new Date(k + 'T00:00:00').getTime();
    run = prev !== null && Math.round((tk - prev) / DAY) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = tk;
  }

  // Media diaria y mejor día del periodo
  const firstEver = all[0]?.start ?? now;
  const days = Math.max(1, Math.round((dayStart(now) - dayStart(Math.max(from, firstEver))) / DAY) + 1);
  let bestDay = null;
  const periodDays = new Map();
  for (const r of list) periodDays.set(dayKey(r.start), (periodDays.get(dayKey(r.start)) || 0) + r.seconds);
  for (const [k, v] of periodDays) if (!bestDay || v > bestDay.seconds) bestDay = { key: k, seconds: v };

  return {
    period, total, plays, buckets, hours, topSongs, topArtists, topAlbums,
    songs: topSongs.length, artists: topArtists.length, albums: topAlbums.length,
    streak, bestStreak: best, avgPerDay: list.length ? total / days : 0, bestDay,
    activeDays: periodDays.size, empty: !list.length,
  };
}

// La canción puede haberse borrado y vuelto a importar con otro id: se busca por archivo
function currentId(r) {
  if (lib.songs.has(r.songId)) return r.songId;
  for (const s of lib.songs.values()) if (s.fileKey === r.fileKey) return s.id;
  return null;
}

export function totals() {
  const today = dayStart(Date.now());
  let week = 0, todaySecs = 0;
  for (const r of records()) {
    if (r.start >= today - 6 * DAY) week += r.seconds;
    if (r.start >= today) todaySecs += r.seconds;
  }
  return { week, today: todaySecs, count: history.length };
}

export function recent(n = 50) {
  return records().slice(-n).reverse();
}

/* ---------------------------- Copia de seguridad ---------------------------- */
// Exporta escuchas, me gusta y playlists (no el audio) para no perderlos al cambiar de móvil.

export async function exportData() {
  await saving;
  const byId = (id) => lib.songs.get(id)?.fileKey;
  const data = {
    app: 'LocalMusic', version: 1, exportedAt: new Date().toISOString(),
    history: history.map(({ id, ...r }) => r),
    liked: [...lib.liked].map(byId).filter(Boolean),
    playlists: [...lib.playlists.values()].map(p => ({ name: p.name, createdAt: p.createdAt, files: p.songIds.map(byId).filter(Boolean) })),
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function importData(file) {
  const data = JSON.parse(await file.text());
  if (data?.app !== 'LocalMusic' || !Array.isArray(data.history)) throw new Error('El archivo no es una copia de LocalMusic');
  const byFile = new Map([...lib.songs.values()].map(s => [s.fileKey, s.id]));
  const seen = new Set(history.map(h => `${h.fileKey}|${h.start}`));
  let added = 0;
  for (const r of data.history) {
    if (!r || typeof r.start !== 'number' || typeof r.seconds !== 'number') continue;
    const k = `${r.fileKey}|${r.start}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const rec = {
      songId: byFile.get(r.fileKey) || r.songId || null, fileKey: String(r.fileKey || ''),
      title: String(r.title || ''), artist: String(r.artist || ''), album: String(r.album || ''),
      albumKey: String(r.albumKey || ''), coverId: byFile.get(r.fileKey) ? lib.songs.get(byFile.get(r.fileKey)).coverId : null,
      start: r.start, seconds: r.seconds, duration: Number(r.duration) || 0,
    };
    rec.id = await db.putGetKey('history', rec);
    history.push(rec);
    added++;
  }
  history.sort((a, b) => a.start - b.start);
  let likes = 0, lists = 0;
  for (const f of data.liked || []) {
    const id = byFile.get(f);
    if (id && !lib.liked.has(id)) { await lib.toggleLike(id); likes++; }
  }
  const names = new Set([...lib.playlists.values()].map(p => p.name));
  for (const p of data.playlists || []) {
    if (!p?.name || names.has(p.name)) continue;
    await lib.createPlaylist(p.name, (p.files || []).map(f => byFile.get(f)).filter(Boolean));
    lists++;
  }
  return { added, likes, lists };
}

export async function clearHistory() {
  session = null;
  await saving;
  await db.clear('history');
  history = [];
}

export const isLoaded = () => loaded;
