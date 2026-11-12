// Interfaz: rutas, vistas, reproductor y menús.
import * as lib from './library.js';
import * as player from './player.js';
import { icon } from './icons.js';
import * as stats from './stats.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

/* ------------------------------ Utilidades ------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTotal(list) {
  const t = list.reduce((a, s) => a + (s.duration || 0), 0);
  if (t < 60) return `${Math.round(t)} s`;
  const h = Math.floor(t / 3600), m = Math.round((t % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
function fmtListen(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function fmtBytes(b) {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function coverImg(url, cls = 'cover', alt = '') {
  return url
    ? `<img class="${cls}" src="${url}" alt="${esc(alt)}" loading="lazy" decoding="async">`
    : `<div class="${cls} ph" role="img" aria-label="${esc(alt)}"></div>`;
}

// Carátula generada para "Tus me gusta" y listas sin portada
function gradientCover(cls, from, to, glyph) {
  return `<div class="${cls}" style="background:linear-gradient(135deg,${from},${to});display:grid;place-items:center">${icon(glyph)}</div>`;
}

function playlistCover(p, cls = 'cover') {
  const songs = lib.playlistSongs(p);
  const urls = [...new Set(songs.map(lib.songCover).filter(Boolean))].slice(0, 4);
  if (urls.length >= 4) {
    return `<div class="${cls}" style="display:grid;grid-template-columns:1fr 1fr;overflow:hidden">${urls.map(u => `<img src="${u}" alt="" style="width:100%;height:100%;object-fit:cover">`).join('')}</div>`;
  }
  if (urls.length) return coverImg(urls[0], cls);
  return gradientCover(cls, '#3b3b3b', '#282828', 'note');
}
const likedCover = (cls = 'cover') => gradientCover(cls, '#4a2fbd', '#8fb5c9', 'heartFill');

let toastTimer;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// Color medio de una imagen, para fondos tipo "degradado del álbum"
const colorCache = new Map();
function averageColor(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = 1 + (max - min) / 32; // da más peso a los píxeles con color
          r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
        }
        r /= n; g /= n; b /= n;
        // Oscurecer para que el texto blanco se lea bien
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const k = lum > 110 ? 110 / lum : 1;
        const col = `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
        colorCache.set(url, col);
        resolve(col);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/* ------------------------------- Listas ------------------------------- */

// Cada lista renderizada guarda sus ids para poder reproducir desde ella.
let lists = {};
let listSeq = 0;

function songRows(songsArr, ctx, opts = {}) {
  const key = 'l' + (++listSeq);
  lists[key] = { ids: songsArr.map(s => s.id), ctx };
  const cur = player.current()?.id;
  return `<div class="list" data-list="${key}">${songsArr.map((s, i) => `
    <div class="item${s.id === cur ? ' playing' : ''}" data-song="${s.id}" data-i="${i}" role="button" tabindex="0">
      ${opts.numbers ? `<span class="num">${s.track || i + 1}</span>` : coverImg(lib.songCover(s))}
      <div class="txt">
        <div class="t">${esc(s.title)}</div>
        <div class="s">${icon('eq', 'eq')}${lib.liked.has(s.id) && !opts.hideLike ? icon('heartFill', 'dl') : ''}${esc(opts.numbers && !opts.showArtist ? s.artist : `${s.artist}${opts.hideAlbum ? '' : ' · ' + s.album}`)}</div>
      </div>
      <button class="icon-btn more" data-more="${s.id}" data-i="${i}" aria-label="Opciones de ${esc(s.title)}">${icon('moreV')}</button>
    </div>`).join('')}</div>`;
}

function markPlaying() {
  const cur = player.current()?.id;
  document.querySelectorAll('.item[data-song]').forEach(el => el.classList.toggle('playing', el.dataset.song === cur));
  document.querySelectorAll('[data-playctx]').forEach(el => {
    const on = isCtxPlaying(el.dataset.playctx);
    el.innerHTML = icon(on ? 'pause' : 'play');
    el.setAttribute('aria-label', on ? 'Pausar' : 'Reproducir');
  });
}

function ctxKey(c) { return c ? `${c.type}:${c.id ?? ''}` : ''; }
function isCtxPlaying(key) { return player.isPlaying() && ctxKey(player.state.context) === key; }

/* ------------------------------- Rutas ------------------------------- */

const routes = [
  [/^\/?$/, viewHome, 'home'],
  [/^\/search$/, viewSearch, 'search'],
  [/^\/library$/, viewLibrary, 'library'],
  [/^\/songs$/, viewSongs, 'library'],
  [/^\/liked$/, viewLiked, 'library'],
  [/^\/album\/(.+)$/, viewAlbum, 'library'],
  [/^\/artist\/(.+)$/, viewArtist, 'library'],
  [/^\/playlist\/(.+)$/, viewPlaylist, 'library'],
  [/^\/genre\/(.+)$/, viewGenre, 'search'],
  [/^\/settings$/, viewSettings, 'home'],
  [/^\/stats$/, viewStats, 'home'],
];

let lastHash = null;

function render(keepScroll = false) {
  const hash = location.hash.slice(1) || '/';
  const path = hash.split('?')[0];
  lastHash = hash;
  lists = {};
  view.classList.remove('has-hero');
  document.documentElement.style.setProperty('--hero', '#3a3a3a');
  for (const [re, fn, tab] of routes) {
    const m = path.match(re);
    if (!m) continue;
    document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
    fn(...m.slice(1).map(decodeURIComponent));
    if (!keepScroll) window.scrollTo(0, 0);
    return;
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => render());

function rerender() {
  const y = window.scrollY;
  render(true);
  window.scrollTo(0, y);
}

/* ------------------------------- Vistas ------------------------------- */

function emptyLibrary() {
  return `<div class="empty">
    <h2>Tu música, sin conexión</h2>
    <p>Añade las canciones que tienes descargadas en el móvil. Se guardan dentro de la app, así que podrás escucharlas siempre, incluso sin internet.</p>
    <div class="btn-row">
      <button class="btn accent" data-act="import-files">${icon('file')} Añadir canciones</button>
      <button class="btn ghost" data-act="import-folder">${icon('folder')} Elegir carpeta</button>
    </div>
    <p class="hint">Formatos: MP3, M4A/AAC, FLAC, OGG/Opus y WAV (según lo que soporte tu navegador).</p>
  </div>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
}

function viewHome() {
  const hasSongs = lib.songs.size > 0;
  let html = `<header class="page-head">
    <h1>${greeting()}</h1>
    <a class="icon-btn" href="#/stats" aria-label="Tus estadísticas">${icon('stats')}</a>
    <button class="icon-btn" data-act="import-files" aria-label="Añadir canciones">${icon('plus')}</button>
    <a class="icon-btn" href="#/settings" aria-label="Ajustes">${icon('settings')}</a>
  </header>`;
  if (!hasSongs) { view.innerHTML = html + emptyLibrary(); return; }

  // Accesos rápidos: me gusta + recientes
  const quick = [];
  if (lib.liked.size) quick.push(`<a href="#/liked">${likedCover()}<span>Tus me gusta</span></a>`);
  for (const r of lib.recentItems()) {
    if (quick.length >= 8) break;
    const it = resolveItem(r);
    if (it) quick.push(`<a href="${it.href}">${it.cover}<span>${esc(it.name)}</span></a>`);
  }
  for (const a of lib.albums().sort((x, y) => y.addedAt - x.addedAt)) {
    if (quick.length >= 6 && quick.length % 2 === 0) break;
    const href = `#/album/${enc(a.key)}`;
    if (quick.some(q => q.includes(`href="${href}"`))) continue;
    quick.push(`<a href="${href}">${coverImg(lib.coverUrl(a.coverId))}<span>${esc(a.name)}</span></a>`);
  }
  if (quick.length % 2) quick.push(`<a href="#/songs">${gradientCover('cover', '#1e3264', '#477d95', 'note')}<span>Todas las canciones</span></a>`);
  html += `<div class="chips"><a class="chip active" href="#/">Todo</a><a class="chip" href="#/songs">Canciones</a><a class="chip" href="#/library?f=albums">Álbumes</a><a class="chip" href="#/library?f=artists">Artistas</a></div>`;
  html += `<div class="quick">${quick.join('')}</div>`;
  const tot = stats.totals();
  html += `<a class="stat-banner" href="#/stats">${icon('clock')}<div class="txt">
      <div class="t">${tot.week >= 60 ? `Esta semana: ${fmtListen(tot.week)} de música` : 'Tus estadísticas de escucha'}</div>
      <div class="s">${tot.today >= 60 ? `Hoy llevas ${fmtListen(tot.today)}` : tot.count ? 'Horas, tops, rachas y más' : 'Empieza a escuchar y aquí verás tus horas, tops y rachas'}</div>
    </div>${icon('chevron')}</a>`;

  const most = lib.mostPlayed(10);
  if (most.length) {
    html += `<h2 class="section-title">Lo que más escuchas</h2><div class="row">${most.map(s => `
      <button class="card" data-play-one="${s.id}">${coverImg(lib.songCover(s))}<div class="t">${esc(s.title)}</div><div class="s">${esc(s.artist)}</div></button>`).join('')}</div>`;
  }

  const recentAlbums = lib.albums().sort((a, b) => b.addedAt - a.addedAt).slice(0, 12);
  html += `<h2 class="section-title">Añadido recientemente</h2><div class="row">${recentAlbums.map(albumCard).join('')}</div>`;

  const arts = lib.artists().sort((a, b) => b.songs.length - a.songs.length).slice(0, 12);
  html += `<h2 class="section-title">Tus artistas</h2><div class="row">${arts.map(artistCard).join('')}</div>`;

  if (lib.playlists.size) {
    html += `<h2 class="section-title">Tus playlists</h2><div class="row">${[...lib.playlists.values()].map(p => `
      <a class="card" href="#/playlist/${p.id}">${playlistCover(p)}<div class="t">${esc(p.name)}</div><div class="s">${plural(p.songIds.length, 'canción', 'canciones')}</div></a>`).join('')}</div>`;
  }
  view.innerHTML = html;
}

function resolveItem(r) {
  if (r.type === 'album') {
    const a = lib.album(r.id);
    return a && { name: a.name, href: `#/album/${enc(a.key)}`, cover: coverImg(lib.coverUrl(a.coverId)) };
  }
  if (r.type === 'artist') {
    const a = lib.artists().find(x => x.key === r.id);
    return a && { name: a.name, href: `#/artist/${enc(a.key)}`, cover: coverImg(lib.coverUrl(a.coverId), 'cover', a.name) };
  }
  if (r.type === 'playlist') {
    const p = lib.playlists.get(r.id);
    return p && { name: p.name, href: `#/playlist/${p.id}`, cover: playlistCover(p) };
  }
  if (r.type === 'songs') return { name: 'Todas las canciones', href: '#/songs', cover: gradientCover('cover', '#1e3264', '#477d95', 'note') };
  return null;
}

const albumCard = (a) => `<a class="card" href="#/album/${enc(a.key)}">${coverImg(lib.coverUrl(a.coverId), 'cover', a.name)}<div class="t">${esc(a.name)}</div><div class="s">${esc(a.artist)}</div></a>`;
const artistCard = (a) => `<a class="card round" href="#/artist/${enc(a.key)}">${coverImg(lib.coverUrl(a.coverId), 'cover', a.name)}<div class="t">${esc(a.name)}</div><div class="s">Artista</div></a>`;

const GENRE_COLORS = ['#e13300', '#1e3264', '#8400e7', '#e8115b', '#148a08', '#bc5900', '#509bf5', '#477d95', '#af2896', '#503750', '#d84000', '#0d73ec'];

let searchQuery = '';
function viewSearch() {
  view.innerHTML = `<header class="page-head"><h1>Buscar</h1></header>
    <label class="search-box">${icon('search')}<input id="q" type="search" placeholder="¿Qué te apetece escuchar?" autocomplete="off" enterkeyhint="search" value="${esc(searchQuery)}"></label>
    <div id="results"></div>`;
  const input = $('#q');
  input.addEventListener('input', () => { searchQuery = input.value; renderResults(); });
  renderResults();
  if (!searchQuery && lib.songs.size) setTimeout(() => input.focus({ preventScroll: true }), 50);
}

function renderResults() {
  const box = $('#results');
  if (!box) return;
  lists = {};
  if (!lib.songs.size) { box.innerHTML = emptyLibrary(); return; }
  if (!searchQuery.trim()) {
    const gs = lib.genres().slice(0, 24);
    const tiles = [
      `<a class="genre" href="#/songs" style="background:#27856a">Todas las canciones</a>`,
      `<a class="genre" href="#/library?f=albums" style="background:#8d67ab">Álbumes</a>`,
      `<a class="genre" href="#/library?f=artists" style="background:#1e3264">Artistas</a>`,
      ...gs.map((g, i) => {
        const cov = g.songs.map(lib.songCover).find(Boolean);
        return `<a class="genre" href="#/genre/${enc(g.name)}" style="background:${GENRE_COLORS[i % GENRE_COLORS.length]}">${esc(g.name)}${cov ? `<img src="${cov}" alt="">` : ''}</a>`;
      }),
    ];
    box.innerHTML = `<h2 class="section-title">Explorar todo</h2><div class="genres">${tiles.join('')}</div>`;
    return;
  }
  const r = lib.search(searchQuery);
  let html = '';
  if (r.artists.length) html += `<h2 class="section-title">Artistas</h2><div class="row">${r.artists.map(artistCard).join('')}</div>`;
  if (r.songs.length) html += `<h2 class="section-title">Canciones</h2>${songRows(r.songs, { type: 'search', label: `Búsqueda: ${searchQuery}` })}`;
  if (r.albums.length) html += `<h2 class="section-title">Álbumes</h2><div class="row">${r.albums.map(albumCard).join('')}</div>`;
  if (r.playlists.length) html += `<h2 class="section-title">Playlists</h2><div class="list">${r.playlists.map(playlistRow).join('')}</div>`;
  box.innerHTML = html || `<div class="empty"><h2>No hay resultados para «${esc(searchQuery)}»</h2><p>Prueba con otras palabras o revisa la ortografía.</p></div>`;
}

const playlistRow = (p) => `<a class="item" href="#/playlist/${p.id}">${playlistCover(p)}<div class="txt"><div class="t">${esc(p.name)}</div><div class="s">Playlist · ${plural(p.songIds.length, 'canción', 'canciones')}</div></div></a>`;

function viewLibrary() {
  const f = new URLSearchParams(location.hash.split('?')[1] || '').get('f') || '';
  const chip = (k, label) => `<a class="chip${f === k ? ' active' : ''}" href="#/library${k && f !== k ? '?f=' + k : ''}">${label}</a>`;
  let html = `<header class="page-head">
      <div class="avatar">${icon('note')}</div><h1>Tu biblioteca</h1>
      <button class="icon-btn" data-act="new-playlist" aria-label="Crear playlist">${icon('plus')}</button>
    </header>
    <div class="chips">${chip('playlists', 'Playlists')}${chip('albums', 'Álbumes')}${chip('artists', 'Artistas')}</div>`;
  if (!lib.songs.size && !lib.playlists.size) { view.innerHTML = html + emptyLibrary(); return; }

  const rows = [];
  if (!f || f === 'playlists') {
    rows.push(`<a class="item" href="#/liked">${likedCover()}<div class="txt"><div class="t">Tus me gusta</div><div class="s">Playlist · ${plural(lib.liked.size, 'canción', 'canciones')}</div></div></a>`);
    if (!f) rows.push(`<a class="item" href="#/songs">${gradientCover('cover', '#1e3264', '#477d95', 'note')}<div class="txt"><div class="t">Todas las canciones</div><div class="s">${plural(lib.songs.size, 'canción', 'canciones')} en el móvil</div></div></a>`);
    for (const p of [...lib.playlists.values()].sort((a, b) => b.updatedAt - a.updatedAt)) rows.push(playlistRow(p));
    if (f === 'playlists') rows.push(`<button class="item" data-act="new-playlist"><div class="cover" style="display:grid;place-items:center;background:var(--bg-3)">${icon('plus')}</div><div class="txt"><div class="t">Crear playlist</div></div></button>`);
  }
  if (!f || f === 'artists') {
    for (const a of lib.artists()) rows.push(`<a class="item round" href="#/artist/${enc(a.key)}">${coverImg(lib.coverUrl(a.coverId), 'cover', a.name)}<div class="txt"><div class="t">${esc(a.name)}</div><div class="s">Artista · ${plural(a.songs.length, 'canción', 'canciones')}</div></div></a>`);
  }
  if (!f || f === 'albums') {
    for (const a of lib.albums()) rows.push(`<a class="item" href="#/album/${enc(a.key)}">${coverImg(lib.coverUrl(a.coverId), 'cover', a.name)}<div class="txt"><div class="t">${esc(a.name)}</div><div class="s">Álbum · ${esc(a.artist)}</div></div></a>`);
  }
  html += `<div class="list">${rows.join('')}</div>`;
  html += `<div class="btn-row" style="margin-top:24px"><button class="btn small ghost" data-act="import-files">${icon('plus')} Añadir canciones</button></div>`;
  view.innerHTML = html;
}

let songSort = 'title';
function viewSongs() {
  const list = lib.allSongs(songSort);
  const sortLabel = { title: 'Título', artist: 'Artista', recent: 'Añadidas recientemente' }[songSort];
  hero({
    title: 'Todas las canciones',
    cover: gradientCover('hero-cover', '#1e3264', '#477d95', 'note'),
    color: '#1e3264',
    sub: `${plural(list.length, 'canción', 'canciones')} · ${fmtTotal(list)}`,
    ctx: { type: 'songs', id: '', label: 'Todas las canciones', href: '#/songs' },
    ids: list.map(s => s.id),
    extra: `<button class="icon-btn" data-act="sort-songs" aria-label="Ordenar por ${sortLabel}">${icon('sort')}</button>`,
    body: list.length ? songRows(list, { type: 'songs', id: '', label: 'Todas las canciones', href: '#/songs' }) : emptyLibrary(),
  });
}

function viewLiked() {
  const list = lib.likedSongs();
  hero({
    title: 'Tus me gusta',
    cover: likedCover('hero-cover'),
    color: '#4a2fbd',
    sub: plural(list.length, 'canción', 'canciones'),
    ctx: { type: 'liked', id: '', label: 'Tus me gusta', href: '#/liked' },
    ids: list.map(s => s.id),
    body: list.length
      ? songRows(list, { type: 'liked', id: '', label: 'Tus me gusta', href: '#/liked' }, { hideLike: true })
      : `<div class="empty"><h2>Las canciones que te gustan aparecerán aquí</h2><p>Toca el corazón ${icon('heart')} en cualquier canción para guardarla.</p></div>`,
  });
}

function viewAlbum(key) {
  const a = lib.album(key);
  if (!a) return notFound();
  const ctx = { type: 'album', id: a.key, label: a.name, href: `#/album/${enc(a.key)}` };
  hero({
    title: a.name,
    cover: coverImg(lib.coverUrl(a.coverId), 'hero-cover', a.name),
    coverUrl: lib.coverUrl(a.coverId),
    owner: `<a href="#/artist/${enc(a.artist.toLowerCase())}">${esc(a.artist)}</a>`,
    sub: `Álbum${a.year ? ' · ' + a.year : ''} · ${plural(a.songs.length, 'canción', 'canciones')}, ${fmtTotal(a.songs)}`,
    ctx, ids: a.songs.map(s => s.id),
    body: songRows(a.songs, ctx, { numbers: true }),
  });
}

function viewArtist(key) {
  const a = lib.artist(key);
  if (!a) {
    // Puede ser un "artista del álbum" que no coincide con ningún artista de pista
    const als = lib.albums().filter(al => al.artist.toLowerCase() === key);
    if (!als.length) return notFound();
    const songs = als.flatMap(al => al.songs);
    return viewArtistData({ key, name: als[0].artist, songs, coverId: als[0].coverId, albumList: als });
  }
  viewArtistData(a);
}

function viewArtistData(a) {
  const ctx = { type: 'artist', id: a.key, label: a.name, href: `#/artist/${enc(a.key)}` };
  const popular = a.songs.slice(0, 10);
  let body = `<h2 class="section-title">Canciones</h2>${songRows(a.songs.length > 10 ? popular : a.songs, ctx, { hideAlbum: false })}`;
  if (a.songs.length > 10) {
    body += `<details><summary class="btn small ghost" style="margin:12px 0">Ver las ${a.songs.length}</summary>${songRows(a.songs.slice(10), ctx)}</details>`;
  }
  if (a.albumList?.length) body += `<h2 class="section-title">Discografía</h2><div class="row">${a.albumList.map(albumCard).join('')}</div>`;
  hero({
    title: a.name, round: true,
    cover: coverImg(lib.coverUrl(a.coverId), 'hero-cover', a.name),
    coverUrl: lib.coverUrl(a.coverId),
    sub: `${plural(a.songs.length, 'canción', 'canciones')} · ${plural(a.albumList?.length || 0, 'álbum', 'álbumes')}`,
    ctx, ids: a.songs.map(s => s.id), body,
  });
}

function viewPlaylist(id) {
  const p = lib.playlists.get(id);
  if (!p) return notFound();
  const list = lib.playlistSongs(p);
  const ctx = { type: 'playlist', id: p.id, label: p.name, href: `#/playlist/${p.id}` };
  const firstCover = list.map(lib.songCover).find(Boolean);
  hero({
    title: p.name,
    cover: playlistCover(p, 'hero-cover'),
    coverUrl: firstCover,
    sub: list.length ? `${plural(list.length, 'canción', 'canciones')} · ${fmtTotal(list)}` : 'Playlist vacía',
    ctx, ids: list.map(s => s.id),
    extra: `<button class="icon-btn" data-act="playlist-menu" data-id="${p.id}" aria-label="Opciones de la playlist">${icon('more')}</button>`,
    body: list.length
      ? songRows(list, { ...ctx, playlistId: p.id })
      : `<div class="empty"><h2>Vamos a llenar esta playlist</h2><p>Usa el menú ${icon('moreV')} de cualquier canción y elige «Añadir a playlist».</p><button class="btn" data-act="add-songs-to" data-id="${p.id}">Añadir canciones</button></div>`,
  });
}

function viewGenre(name) {
  const g = lib.genres().find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!g) return notFound();
  const ctx = { type: 'genre', id: g.name, label: g.name, href: `#/genre/${enc(g.name)}` };
  hero({
    title: g.name,
    cover: gradientCover('hero-cover', '#8400e7', '#e8115b', 'note'),
    color: '#8400e7',
    sub: plural(g.songs.length, 'canción', 'canciones'),
    ctx, ids: g.songs.map(s => s.id),
    body: songRows(g.songs.sort((a, b) => lib.cmp(a.artist, b.artist)), ctx),
  });
}

async function viewSettings() {
  const info = await lib.storageInfo();
  const pct = info.quota ? Math.min(100, (info.bytes / info.quota) * 100) : 0;
  view.innerHTML = `<header class="page-head">
      <a class="icon-btn" href="#/" aria-label="Volver">${icon('back')}</a><h1>Ajustes</h1></header>
    <div class="list">
      <button class="item" data-act="import-files">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'file')}<div class="txt"><div class="t">Añadir canciones</div><div class="s">Elige archivos de audio del móvil</div></div></button>
      <button class="item" data-act="import-folder">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'folder')}<div class="txt"><div class="t">Añadir una carpeta</div><div class="s">Importa todas las canciones de una carpeta</div></div></button>
      <button class="item" data-act="install">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'download')}<div class="txt"><div class="t">Instalar la app</div><div class="s">Añádela a tu pantalla de inicio</div></div></button>
      <button class="item" data-act="toggle-autoplay">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'playNext')}<div class="txt"><div class="t">Reproducción automática</div><div class="s">Al acabar la lista, seguir con otras canciones de tu biblioteca</div></div><span class="chip${player.state.autoplay ? ' active' : ''}">${player.state.autoplay ? 'Activada' : 'Desactivada'}</span></button>
      <a class="item" href="#/stats">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'stats')}<div class="txt"><div class="t">Tus estadísticas</div><div class="s">Horas de escucha, tops y rachas</div></div></a>
      <button class="item" data-act="export">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'save')}<div class="txt"><div class="t">Guardar copia de seguridad</div><div class="s">Estadísticas, me gusta y playlists en un archivo</div></div></button>
      <button class="item" data-act="import-backup">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'upload')}<div class="txt"><div class="t">Restaurar copia de seguridad</div><div class="s">Recupera tus datos en este u otro móvil</div></div></button>
      <button class="item" data-act="clear-stats">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'trash')}<div class="txt"><div class="t" style="color:var(--danger)">Borrar estadísticas</div><div class="s">Elimina el historial de escucha</div></div></button>
      <button class="item" data-act="wipe">${gradientCover('cover', '#2a2a2a', '#2a2a2a', 'trash')}<div class="txt"><div class="t" style="color:var(--danger)">Borrar toda la biblioteca</div><div class="s">Elimina canciones, playlists y me gusta de esta app</div></div></button>
    </div>
    <div class="storage">
      ${plural(lib.songs.size, 'canción', 'canciones')} · ${fmtBytes(info.bytes)} usados${info.quota ? ` de ${fmtBytes(info.quota)} disponibles` : ''}
      <div class="bar"><div style="width:${pct.toFixed(1)}%"></div></div>
      <p>Las canciones se guardan dentro de la app; los archivos originales del móvil no se tocan.</p>
    </div>`;
}

/* ---------------------------- Estadísticas ---------------------------- */

let statsPeriod = '7d';
const PERIODS = [['7d', '7 días'], ['30d', '30 días'], ['year', 'Este año'], ['all', 'Siempre']];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function bucketLabel(b, short) {
  const d = new Date(b.t);
  if (b.kind === 'month') return short ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return short ? (statsPeriod === '7d' ? WEEKDAYS[d.getDay()] : String(d.getDate()))
    : d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
}

function dayName(t) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(new Date(t).setHours(0, 0, 0, 0))) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  const txt = new Date(t).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function partOfDay(hours) {
  const max = Math.max(...hours);
  if (!max) return '';
  const h = hours.indexOf(max);
  const when = h < 6 ? 'de madrugada' : h < 12 ? 'por la mañana' : h < 20 ? 'por la tarde' : 'por la noche';
  return `Escuchas sobre todo ${when} (hacia las ${h}:00)`;
}

function chart(buckets, cls, labelEvery) {
  const max = Math.max(...buckets.map(b => b.seconds), 1);
  return `<div class="chart ${cls}">${buckets.map((b, i) => `<button class="${b.seconds ? '' : 'zero'}" data-bar="${i}" aria-label="${esc(b.label)}: ${fmtListen(b.seconds)}"><i style="height:${Math.max(1.5, (b.seconds / max) * 100).toFixed(1)}%"></i></button>`).join('')}</div>
    <div class="chart-x">${buckets.map((b, i) => `<span>${i % labelEvery === 0 ? esc(b.short) : ''}</span>`).join('')}</div>`;
}

function viewStats() {
  const st = stats.compute(statsPeriod);
  const chips = PERIODS.map(([k, l]) => `<button class="chip${k === statsPeriod ? ' active' : ''}" data-act="stats-period" data-p="${k}">${l}</button>`).join('');
  let html = `<header class="page-head"><a class="icon-btn" href="#/" aria-label="Volver">${icon('back')}</a><h1>Tus estadísticas</h1></header>
    <div class="chips">${chips}</div>`;

  if (st.empty) {
    html += `<div class="empty"><h2>${statsPeriod === 'all' ? 'Aún no hay escuchas' : 'Sin escuchas en este periodo'}</h2>
      <p>Cada canción que escuches se apunta aquí: tiempo escuchado, tus canciones y artistas favoritos, a qué horas escuchas y tus rachas. Todo se guarda sólo en tu móvil.</p>
      ${lib.songs.size ? '' : '<button class="btn accent" data-act="import-files">Añadir canciones</button>'}</div>`;
    view.innerHTML = html;
    return;
  }

  const h = Math.floor(st.total / 3600), m = Math.floor((st.total % 3600) / 60);
  html += `<section class="stat-hero">
      <small>Tiempo escuchado</small>
      <div class="big">${h ? `${h}<span>h</span>` : ''}${m}<span>min</span></div>
      <div class="sub">Media de ${fmtListen(st.avgPerDay)} al día · ${plural(st.activeDays, 'día', 'días')} con música${st.bestDay ? ` · Tu mejor día: ${esc(dayName(new Date(st.bestDay.key + 'T12:00:00').getTime()).toLowerCase())} (${fmtListen(st.bestDay.seconds)})` : ''}</div>
    </section>
    <div class="tiles">
      <div class="tile"><div class="v">${st.plays}</div><div class="l">Reproducciones</div></div>
      <div class="tile"><div class="v">${st.songs}</div><div class="l">Canciones distintas</div></div>
      <div class="tile"><div class="v">${st.artists}</div><div class="l">Artistas</div></div>
      <div class="tile"><div class="v">${icon('fire')}${st.streak}</div><div class="l">${st.streak === 1 ? 'Día seguido' : 'Días seguidos'} · récord ${st.bestStreak}</div></div>
    </div>`;

  const buckets = st.buckets.map(b => ({ ...b, label: bucketLabel(b, false), short: bucketLabel(b, true) }));
  const every = buckets.length > 14 ? Math.ceil(buckets.length / 8) : 1;
  html += `<section class="panel"><h2>${buckets[0]?.kind === 'month' ? 'Tiempo por mes' : 'Tiempo por día'}</h2>
    <div class="cap" id="cap-main">Toca una barra para ver el detalle</div>${chart(buckets, 'main', every)}</section>`;

  const hours = st.hours.map((s, i) => ({ seconds: s, label: `${i}:00–${i}:59`, short: String(i) }));
  html += `<section class="panel"><h2>¿Cuándo escuchas?</h2>
    <div class="cap" id="cap-hours">${partOfDay(st.hours)}</div>${chart(hours, 'hours', 6)}</section>`;

  const statRow = (i, cover, title, sub, meta, attrs = '') => `<div class="item"${attrs}><span class="rank">${i + 1}</span>${cover}<div class="txt"><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div><div class="meta">${meta}</div></div>`;
  html += `<h2 class="section-title">Canciones más escuchadas</h2><div class="list">${st.topSongs.slice(0, 10).map((s, i) =>
    statRow(i, coverImg(lib.coverUrl(s.coverId)), s.title, s.artist, `${fmtListen(s.seconds)}<br>${plural(s.plays, 'vez', 'veces')}`, s.songId ? ` data-stat-song="${s.songId}" role="button" tabindex="0"` : '')).join('')}</div>`;
  html += `<h2 class="section-title">Artistas más escuchados</h2><div class="list">${st.topArtists.slice(0, 10).map((a, i) =>
    `<a class="item round" href="#/artist/${enc(a.key)}"><span class="rank">${i + 1}</span>${coverImg(lib.coverUrl(a.coverId), 'cover', a.name)}<div class="txt"><div class="t">${esc(a.name)}</div><div class="s">${plural(a.plays, 'reproducción', 'reproducciones')}</div></div><div class="meta">${fmtListen(a.seconds)}</div></a>`).join('')}</div>`;
  html += `<h2 class="section-title">Álbumes más escuchados</h2><div class="row">${st.topAlbums.slice(0, 10).map(a =>
    `<a class="card" href="#/album/${enc(a.key)}">${coverImg(lib.coverUrl(a.coverId), 'cover', a.name)}<div class="t">${esc(a.name)}</div><div class="s">${esc(a.artist)} · ${fmtListen(a.seconds)}</div></a>`).join('')}</div>`;

  // Historial reciente agrupado por día
  let lastDay = '';
  const rec = stats.recent(40).map(r => {
    const d = stats.dayKey(r.start);
    const head = d !== lastDay ? `<div class="hist-day">${esc(dayName(r.start))}</div>` : '';
    lastDay = d;
    const time = new Date(r.start).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const id = lib.songs.has(r.songId) ? r.songId : null;
    return `${head}<div class="item"${id ? ` data-stat-song="${id}" role="button" tabindex="0"` : ''}>${coverImg(lib.coverUrl(r.coverId))}<div class="txt"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.artist)}</div></div><div class="meta">${time}<br>${fmtListen(r.seconds)}</div></div>`;
  }).join('');
  html += `<h2 class="section-title">Escuchado recientemente</h2><div class="list">${rec}</div>
    <div class="btn-row" style="margin-top:24px">
      <button class="btn small ghost" data-act="export">${icon('save')} Guardar copia</button>
      <button class="btn small ghost" data-act="import-backup">${icon('upload')} Restaurar copia</button>
    </div>
    <p class="hint" style="text-align:center">Tus estadísticas se guardan sólo en este móvil. Guarda una copia si vas a cambiar de móvil o borrar la app.</p>`;
  view.innerHTML = html;

  // Detalle al tocar una barra
  view.querySelectorAll('.chart').forEach(ch => {
    const isHours = ch.classList.contains('hours');
    const data = isHours ? hours : buckets;
    const cap = $(isHours ? '#cap-hours' : '#cap-main');
    ch.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bar]');
      if (!b) return;
      ch.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      const d = data[+b.dataset.bar];
      cap.textContent = `${d.label.charAt(0).toUpperCase() + d.label.slice(1)}: ${d.seconds ? fmtListen(d.seconds) : 'sin música'}`;
    });
  });
}

async function exportBackup() {
  const blob = await stats.exportData();
  const name = `localmusic-copia-${stats.dayKey(Date.now())}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  // En el móvil, compartir permite guardarla en Drive, Archivos, enviarla por WhatsApp...
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Copia de LocalMusic' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Copia guardada en Descargas');
}

$('#backup-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = await stats.importData(f);
    toast(`Restaurado: ${plural(r.added, 'escucha', 'escuchas')}, ${plural(r.likes, 'me gusta', 'me gusta')}, ${plural(r.lists, 'playlist', 'playlists')}`, 4000);
    rerender();
  } catch (err) {
    toast(err.message || 'No se pudo leer la copia', 4000);
  }
});

function notFound() {
  view.innerHTML = `<div class="empty"><h2>No encontrado</h2><p>Puede que lo hayas borrado de tu biblioteca.</p><a class="btn" href="#/">Ir al inicio</a></div>`;
}

function hero(o) {
  view.classList.add('has-hero');
  const key = ctxKey(o.ctx);
  lists.hero = { ids: o.ids, ctx: o.ctx };
  const on = isCtxPlaying(key);
  view.innerHTML = `<section class="hero${o.round ? ' round' : ''}">
      <button class="icon-btn back" data-act="back" aria-label="Volver">${icon('back')}</button>
      ${o.cover}
      <div>
        <h1>${esc(o.title)}</h1>
        ${o.owner ? `<div class="owner">${o.owner}</div>` : ''}
        <div class="sub">${o.sub}</div>
      </div>
    </section>
    <div class="actions">
      ${o.extra || ''}
      <span class="grow"></span>
      ${o.ids.length ? `<button class="icon-btn${player.state.shuffle ? ' on' : ''}" data-act="hero-shuffle" aria-label="Aleatorio">${icon('shuffle')}</button>
      <button class="play-btn" data-playctx="${esc(key)}" data-act="hero-play" aria-label="${on ? 'Pausar' : 'Reproducir'}">${icon(on ? 'pause' : 'play')}</button>` : ''}
    </div>
    ${o.body}`;
  const setColor = (c) => document.documentElement.style.setProperty('--hero', c);
  if (o.color) setColor(o.color);
  else averageColor(o.coverUrl).then(c => { if (c && lastHash === (location.hash.slice(1) || '/')) setColor(c); });
}

/* --------------------------- Hoja de acciones --------------------------- */

const sheet = $('#sheet');
const backdrop = $('#sheet-backdrop');
let sheetHandlers = {};

function openSheet(html, handlers = {}) {
  sheetHandlers = handlers;
  sheet.innerHTML = `<div class="grab"></div>${html}`;
  sheet.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  if (!history.state?.sheet) history.pushState({ sheet: true }, '');
  const first = sheet.querySelector('input,button');
  if (first?.tagName === 'INPUT') setTimeout(() => first.focus(), 60);
}
const sheetOpen = () => !sheet.classList.contains('hidden');
function hideSheet() {
  sheet.classList.add('hidden');
  backdrop.classList.add('hidden');
  sheet.innerHTML = '';
}
function closeSheet(fromPop = false) {
  if (!sheetOpen()) return;
  hideSheet();
  if (!fromPop && history.state?.sheet) history.back();
}
// Ejecuta la acción elegida; si no abrió otra hoja ni navegó, retira la entrada del historial.
async function runSheetAction(fn, arg) {
  hideSheet();
  if (fn) await fn(arg);
  if (!sheetOpen() && history.state?.sheet && !navigating) history.back();
}
backdrop.addEventListener('click', () => closeSheet());
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-opt]');
  if (b) runSheetAction(sheetHandlers[b.dataset.opt], b);
});
sheet.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const vals = {};
  form.querySelectorAll('input').forEach((i, n) => { vals[i.dataset.k || n] = i.value; });
  runSheetAction(sheetHandlers.submit, form.querySelector('input')?.dataset.k ? vals : (vals[0] ?? ''));
});

// Navega cerrando hojas y reproductor; reemplaza su entrada de historial para no dejar «huecos».
let navigating = false;
function go(href) {
  const overlay = history.state?.sheet || history.state?.player;
  hideSheet();
  closePlayer(true);
  navigating = true;
  if (overlay) location.replace(href); else location.hash = href;
  setTimeout(() => { navigating = false; }, 0);
}

const opt = (k, ic, label, cls = '') => `<button class="opt ${cls}" data-opt="${k}">${icon(ic)}${label}</button>`;

function songMenu(id, listInfo) {
  const s = lib.songs.get(id);
  if (!s) return;
  const isLiked = lib.liked.has(id);
  const inPlaylist = listInfo?.ctx?.playlistId;
  const inQueue = listInfo?.queueIndex !== undefined;
  openSheet(`
    <div class="sheet-head">${coverImg(lib.songCover(s))}<div class="txt"><h3>${esc(s.title)}</h3><div class="s" style="color:var(--muted)">${esc(s.artist)}</div></div></div>
    ${opt('like', isLiked ? 'heartFill' : 'heart', isLiked ? 'Quitar de Tus me gusta' : 'Añadir a Tus me gusta')}
    ${opt('playlist', 'plus', 'Añadir a playlist')}
    ${inPlaylist ? opt('unlist', 'remove', 'Quitar de esta playlist') : ''}
    ${inQueue ? opt('dequeue', 'remove', 'Quitar de la cola') : opt('next', 'playNext', 'Reproducir a continuación') + opt('queue', 'addQueue', 'Añadir a la cola')}
    ${opt('album', 'album', 'Ir al álbum')}
    ${opt('artist', 'artist', 'Ir al artista')}
    ${opt('edit', 'edit', 'Editar información')}
    ${opt('delete', 'trash', 'Eliminar de la biblioteca', 'danger')}
  `, {
    like: async () => toast((await lib.toggleLike(id)) ? 'Añadida a Tus me gusta' : 'Quitada de Tus me gusta'),
    playlist: () => pickPlaylist([id]),
    unlist: async () => { await lib.removeFromPlaylist(inPlaylist, listInfo.index); toast('Quitada de la playlist'); },
    dequeue: () => { player.removeFromQueue(listInfo.queueIndex); showQueue(); },
    next: () => { player.playNext([id]); toast('Se reproducirá a continuación'); },
    queue: () => { player.addToQueue([id]); toast('Añadida a la cola'); },
    album: () => go(`#/album/${enc(lib.albumKey(s))}`),
    artist: () => go(`#/artist/${enc(s.artist.toLowerCase())}`),
    edit: () => editSong(id),
    delete: () => confirmDelete([id], `«${s.title}»`),
  });
}

function pickPlaylist(songIds) {
  const pls = [...lib.playlists.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const handlers = { new: () => askName('Nueva playlist', '', async (name) => {
    const p = await lib.createPlaylist(name, songIds);
    toast(`Añadida a ${p.name}`);
  }) };
  pls.forEach(p => { handlers['p' + p.id] = async () => {
    const n = await lib.addToPlaylist(p.id, songIds);
    toast(n ? `Añadida a ${p.name}` : `Ya estaba en ${p.name}`);
  }; });
  openSheet(`<h3 style="margin-bottom:8px">Añadir a playlist</h3>
    ${opt('new', 'plus', 'Nueva playlist')}
    ${pls.map(p => `<button class="opt" data-opt="p${p.id}">${playlistCover(p).replace('class="cover', 'style="width:40px;height:40px;border-radius:4px;flex:none" class="cover')}${esc(p.name)}</button>`).join('')}`, handlers);
}

function askName(title, value, cb) {
  openSheet(`<form><h3>${esc(title)}</h3>
    <input class="field" name="n" value="${esc(value)}" maxlength="100" placeholder="Nombre" autocomplete="off">
    <div class="btn-row"><button type="button" class="btn ghost small" data-opt="cancel">Cancelar</button><button class="btn accent small" type="submit">Guardar</button></div></form>`,
  { submit: cb });
}

function editSong(id) {
  const s = lib.songs.get(id);
  const f = (k, label) => `<label style="font-size:13px;color:var(--muted)">${label}<input class="field" data-k="${k}" value="${esc(s[k] || '')}" style="margin:4px 0 10px"></label>`;
  openSheet(`<form><h3 style="margin-bottom:12px">Editar información</h3>
    ${f('title', 'Título')}${f('artist', 'Artista')}${f('album', 'Álbum')}${f('albumArtist', 'Artista del álbum')}${f('genre', 'Género')}
    <div class="btn-row"><button type="button" class="btn ghost small" data-opt="cancel">Cancelar</button><button class="btn accent small" type="submit">Guardar</button></div></form>`, {
    submit: async (vals) => {
      for (const k in vals) vals[k] = vals[k].trim();
      vals.title ||= s.title;
      vals.artist ||= 'Artista desconocido';
      vals.album ||= 'Álbum desconocido';
      await lib.updateSong(id, vals);
      toast('Cambios guardados');
    },
  });
}

function confirmDelete(ids, what) {
  openSheet(`<h3>¿Eliminar ${what} de la biblioteca?</h3>
    <p style="color:var(--muted);font-size:14px">Se borrará de esta app. El archivo original de tu móvil no se modifica.</p>
    ${opt('yes', 'trash', 'Eliminar', 'danger')}${opt('no', 'close', 'Cancelar')}`, {
    yes: async () => { await lib.removeSongs(ids); player.purge(); toast('Eliminada de la biblioteca'); },
  });
}

function playlistMenu(id) {
  const p = lib.playlists.get(id);
  if (!p) return;
  openSheet(`<div class="sheet-head">${playlistCover(p)}<h3>${esc(p.name)}</h3></div>
    ${opt('add', 'plus', 'Añadir canciones')}
    ${p.songIds.length ? opt('queue', 'addQueue', 'Añadir a la cola') : ''}
    ${opt('rename', 'edit', 'Cambiar nombre')}
    ${opt('delete', 'trash', 'Eliminar playlist', 'danger')}`, {
    add: () => addSongsTo(id),
    queue: () => { player.addToQueue(lib.playlistSongs(p).map(s => s.id)); toast('Añadida a la cola'); },
    rename: () => askName('Cambiar nombre', p.name, (n) => lib.renamePlaylist(id, n)),
    delete: () => openSheet(`<h3>¿Eliminar «${esc(p.name)}»?</h3><p style="color:var(--muted);font-size:14px">Las canciones seguirán en tu biblioteca.</p>${opt('yes', 'trash', 'Eliminar', 'danger')}${opt('no', 'close', 'Cancelar')}`, {
      yes: async () => { await lib.deletePlaylist(id); go('#/library'); toast('Playlist eliminada'); },
    }),
  });
}

function addSongsTo(playlistId) {
  const p = lib.playlists.get(playlistId);
  const inside = new Set(p.songIds);
  const all = lib.allSongs();
  openSheet(`<h3 style="margin-bottom:8px">Añadir a «${esc(p.name)}»</h3>
    <input class="field" id="pick-q" type="search" placeholder="Buscar en tu biblioteca" autocomplete="off">
    <div id="pick-list"></div>
    <div class="btn-row" style="position:sticky;bottom:0;padding-top:8px;background:var(--bg-3)"><button class="btn accent small" data-opt="done">Hecho</button></div>`, {});
  const box = $('#pick-list');
  const draw = (q) => {
    const n = q.trim().toLowerCase();
    const list = (n ? all.filter(s => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(n)) : all).slice(0, 200);
    box.innerHTML = list.map(s => `<div class="item">${coverImg(lib.songCover(s))}<div class="txt"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.artist)}</div></div>
      <button class="icon-btn${inside.has(s.id) ? ' on' : ''}" data-pick="${s.id}" aria-label="${inside.has(s.id) ? 'Ya añadida' : 'Añadir'}">${icon(inside.has(s.id) ? 'heartFill' : 'plus')}</button></div>`).join('');
  };
  draw('');
  $('#pick-q').addEventListener('input', (e) => draw(e.target.value));
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b || inside.has(b.dataset.pick)) return;
    inside.add(b.dataset.pick);
    b.classList.add('on');
    b.innerHTML = icon('heartFill');
    await lib.addToPlaylist(playlistId, [b.dataset.pick]);
  });
}

function showQueue() {
  const st = player.state;
  const cur = player.current();
  const upcoming = st.queue.slice(st.index + 1).map((id, i) => ({ s: lib.songs.get(id), qi: st.index + 1 + i })).filter(x => x.s);
  const row = ({ s, qi }) => `<div class="item" data-qi="${qi}" role="button" tabindex="0">${coverImg(lib.songCover(s))}<div class="txt"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.artist)}</div></div><button class="icon-btn more" data-qmore="${qi}" aria-label="Opciones">${icon('moreV')}</button></div>`;
  openSheet(`<h3>Cola</h3>
    ${cur ? `<div class="queue-label">Reproduciendo ahora</div><div class="item playing">${coverImg(lib.songCover(cur))}<div class="txt"><div class="t">${esc(cur.title)}</div><div class="s">${esc(cur.artist)}</div></div></div>` : ''}
    <div class="queue-label">A continuación${st.context?.label ? ` de: ${esc(st.context.label)}` : ''}</div>
    <div class="list" id="queue-list">${upcoming.map(row).join('') || '<p style="color:var(--muted)">No hay más canciones en la cola.</p>'}</div>`, {});
  $('#queue-list').addEventListener('click', (e) => {
    const m = e.target.closest('[data-qmore]');
    if (m) { const qi = +m.dataset.qmore; songMenu(st.queue[qi], { queueIndex: qi }); return; }
    const it = e.target.closest('[data-qi]');
    if (it) { player.jumpTo(+it.dataset.qi); closeSheet(); }
  });
}

/* ------------------------------ Importar ------------------------------ */

async function doImport(files) {
  if (!files?.length) return;
  const t = $('#toast');
  const res = await lib.importFiles(files, (i, n, name) => {
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    t.textContent = n ? `Importando ${Math.min(i + 1, n)} de ${n}… ${name}` : '';
  });
  const parts = [];
  if (res.added) parts.push(`${plural(res.added, 'canción añadida', 'canciones añadidas')}`);
  if (res.skipped) parts.push(`${res.skipped} ya estaban`);
  if (res.unsupported) parts.push(`${res.unsupported} en formato no compatible`);
  if (res.failed) parts.push(`${res.failed} con error`);
  if (res.quota) parts.push('no queda espacio');
  if (!res.total) parts.push('No se encontraron archivos de audio');
  toast(parts.join(' · '), 4000);
}

$('#file-input').addEventListener('change', (e) => { doImport(e.target.files); e.target.value = ''; });
$('#folder-input').addEventListener('change', (e) => { doImport(e.target.files); e.target.value = ''; });

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

/* ------------------------------ Clicks ------------------------------ */

document.addEventListener('click', async (e) => {
  const t = e.target;
  const act = t.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'import-files') return $('#file-input').click();
    if (a === 'import-folder') return $('#folder-input').click();
    if (a === 'back') return history.length > 1 ? history.back() : (location.hash = '#/');
    if (a === 'new-playlist') return askName('Ponle nombre a tu playlist', `Mi playlist n.º ${lib.playlists.size + 1}`, async (n) => {
      const p = await lib.createPlaylist(n);
      go(`#/playlist/${p.id}`);
    });
    if (a === 'playlist-menu') return playlistMenu(act.dataset.id);
    if (a === 'add-songs-to') return addSongsTo(act.dataset.id);
    if (a === 'sort-songs') {
      return openSheet(`<h3 style="margin-bottom:8px">Ordenar por</h3>${opt('title', 'sort', 'Título')}${opt('artist', 'artist', 'Artista')}${opt('recent', 'plus', 'Añadidas recientemente')}`, {
        title: () => { songSort = 'title'; rerender(); }, artist: () => { songSort = 'artist'; rerender(); }, recent: () => { songSort = 'recent'; rerender(); },
      });
    }
    if (a === 'hero-play' || a === 'hero-shuffle') {
      const h = lists.hero;
      if (!h?.ids.length) return;
      if (a === 'hero-play' && ctxKey(player.state.context) === ctxKey(h.ctx) && player.current()) return player.toggle();
      if (a === 'hero-shuffle') {
        if (player.current()) player.toggleShuffle(); else player.state.shuffle = !player.state.shuffle;
        act.classList.toggle('on', player.state.shuffle);
        return;
      }
      return player.playList(h.ids, player.state.shuffle ? -1 : 0, h.ctx);
    }
    if (a === 'install') {
      if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
      return openSheet(`<h3>Instalar LocalMusic</h3><p style="color:var(--muted)">
        <b>Android (Chrome):</b> menú ⋮ → «Añadir a pantalla de inicio» o «Instalar aplicación».<br><br>
        <b>iPhone (Safari):</b> botón Compartir → «Añadir a pantalla de inicio».</p>${opt('ok', 'close', 'Entendido')}`);
    }
    if (a === 'stats-period') { statsPeriod = act.dataset.p; return rerender(); }
    if (a === 'toggle-autoplay') {
      player.setAutoplay(!player.state.autoplay);
      toast(player.state.autoplay ? 'Al acabar la lista seguirá sonando música' : 'La música se parará al acabar la lista');
      return rerender();
    }
    if (a === 'export') return exportBackup();
    if (a === 'import-backup') return $('#backup-input').click();
    if (a === 'clear-stats') {
      return openSheet(`<h3>¿Borrar las estadísticas?</h3><p style="color:var(--muted);font-size:14px">Se eliminará todo tu historial de escucha. Tus canciones, playlists y me gusta no se tocan.</p>${opt('yes', 'trash', 'Borrar estadísticas', 'danger')}${opt('no', 'close', 'Cancelar')}`, {
        yes: async () => { await stats.clearHistory(); toast('Estadísticas borradas'); rerender(); },
      });
    }
    if (a === 'wipe') {
      return openSheet(`<h3>¿Borrar toda la biblioteca?</h3><p style="color:var(--muted);font-size:14px">Se eliminarán todas las canciones, playlists y me gusta de la app. Los archivos de tu móvil no se tocan.</p>${opt('yes', 'trash', 'Borrar todo', 'danger')}${opt('no', 'close', 'Cancelar')}`, {
        yes: async () => { player.pause(); await lib.wipe(); player.purge(); toast('Biblioteca borrada'); go('#/'); },
      });
    }
  }

  const more = t.closest('[data-more]');
  if (more) {
    const listEl = more.closest('[data-list]');
    const info = listEl ? lists[listEl.dataset.list] : null;
    return songMenu(more.dataset.more, info ? { ctx: info.ctx, index: +more.dataset.i } : null);
  }

  const statSong = t.closest('[data-stat-song]');
  if (statSong) {
    const ids = [...view.querySelectorAll('[data-stat-song]')].map(el => el.dataset.statSong).filter((v, i, a) => a.indexOf(v) === i);
    return player.playList(ids, ids.indexOf(statSong.dataset.statSong), { type: 'stats', id: '', label: 'Tus estadísticas', href: '#/stats' });
  }

  const one = t.closest('[data-play-one]');
  if (one) {
    const most = lib.mostPlayed(10).map(s => s.id);
    return player.playList(most, most.indexOf(one.dataset.playOne), { type: 'most', label: 'Lo que más escuchas' });
  }

  const item = t.closest('.item[data-song]');
  if (item) {
    const listEl = item.closest('[data-list]');
    const info = lists[listEl?.dataset.list];
    if (!info) return;
    const i = +item.dataset.i;
    if (player.current()?.id === item.dataset.song && ctxKey(player.state.context) === ctxKey(info.ctx)) return openPlayer();
    return player.playList(info.ids, i, info.ctx, { shuffle: false });
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.item[role=button]')) e.target.click();
  if (e.key === 'Escape') { if (sheetOpen()) closeSheet(); else closePlayer(); }
  if (e.key === ' ' && !e.target.matches('input, textarea, button, [role=button]')) { e.preventDefault(); player.toggle(); }
});

window.addEventListener('popstate', () => {
  if (sheetOpen() && !history.state?.sheet) closeSheet(true);
  else if ($('#player').classList.contains('open') && !history.state?.player && !history.state?.sheet) closePlayer(true);
});

/* ------------------------------ Reproductor ------------------------------ */

const P = {
  mini: $('#mini'), miniCover: $('#mini-cover'), miniTitle: $('#mini-title'), miniArtist: $('#mini-artist'),
  miniPlay: $('#mini-play'), miniLike: $('#mini-like'), miniBar: $('#mini-bar'),
  player: $('#player'), cover: $('#player-cover'), title: $('#player-title'), artist: $('#player-artist'),
  from: $('#player-from'), like: $('#player-like'), seek: $('#seek'), cur: $('#t-cur'), dur: $('#t-dur'),
  play: $('#btn-play'), shuffle: $('#btn-shuffle'), repeat: $('#btn-repeat'),
};

$('#player-close').innerHTML = icon('down');
$('#player-more').innerHTML = icon('moreV');
$('#btn-prev').innerHTML = icon('prev');
$('#btn-next').innerHTML = icon('next');
$('#btn-queue').innerHTML = icon('queue');
P.shuffle.innerHTML = icon('shuffle');
P.repeat.innerHTML = icon('repeat');
document.querySelectorAll('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon); });

function openPlayer() {
  if (!player.current()) return;
  P.player.classList.add('open');
  P.player.setAttribute('aria-hidden', 'false');
  history.pushState({ player: true }, '');
}
function closePlayer(fromPop = false) {
  if (!P.player.classList.contains('open')) return;
  P.player.classList.remove('open');
  P.player.setAttribute('aria-hidden', 'true');
  if (!fromPop && history.state?.player) history.back();
}

$('#mini-open').addEventListener('click', openPlayer);
$('#player-close').addEventListener('click', () => closePlayer());
P.miniPlay.addEventListener('click', player.toggle);
P.play.addEventListener('click', player.toggle);
$('#btn-prev').addEventListener('click', player.prev);
$('#btn-next').addEventListener('click', () => player.next());
P.shuffle.addEventListener('click', player.toggleShuffle);
P.repeat.addEventListener('click', player.cycleRepeat);
$('#btn-queue').addEventListener('click', showQueue);
$('#player-more').addEventListener('click', () => { const s = player.current(); if (s) songMenu(s.id); });
const likeCurrent = async () => {
  const s = player.current();
  if (!s) return;
  toast((await lib.toggleLike(s.id)) ? 'Añadida a Tus me gusta' : 'Quitada de Tus me gusta');
};
P.like.addEventListener('click', likeCurrent);
P.miniLike.addEventListener('click', likeCurrent);
P.artist.addEventListener('click', () => {
  const s = player.current();
  if (s) go(`#/artist/${enc(s.artist.toLowerCase())}`);
});
P.from.parentElement.addEventListener('click', () => {
  const href = player.state.context?.href;
  if (href) go(href);
});

// Deslizar hacia abajo para cerrar el reproductor; izquierda/derecha en la carátula para cambiar
let touch = null;
P.player.addEventListener('touchstart', (e) => {
  if (e.target.closest('input')) return;
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, art: !!e.target.closest('.player-art') };
}, { passive: true });
P.player.addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
  if (dy > 90 && Math.abs(dx) < 60) closePlayer();
  else if (touch.art && Math.abs(dx) > 60 && Math.abs(dy) < 50) dx < 0 ? player.next() : player.prev();
  touch = null;
});
// Deslizar el mini reproductor hacia los lados para cambiar de canción
let miniTouch = null;
P.mini.addEventListener('touchstart', (e) => { miniTouch = e.touches[0].clientX; }, { passive: true });
P.mini.addEventListener('touchend', (e) => {
  if (miniTouch === null) return;
  const dx = e.changedTouches[0].clientX - miniTouch;
  if (Math.abs(dx) > 70) dx < 0 ? player.next() : player.prev();
  miniTouch = null;
});

let seeking = false;
P.seek.addEventListener('input', () => {
  seeking = true;
  const d = player.audio.duration || 0;
  P.cur.textContent = fmtTime((P.seek.value / 1000) * d);
  P.seek.style.setProperty('--p', `${P.seek.value / 10}%`);
});
P.seek.addEventListener('change', () => {
  player.seek((P.seek.value / 1000) * (player.audio.duration || 0));
  seeking = false;
});

function setCover(img, url) {
  if (url) { img.src = url; img.classList.remove('ph'); }
  else { img.removeAttribute('src'); img.classList.add('ph'); }
}

async function refreshPlayerUI() {
  const s = player.current();
  P.mini.classList.toggle('hidden', !s);
  if (!s) { closePlayer(); return; }
  const url = lib.songCover(s);
  setCover(P.miniCover, url);
  setCover(P.cover, url);
  P.miniTitle.textContent = s.title;
  P.miniArtist.textContent = s.artist;
  P.title.textContent = s.title;
  P.artist.textContent = s.artist;
  P.from.textContent = player.state.context?.label || 'Tu biblioteca';
  document.title = `${s.title} · ${s.artist}`;
  refreshLike();
  const col = (await averageColor(url)) || '#4a4a4a';
  if (player.current() === s) {
    P.player.style.setProperty('--player-bg', col);
    P.mini.style.setProperty('--mini-bg', col);
  }
}

function refreshLike() {
  const s = player.current();
  const on = s && lib.liked.has(s.id);
  for (const b of [P.like, P.miniLike]) {
    b.innerHTML = icon(on ? 'heartFill' : 'heart');
    b.classList.toggle('liked', !!on);
    b.setAttribute('aria-label', on ? 'Quitar de Tus me gusta' : 'Añadir a Tus me gusta');
  }
}

function refreshState() {
  const playing = player.isPlaying();
  const ic = icon(playing ? 'pause' : 'play');
  P.play.innerHTML = ic;
  P.miniPlay.innerHTML = ic;
  P.play.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  P.miniPlay.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  P.shuffle.classList.toggle('on', player.state.shuffle);
  P.repeat.classList.toggle('on', player.state.repeat !== 'off');
  P.repeat.dataset.mode = player.state.repeat;
  P.repeat.setAttribute('aria-label', { off: 'Repetir: no', all: 'Repetir: todo', one: 'Repetir: una' }[player.state.repeat]);
  markPlaying();
}

function refreshTime() {
  const a = player.audio;
  const d = a.duration || player.current()?.duration || 0;
  const p = d ? (a.currentTime / d) : 0;
  P.miniBar.style.width = `${(p * 100).toFixed(2)}%`;
  if (!seeking) {
    P.seek.value = Math.round(p * 1000);
    P.seek.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
    P.cur.textContent = fmtTime(a.currentTime);
  }
  P.dur.textContent = fmtTime(d);
}

player.bus.addEventListener('track', () => { refreshPlayerUI(); refreshTime(); markPlaying(); });
player.bus.addEventListener('state', refreshState);
player.bus.addEventListener('time', refreshTime);
player.bus.addEventListener('queue', markPlaying);
player.bus.addEventListener('error', (e) => toast(e.detail.message, 3500));
lib.bus.addEventListener('like', () => { refreshLike(); if (/liked|songs|album|artist|playlist|search|genre/.test(location.hash)) rerender(); });
lib.bus.addEventListener('change', () => { if (location.hash.startsWith('#/search')) renderResults(); else rerender(); refreshPlayerUI(); });

/* ------------------------------ Arranque ------------------------------ */

// Archivos recibidos con «Compartir → LocalMusic» (los deja el service worker en caché)
async function importShared() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname + location.hash);
  const cache = await caches.open('localmusic-share');
  const files = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const name = decodeURIComponent(res.headers.get('x-name') || 'audio');
    files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') || '' }));
    await cache.delete(req);
  }
  await doImport(files);
}

(async function start() {
  try {
    await lib.load();
    await stats.load();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty"><h2>No se pudo abrir la biblioteca</h2><p>Tu navegador no permite guardar datos (¿modo incógnito?). ${esc(err.message || '')}</p></div>`;
    return;
  }
  render();
  refreshState();
  await player.restore();
  refreshPlayerUI();
  await importShared();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
  }
})();
