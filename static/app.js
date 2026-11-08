/* LocalMusic — cliente web */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) return "0:00";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};
const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const coverUrl = (id) => `/api/cover/${id}`;
const PH = '<div class="ph">♪</div>';
const imgOrPh = (id, cls = "") => !state.byId.get(id)?.hasCover ? PH :
  `<img class="${cls}" loading="lazy" src="${coverUrl(id)}" alt="" onerror="this.outerHTML='${PH.replace(/"/g, "&quot;")}'">`;

const store = {
  get(k, d) { try { const v = localStorage.getItem("lm:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lm:" + k, JSON.stringify(v)); } catch {} },
};

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
const state = {
  tracks: [],           // todas
  byId: new Map(),
  playlists: [],
  queue: store.get("queue", []),       // ids
  index: store.get("index", -1),
  shuffle: store.get("shuffle", false),
  repeat: store.get("repeat", "off"),  // off | all | one
  history: [],
  search: "",
};

const audio = $("#audio");
audio.volume = store.get("volume", 0.8);

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

function sortTracks(list) {
  return list.sort((a, b) =>
    collator.compare(a.artist, b.artist) || collator.compare(a.album, b.album) ||
    (a.track ?? 999) - (b.track ?? 999) || collator.compare(a.title, b.title));
}

async function loadLibrary() {
  const data = await api("/api/library");
  state.tracks = sortTracks(data.tracks);
  state.byId = new Map(state.tracks.map((t) => [t.id, t]));
  state.scanning = data.scanning;
  state.queue = state.queue.filter((id) => state.byId.has(id));
  if (state.index >= state.queue.length) state.index = state.queue.length - 1;
  if (data.scanning) setTimeout(loadLibrary, 2000);
  render();
}

async function loadPlaylists() {
  state.playlists = await api("/api/playlists");
  renderPlaylistNav();
}

/* ------------------------------------------------------------------ */
/* Agrupaciones                                                        */
/* ------------------------------------------------------------------ */
function albums() {
  const map = new Map();
  for (const t of state.tracks) {
    const key = t.artist + "\u0000" + t.album;
    if (!map.has(key)) map.set(key, { key, album: t.album, artist: t.artist, year: t.year, tracks: [] });
    const a = map.get(key);
    a.tracks.push(t);
    if (!a.year && t.year) a.year = t.year;
  }
  return [...map.values()].sort((a, b) => collator.compare(a.album, b.album));
}

function artists() {
  const map = new Map();
  for (const t of state.tracks) {
    if (!map.has(t.artist)) map.set(t.artist, { name: t.artist, tracks: [], albums: new Set() });
    const a = map.get(t.artist);
    a.tracks.push(t);
    a.albums.add(t.album);
  }
  return [...map.values()].sort((a, b) => collator.compare(a.name, b.name));
}

function matches(t, q) {
  return !q || norm(`${t.title} ${t.artist} ${t.album}`).includes(q);
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */
const view = $("#view");

function route() {
  const [, name = "songs", ...rest] = location.hash.split("/");
  return { name, arg: rest.length ? decodeURIComponent(rest.join("/")) : null };
}

function setActiveNav(name) {
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  const { arg } = route();
  document.querySelectorAll("#playlistNav a").forEach((a) => a.classList.toggle("active", name === "playlist" && a.dataset.id === arg));
}

function trackTable(list, { numbered = false, playlistId = null, context = null } = {}) {
  if (!list.length) return "";
  const current = state.queue[state.index];
  const rows = list.map((t, i) => `
    <tr class="row ${t.id === current ? "playing" : ""}" data-id="${t.id}" data-i="${i}">
      <td class="num">${numbered && t.track ? t.track : i + 1}</td>
      <td>
        <div class="t-main">
          ${imgOrPh(t.id)}
          <div class="t-text">
            <div class="t-title">${esc(t.title)}</div>
            <div class="t-artist"><a href="#/artist/${encodeURIComponent(t.artist)}">${esc(t.artist)}</a></div>
          </div>
        </div>
      </td>
      <td class="col-album t-album"><a href="#/album/${encodeURIComponent(t.artist + "\u0000" + t.album)}">${esc(t.album)}</a></td>
      <td class="dur">${t.duration ? fmt(t.duration) : ""}</td>
      <td class="more"><button class="more-btn" title="Más opciones" data-more="${t.id}" ${playlistId ? `data-pl="${playlistId}" data-pi="${i}"` : ""}>⋯</button></td>
    </tr>`).join("");
  const html = `<table class="tracks"><thead><tr><th class="num">#</th><th>Título</th><th class="col-album">Álbum</th><th class="dur">⏱</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  // guardamos la lista para el doble click
  view._list = list;
  view._context = context;
  return html;
}

function emptyLibrary() {
  return `<div class="empty">${state.scanning ? "Escaneando tu música… ⏳" :
    "No hay canciones todavía.<br>Copia archivos de audio (mp3, flac, m4a, ogg…) en tu carpeta de música y pulsa <b>⟳ Re-escanear</b>."}</div>`;
}

function render() {
  const { name, arg } = route();
  setActiveNav(name);
  const q = norm(state.search);
  let html = "";
  view._list = null;

  if (q && !["playlist", "queue"].includes(name)) {
    const found = state.tracks.filter((t) => matches(t, q));
    html = `<h1>Resultados</h1><p class="sub">${found.length} canciones para “${esc(state.search)}”</p>` +
      (found.length ? trackTable(found) : `<div class="empty">Nada encontrado 🤷</div>`);
    view.innerHTML = html;
    return;
  }

  switch (name) {
    case "albums": {
      const list = albums();
      html = `<h1>Álbumes</h1><p class="sub">${list.length} álbumes</p>` + (list.length ? `<div class="grid">${list.map((a) => `
        <a class="card" href="#/album/${encodeURIComponent(a.key)}">
          ${imgOrPh(a.tracks[0].id)}
          <div class="c-title">${esc(a.album)}</div>
          <div class="c-sub">${a.year ? a.year + " · " : ""}${esc(a.artist)}</div>
        </a>`).join("")}</div>` : emptyLibrary());
      break;
    }
    case "album": {
      const a = albums().find((x) => x.key === arg);
      if (!a) { html = `<div class="empty">Álbum no encontrado</div>`; break; }
      const total = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
      html = `<div class="hero">${imgOrPh(a.tracks[0].id)}<div><div class="kind">Álbum</div><h1>${esc(a.album)}</h1>
        <div class="sub"><a href="#/artist/${encodeURIComponent(a.artist)}"><b>${esc(a.artist)}</b></a>${a.year ? " · " + a.year : ""} · ${a.tracks.length} canciones${total ? " · " + fmt(total) : ""}</div></div></div>
        ${actions()}` + trackTable(a.tracks, { numbered: true });
      break;
    }
    case "artists": {
      const list = artists();
      html = `<h1>Artistas</h1><p class="sub">${list.length} artistas</p>` + (list.length ? `<div class="grid">${list.map((a) => `
        <a class="card round" href="#/artist/${encodeURIComponent(a.name)}">
          ${imgOrPh(a.tracks[0].id)}
          <div class="c-title">${esc(a.name)}</div>
          <div class="c-sub">${a.albums.size} álbum${a.albums.size === 1 ? "" : "es"} · ${a.tracks.length} canciones</div>
        </a>`).join("")}</div>` : emptyLibrary());
      break;
    }
    case "artist": {
      const a = artists().find((x) => x.name === arg);
      if (!a) { html = `<div class="empty">Artista no encontrado</div>`; break; }
      const albs = albums().filter((x) => x.artist === a.name);
      html = `<div class="hero">${imgOrPh(a.tracks[0].id)}<div><div class="kind">Artista</div><h1>${esc(a.name)}</h1>
        <div class="sub">${a.tracks.length} canciones</div></div></div>${actions()}` +
        trackTable(a.tracks) +
        `<h2 style="margin-top:32px">Álbumes</h2><div class="grid">${albs.map((x) => `
          <a class="card" href="#/album/${encodeURIComponent(x.key)}">${imgOrPh(x.tracks[0].id)}
          <div class="c-title">${esc(x.album)}</div><div class="c-sub">${x.year || ""}</div></a>`).join("")}</div>`;
      break;
    }
    case "playlists": {
      html = `<h1>Playlists</h1><div class="actions"><button class="pill" data-action="new-playlist">＋ Nueva playlist</button></div>` +
        (state.playlists.length ? `<div class="grid">${state.playlists.map((p) => `
          <a class="card" href="#/playlist/${p.id}">${p.tracks[0] && state.byId.has(p.tracks[0]) ? imgOrPh(p.tracks[0]) : PH}
          <div class="c-title">${esc(p.name)}</div><div class="c-sub">${p.tracks.length} canciones</div></a>`).join("")}</div>`
          : `<div class="empty">Aún no tienes playlists.</div>`);
      break;
    }
    case "playlist": {
      const p = state.playlists.find((x) => x.id === arg);
      if (!p) { html = `<div class="empty">Playlist no encontrada</div>`; break; }
      const list = p.tracks.map((id) => state.byId.get(id)).filter(Boolean).filter((t) => matches(t, q));
      html = `<div class="hero">${list[0] ? imgOrPh(list[0].id) : PH}<div><div class="kind">Playlist</div><h1>${esc(p.name)}</h1>
        <div class="sub">${p.tracks.length} canciones</div></div></div>
        ${actions(`<button class="pill" data-action="rename-playlist" data-id="${p.id}">✏️ Renombrar</button>
                   <button class="pill danger" data-action="delete-playlist" data-id="${p.id}">🗑 Eliminar</button>`)}` +
        (list.length ? trackTable(list, { playlistId: p.id }) : `<div class="empty">Playlist vacía. Usa “⋯ → Añadir a playlist” en cualquier canción.</div>`);
      break;
    }
    case "queue": {
      const list = state.queue.map((id) => state.byId.get(id)).filter(Boolean);
      html = `<h1>Cola de reproducción</h1><p class="sub">${list.length} canciones</p>
        ${list.length ? `<div class="actions"><button class="pill" data-action="save-queue">💾 Guardar como playlist</button>
        <button class="pill danger" data-action="clear-queue">Vaciar cola</button></div>` : ""}` +
        (list.length ? trackTable(list, { context: "queue" }) : `<div class="empty">La cola está vacía.</div>`);
      break;
    }
    default: {
      html = `<h1>Canciones</h1><p class="sub">${state.tracks.length} canciones en tu biblioteca</p>` +
        (state.tracks.length ? actions() + trackTable(state.tracks) : emptyLibrary());
    }
  }
  view.innerHTML = html;
}

function actions(extra = "") {
  return `<div class="actions"><button class="big-play" data-action="play-all" title="Reproducir">▶</button>
    <button class="pill" data-action="shuffle-all">🔀 Aleatorio</button>${extra}</div>`;
}

function renderPlaylistNav() {
  $("#playlistNav").innerHTML = state.playlists.map((p) =>
    `<li><a href="#/playlist/${p.id}" data-id="${p.id}">${esc(p.name)}</a></li>`).join("");
  setActiveNav(route().name);
}

function highlightPlaying() {
  const id = state.queue[state.index];
  view.querySelectorAll("tr.row").forEach((tr) => tr.classList.toggle("playing", tr.dataset.id === id));
}

/* ------------------------------------------------------------------ */
/* Reproductor                                                         */
/* ------------------------------------------------------------------ */
function saveState() {
  store.set("queue", state.queue);
  store.set("index", state.index);
  store.set("shuffle", state.shuffle);
  store.set("repeat", state.repeat);
}

function playList(list, start = 0, { shuffle = state.shuffle } = {}) {
  let ids = list.map((t) => t.id);
  if (!ids.length) return;
  if (shuffle) {
    const first = ids[start];
    ids.splice(start, 1);
    shuffleArr(ids);
    ids.unshift(first);
    start = 0;
  }
  state.queue = ids;
  state.history = [];
  playIndex(start);
}

function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function playIndex(i, { autoplay = true, at = 0 } = {}) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  const t = state.byId.get(state.queue[i]);
  if (!t) return;
  audio.src = `/api/stream/${t.id}`;
  if (at) audio.currentTime = at;
  if (autoplay) audio.play().catch(() => {});
  updateNowPlaying(t);
  saveState();
  highlightPlaying();
  if (route().name === "queue") render();
}

function updateNowPlaying(t) {
  $("#npTitle").textContent = t.title;
  $("#npArtist").innerHTML = `<a href="#/artist/${encodeURIComponent(t.artist)}">${esc(t.artist)}</a>`;
  const img = $("#npCover");
  img.onerror = () => { img.onerror = null; img.src = "/icon.svg"; };
  img.src = t.hasCover ? coverUrl(t.id) : "/icon.svg";
  document.title = `${t.title} · ${t.artist}`;
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: [{ src: t.hasCover ? coverUrl(t.id) : "/icon.svg", sizes: "512x512" }],
    });
  }
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === "one") { audio.currentTime = 0; audio.play(); return; }
  let i = state.index + 1;
  if (i >= state.queue.length) {
    if (state.repeat === "all" || !auto) i = 0;
    else { audio.pause(); return; }
  }
  playIndex(i);
}

function prev() {
  if (audio.currentTime > 3 || state.index <= 0) { audio.currentTime = 0; return; }
  playIndex(state.index - 1);
}

function togglePlay() {
  if (!audio.src) {
    if (state.queue.length) return playIndex(Math.max(0, state.index));
    return playList(view._list || state.tracks, 0);
  }
  audio.paused ? audio.play() : audio.pause();
}

function addToQueue(ids, playNext = false) {
  if (playNext && state.queue.length) state.queue.splice(state.index + 1, 0, ...ids);
  else state.queue.push(...ids);
  if (state.index < 0) playIndex(0, { autoplay: false });
  saveState();
  toast(playNext ? "Se reproducirá a continuación" : "Añadida a la cola");
  if (route().name === "queue") render();
}

function setShuffle(on, { reorder = true } = {}) {
  state.shuffle = on;
  $("#shuffleBtn").classList.toggle("on", on);
  if (reorder && on && state.queue.length > 1) {
    const cur = state.queue[state.index];
    const rest = state.queue.filter((_, i) => i !== state.index);
    state.queue = [cur, ...shuffleArr(rest)].filter(Boolean);
    state.index = cur ? 0 : -1;
  }
  saveState();
  if (route().name === "queue") render();
}

function cycleRepeat() {
  state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
  renderRepeat();
  saveState();
}
function renderRepeat() {
  const b = $("#repeatBtn");
  b.classList.toggle("on", state.repeat !== "off");
  b.classList.toggle("one", state.repeat === "one");
  b.title = { off: "Repetir: no", all: "Repetir: todo", one: "Repetir: una" }[state.repeat];
}

function setRangeFill(el) { el.style.setProperty("--p", (el.value / el.max) * 100 + "%"); }

const seek = $("#seek"), vol = $("#volume");
let seeking = false;
audio.addEventListener("timeupdate", () => {
  $("#curTime").textContent = fmt(audio.currentTime);
  if (!seeking && audio.duration) { seek.value = (audio.currentTime / audio.duration) * 1000; setRangeFill(seek); }
  if (Math.floor(audio.currentTime) % 5 === 0) store.set("pos", audio.currentTime);
  if ("mediaSession" in navigator && audio.duration && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 }); } catch {}
  }
});
audio.addEventListener("loadedmetadata", () => { $("#durTime").textContent = fmt(audio.duration); });
audio.addEventListener("play", () => { $("#playBtn").textContent = "⏸"; });
audio.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; });
audio.addEventListener("ended", () => next(true));
audio.addEventListener("error", () => { if (audio.src) { toast("No se pudo reproducir este archivo"); setTimeout(() => next(true), 800); } });

seek.addEventListener("input", () => { seeking = true; setRangeFill(seek); $("#curTime").textContent = fmt((seek.value / 1000) * (audio.duration || 0)); });
seek.addEventListener("change", () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });
vol.value = audio.volume * 100; setRangeFill(vol);
vol.addEventListener("input", () => { audio.volume = vol.value / 100; audio.muted = false; setRangeFill(vol); store.set("volume", audio.volume); });
audio.addEventListener("volumechange", () => { $("#muteBtn").textContent = audio.muted || audio.volume === 0 ? "🔇" : audio.volume < 0.5 ? "🔉" : "🔊"; });

$("#playBtn").onclick = togglePlay;
$("#nextBtn").onclick = () => next();
$("#prevBtn").onclick = prev;
$("#shuffleBtn").onclick = () => setShuffle(!state.shuffle);
$("#repeatBtn").onclick = cycleRepeat;
$("#muteBtn").onclick = () => { audio.muted = !audio.muted; };

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => audio.play());
  ms.setActionHandler("pause", () => audio.pause());
  ms.setActionHandler("previoustrack", prev);
  ms.setActionHandler("nexttrack", () => next());
  try { ms.setActionHandler("seekto", (e) => { audio.currentTime = e.seekTime; }); } catch {}
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight" && e.shiftKey) next();
  else if (e.key === "ArrowLeft" && e.shiftKey) prev();
  else if (e.key === "ArrowRight") audio.currentTime += 10;
  else if (e.key === "ArrowLeft") audio.currentTime -= 10;
  else if (e.key.toLowerCase() === "s") setShuffle(!state.shuffle);
  else if (e.key.toLowerCase() === "r") cycleRepeat();
  else if (e.key.toLowerCase() === "m") audio.muted = !audio.muted;
  else if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
});

/* ------------------------------------------------------------------ */
/* Interacciones con la vista                                          */
/* ------------------------------------------------------------------ */
view.addEventListener("dblclick", (e) => {
  const tr = e.target.closest("tr.row");
  if (!tr || e.target.closest("a, button")) return;
  playFromRow(tr);
});
view.addEventListener("click", async (e) => {
  const more = e.target.closest("[data-more]");
  if (more) { e.stopPropagation(); return openTrackMenu(more); }
  const act = e.target.closest("[data-action]");
  if (act) return handleAction(act.dataset.action, act.dataset.id);
  // en pantallas táctiles, un toque reproduce
  const tr = e.target.closest("tr.row");
  if (tr && !e.target.closest("a, button") && matchMedia("(hover: none)").matches) playFromRow(tr);
});

function playFromRow(tr) {
  const i = Number(tr.dataset.i);
  if (view._context === "queue") return playIndex(i);
  playList(view._list, i);
}

async function handleAction(action, id) {
  const list = view._list || [];
  switch (action) {
    case "play-all": return playList(list, 0, { shuffle: state.shuffle });
    case "shuffle-all": setShuffle(true, { reorder: false }); return playList(list, Math.floor(Math.random() * list.length), { shuffle: true });
    case "new-playlist": return newPlaylist();
    case "rename-playlist": {
      const p = state.playlists.find((x) => x.id === id);
      const name = prompt("Nuevo nombre:", p?.name);
      if (name) { await api(`/api/playlists/${id}`, { method: "PUT", body: { name } }); await loadPlaylists(); render(); }
      return;
    }
    case "delete-playlist": {
      if (!confirm("¿Eliminar esta playlist? (las canciones no se borran)")) return;
      await api(`/api/playlists/${id}`, { method: "DELETE" });
      await loadPlaylists();
      location.hash = "#/playlists";
      return;
    }
    case "clear-queue":
      state.queue = []; state.index = -1; audio.pause(); audio.removeAttribute("src"); saveState(); return render();
    case "save-queue": return newPlaylist(state.queue.slice());
  }
}

async function newPlaylist(tracks = []) {
  const name = prompt("Nombre de la playlist:", "Mi playlist");
  if (!name) return null;
  const p = await api("/api/playlists", { method: "POST", body: { name, tracks } });
  await loadPlaylists();
  toast(`Playlist “${name}” creada`);
  return p;
}

/* Menú ⋯ de cada canción */
const menu = $("#menu");
function openTrackMenu(btn) {
  const id = btn.dataset.more, plId = btn.dataset.pl, plIndex = Number(btn.dataset.pi);
  const t = state.byId.get(id);
  menu.innerHTML = `
    <button data-m="next">⤵ Reproducir a continuación</button>
    <button data-m="queue">➕ Añadir a la cola</button>
    <hr><div class="label">Añadir a playlist</div>
    <button data-m="newpl">＋ Nueva playlist…</button>
    ${state.playlists.map((p) => `<button data-m="pl" data-pl="${p.id}">📂 ${esc(p.name)}</button>`).join("")}
    ${plId ? `<hr><button data-m="rmpl">✖ Quitar de esta playlist</button>` : ""}
    <hr>
    <button data-m="artist">🎤 Ir al artista</button>
    <button data-m="album">💿 Ir al álbum</button>`;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + "px";
  menu.style.top = (r.bottom + mh > innerHeight - 8 ? Math.max(8, r.top - mh) : r.bottom) + "px";
  menu.onclick = async (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    closeMenu();
    switch (b.dataset.m) {
      case "next": return addToQueue([id], true);
      case "queue": return addToQueue([id]);
      case "newpl": return newPlaylist([id]);
      case "pl": {
        const p = state.playlists.find((x) => x.id === b.dataset.pl);
        if (p.tracks.includes(id) && !confirm("Ya está en la playlist. ¿Añadir otra vez?")) return;
        await api(`/api/playlists/${p.id}`, { method: "PUT", body: { tracks: [...p.tracks, id] } });
        await loadPlaylists();
        return toast(`Añadida a “${p.name}”`);
      }
      case "rmpl": {
        const p = state.playlists.find((x) => x.id === plId);
        // si hay búsqueda activa el índice visible no coincide; buscamos por id respetando posición
        const tracks = p.tracks.slice();
        const visible = p.tracks.map((x, i) => [x, i]).filter(([x]) => state.byId.has(x) && matches(state.byId.get(x), norm(state.search)));
        const realIdx = visible[plIndex] ? visible[plIndex][1] : tracks.indexOf(id);
        tracks.splice(realIdx, 1);
        await api(`/api/playlists/${p.id}`, { method: "PUT", body: { tracks } });
        await loadPlaylists();
        return render();
      }
      case "artist": location.hash = `#/artist/${encodeURIComponent(t.artist)}`; return;
      case "album": location.hash = `#/album/${encodeURIComponent(t.artist + "\u0000" + t.album)}`; return;
    }
  };
}
function closeMenu() { menu.hidden = true; }
document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
window.addEventListener("resize", closeMenu);
view.addEventListener("scroll", closeMenu);

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

/* Búsqueda, navegación, re-escaneo */
let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value.trim(); render(); }, 120);
});
window.addEventListener("hashchange", () => { closeMenu(); render(); view.scrollTop = 0; });
$("#newPlaylistBtn").onclick = () => newPlaylist();
$("#rescanBtn").onclick = async () => {
  await api("/api/rescan", { method: "POST" });
  toast("Escaneando biblioteca…");
  state.scanning = true;
  setTimeout(loadLibrary, 1000);
};

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */
(async function init() {
  setShuffle(state.shuffle, { reorder: false });
  renderRepeat();
  await Promise.all([loadLibrary(), loadPlaylists()]);
  // restaurar la última canción (en pausa) donde la dejaste
  if (state.index >= 0 && state.queue[state.index]) playIndex(state.index, { autoplay: false, at: store.get("pos", 0) });
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
