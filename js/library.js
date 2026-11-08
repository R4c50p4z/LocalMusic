// Estado de la biblioteca: canciones, álbumes, artistas, listas y "me gusta".
import * as db from './db.js';
import { readMetadata, readDuration, isAudioFile, canPlay, guessMime } from './metadata.js';

export const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const songs = new Map();      // id -> canción
export const playlists = new Map();  // id -> { id, name, songIds, createdAt, updatedAt }
export const liked = new Set();      // ids de canciones
const covers = new Map();            // coverId -> objectURL
let recent = [];                     // [{ type, id }] lo último que has escuchado
let plays = {};                      // id -> nº reproducciones

export async function load() {
  const [allSongs, allPlaylists, allCovers, likedArr, recentArr, playsObj] = await Promise.all([
    db.getAll('songs'), db.getAll('playlists'), db.entries('covers'),
    db.get('kv', 'liked'), db.get('kv', 'recent'), db.get('kv', 'plays'),
  ]);
  for (const s of allSongs) songs.set(s.id, s);
  for (const p of allPlaylists) playlists.set(p.id, p);
  for (const [k, blob] of allCovers) covers.set(k, URL.createObjectURL(blob));
  for (const id of likedArr || []) if (songs.has(id)) liked.add(id);
  recent = recentArr || [];
  plays = playsObj || {};
}

/* ----------------------------- Consultas ----------------------------- */

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
export const cmp = (a, b) => collator.compare(a, b);

export function coverUrl(coverId) { return coverId ? covers.get(coverId) || '' : ''; }
export function songCover(song) { return song ? coverUrl(song.coverId) : ''; }

export const albumKey = (s) => `${(s.albumArtist || s.artist).toLowerCase()}\u0001${s.album.toLowerCase()}`;

export function allSongs(sort = 'title') {
  const list = [...songs.values()];
  if (sort === 'recent') list.sort((a, b) => b.addedAt - a.addedAt);
  else if (sort === 'artist') list.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) || a.track - b.track);
  else list.sort((a, b) => cmp(a.title, b.title));
  return list;
}

export function albums() {
  const map = new Map();
  for (const s of songs.values()) {
    const k = albumKey(s);
    let a = map.get(k);
    if (!a) {
      a = { key: k, name: s.album, artist: s.albumArtist || s.artist, year: s.year, coverId: s.coverId, songs: [], addedAt: s.addedAt };
      map.set(k, a);
    }
    a.songs.push(s);
    if (!a.coverId && s.coverId) a.coverId = s.coverId;
    if (!a.year && s.year) a.year = s.year;
    a.addedAt = Math.max(a.addedAt, s.addedAt);
  }
  for (const a of map.values()) a.songs.sort(trackOrder);
  return [...map.values()].sort((a, b) => cmp(a.name, b.name));
}

export function trackOrder(a, b) {
  return (a.disc || 0) - (b.disc || 0) || (a.track || 999) - (b.track || 999) || cmp(a.title, b.title);
}

export function album(key) { return albums().find(a => a.key === key); }

export function artists() {
  const map = new Map();
  for (const s of songs.values()) {
    const name = s.artist;
    const k = name.toLowerCase();
    let a = map.get(k);
    if (!a) { a = { key: k, name, songs: [], coverId: null, albums: new Set() }; map.set(k, a); }
    a.songs.push(s);
    a.albums.add(albumKey(s));
    if (!a.coverId && s.coverId) a.coverId = s.coverId;
  }
  return [...map.values()].sort((a, b) => cmp(a.name, b.name));
}

export function artist(key) {
  const a = artists().find(x => x.key === key);
  if (!a) return null;
  a.songs.sort((x, y) => (plays[y.id] || 0) - (plays[x.id] || 0) || cmp(x.album, y.album) || trackOrder(x, y));
  a.albumList = albums().filter(al => a.albums.has(al.key) || al.artist.toLowerCase() === a.key);
  return a;
}

export function playlistSongs(p) { return p.songIds.map(id => songs.get(id)).filter(Boolean); }
export function likedSongs() { return [...liked].reverse().map(id => songs.get(id)).filter(Boolean); }

export function search(q) {
  const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const n = norm(q.trim());
  if (!n) return { songs: [], albums: [], artists: [], playlists: [] };
  const has = (t) => norm(t).includes(n);
  return {
    songs: allSongs().filter(s => has(s.title) || has(s.artist) || has(s.album)).slice(0, 50),
    albums: albums().filter(a => has(a.name) || has(a.artist)).slice(0, 20),
    artists: artists().filter(a => has(a.name)).slice(0, 20),
    playlists: [...playlists.values()].filter(p => has(p.name)),
  };
}

export function genres() {
  const map = new Map();
  for (const s of songs.values()) {
    const g = (s.genre || '').trim();
    if (!g) continue;
    const k = g.toLowerCase();
    if (!map.has(k)) map.set(k, { name: g, songs: [] });
    map.get(k).songs.push(s);
  }
  return [...map.values()].sort((a, b) => b.songs.length - a.songs.length);
}

export function mostPlayed(n = 10) {
  return Object.entries(plays).sort((a, b) => b[1] - a[1]).map(([id]) => songs.get(id)).filter(Boolean).slice(0, n);
}

export function recentItems() { return recent; }

/* ----------------------------- Importar ----------------------------- */

function hashBytes(bytes) {
  // FNV-1a sobre una muestra: suficiente para deduplicar carátulas.
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + bytes.length.toString(36);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/**
 * Importa ficheros elegidos por el usuario. Copia el audio a la base de datos local
 * para que siga disponible sin volver a elegirlo.
 */
export async function importFiles(fileList, onProgress) {
  const files = [...fileList].filter(isAudioFile);
  const existing = new Set([...songs.values()].map(s => s.fileKey));
  const result = { added: 0, skipped: 0, unsupported: 0, failed: 0, total: files.length };

  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.(i, files.length, f.name);
    const fileKey = `${f.name}|${f.size}`;
    if (existing.has(fileKey)) { result.skipped++; continue; }
    if (!canPlay(f)) { result.unsupported++; continue; }
    try {
      const [meta, duration] = await Promise.all([readMetadata(f), readDuration(f)]);
      let coverId = null, coverBlob = null;
      if (meta.picture) {
        coverId = 'c' + hashBytes(meta.picture.data);
        if (!covers.has(coverId)) {
          coverBlob = new Blob([meta.picture.data], { type: meta.picture.mime });
        }
      }
      const type = f.type || guessMime(f.name) || 'audio/mpeg';
      const song = {
        id: uid(), fileKey, fileName: f.name, size: f.size, mime: type,
        title: meta.title, artist: meta.artist, album: meta.album, albumArtist: meta.albumArtist,
        track: meta.track, year: meta.year, genre: meta.genre, duration,
        coverId, addedAt: Date.now() + i,
      };
      // Guardamos el fichero como Blob propio (no como File) para que persista.
      const audio = new Blob([f], { type });
      await db.addSong(song, audio, coverBlob);
      if (coverBlob) covers.set(coverId, URL.createObjectURL(coverBlob));
      songs.set(song.id, song);
      existing.add(fileKey);
      result.added++;
    } catch (err) {
      console.error('Error importando', f.name, err);
      result.failed++;
      if (err?.name === 'QuotaExceededError') { result.quota = true; break; }
    }
  }
  onProgress?.(files.length, files.length, '');
  emit('change');
  return result;
}

export async function getAudio(id) { return db.get('audio', id); }

/* ---------------------------- Modificaciones ---------------------------- */

export async function removeSongs(ids) {
  const idSet = new Set(ids);
  const coverCandidates = new Set();
  for (const id of ids) {
    const s = songs.get(id);
    if (s?.coverId) coverCandidates.add(s.coverId);
    songs.delete(id);
    liked.delete(id);
    delete plays[id];
  }
  for (const s of songs.values()) coverCandidates.delete(s.coverId);
  await db.deleteSongsAndCovers(ids, [...coverCandidates]);
  for (const c of coverCandidates) { URL.revokeObjectURL(covers.get(c)); covers.delete(c); }
  for (const p of playlists.values()) {
    const before = p.songIds.length;
    p.songIds = p.songIds.filter(id => !idSet.has(id));
    if (p.songIds.length !== before) await db.put('playlists', p);
  }
  await saveKv();
  emit('change');
}

export async function updateSong(id, fields) {
  const s = songs.get(id);
  if (!s) return;
  Object.assign(s, fields);
  await db.put('songs', s);
  emit('change');
}

export async function toggleLike(id) {
  if (liked.has(id)) liked.delete(id); else liked.add(id);
  await db.put('kv', [...liked], 'liked');
  emit('like', { id, liked: liked.has(id) });
  return liked.has(id);
}

export async function createPlaylist(name, songIds = []) {
  const p = { id: uid(), name: name.trim() || 'Mi lista', songIds: [...songIds], createdAt: Date.now(), updatedAt: Date.now() };
  playlists.set(p.id, p);
  await db.put('playlists', p);
  emit('change');
  return p;
}

export async function renamePlaylist(id, name) {
  const p = playlists.get(id);
  if (!p) return;
  p.name = name.trim() || p.name;
  p.updatedAt = Date.now();
  await db.put('playlists', p);
  emit('change');
}

export async function deletePlaylist(id) {
  playlists.delete(id);
  recent = recent.filter(r => !(r.type === 'playlist' && r.id === id));
  await db.del('playlists', id);
  await saveKv();
  emit('change');
}

export async function addToPlaylist(id, songIds) {
  const p = playlists.get(id);
  if (!p) return 0;
  const set = new Set(p.songIds);
  const add = songIds.filter(s => !set.has(s));
  p.songIds.push(...add);
  p.updatedAt = Date.now();
  await db.put('playlists', p);
  emit('change');
  return add.length;
}

export async function removeFromPlaylist(id, index) {
  const p = playlists.get(id);
  if (!p) return;
  p.songIds.splice(index, 1);
  p.updatedAt = Date.now();
  await db.put('playlists', p);
  emit('change');
}

export async function movePlaylistItem(id, from, to) {
  const p = playlists.get(id);
  if (!p || to < 0 || to >= p.songIds.length) return;
  const [x] = p.songIds.splice(from, 1);
  p.songIds.splice(to, 0, x);
  await db.put('playlists', p);
  emit('change');
}

export async function notePlayed(songId, context) {
  if (songId) plays[songId] = (plays[songId] || 0) + 1;
  if (context?.type && context.type !== 'queue') {
    recent = [{ type: context.type, id: context.id }, ...recent.filter(r => !(r.type === context.type && r.id === context.id))].slice(0, 12);
  }
  await saveKv();
}

async function saveKv() {
  await Promise.all([
    db.put('kv', [...liked], 'liked'),
    db.put('kv', recent, 'recent'),
    db.put('kv', plays, 'plays'),
  ]);
}

export async function wipe() {
  await db.clearAll();
  for (const u of covers.values()) URL.revokeObjectURL(u);
  songs.clear(); playlists.clear(); liked.clear(); covers.clear();
  recent = []; plays = {};
  emit('change');
}

export async function storageInfo() {
  let bytes = 0;
  for (const s of songs.values()) bytes += s.size || 0;
  let quota = 0;
  try { quota = (await navigator.storage.estimate()).quota || 0; } catch { /* sin soporte */ }
  return { bytes, quota };
}
