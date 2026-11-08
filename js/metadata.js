// Lectura de etiquetas (título, artista, álbum, carátula...) sin dependencias.
// Soporta ID3v2.2/2.3/2.4 + ID3v1 (MP3), FLAC, OGG/Opus (Vorbis comments) y MP4/M4A.

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

const str = (bytes) => latin1.decode(bytes);
const clean = (s) => (s || '').replace(/\0+$/g, '').replace(/\0/g, ' / ').trim();

export async function readMetadata(file) {
  const tags = {};
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const magic4 = str(head.subarray(0, 4));
    if (str(head.subarray(0, 3)) === 'ID3') {
      await readId3v2(file, tags);
      // Un FLAC puede venir con ID3 delante: no es habitual, lo ignoramos.
    } else if (magic4 === 'fLaC') {
      await readFlac(file, tags);
    } else if (magic4 === 'OggS') {
      await readOgg(file, tags);
    } else if (str(head.subarray(4, 8)) === 'ftyp') {
      await readMp4(file, tags);
    }
    if (!tags.title && !tags.artist && file.size > 128) await readId3v1(file, tags);
  } catch (err) {
    console.warn('No se pudieron leer las etiquetas de', file.name, err);
  }
  return finalize(tags, file.name);
}

function finalize(tags, fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  let title = clean(tags.title);
  let artist = clean(tags.artist);
  if (!title) {
    // "Artista - Título" o "01 - Título" o "01. Título"
    const m = base.match(/^\s*(?:(\d{1,3})[\s.\-_)]+)?(.*?)\s+[-–—]\s+(.+)$/);
    if (m && !/^\d+$/.test(m[2])) {
      if (!artist) artist = m[2].trim();
      title = m[3].trim();
    } else {
      title = base.replace(/^\d{1,3}[\s.\-_)]+/, '').trim() || base;
    }
  }
  const track = parseInt(String(tags.track || '').split('/')[0], 10);
  const year = parseInt(String(tags.year || '').slice(0, 4), 10);
  return {
    title,
    artist: artist || 'Artista desconocido',
    album: clean(tags.album) || 'Álbum desconocido',
    albumArtist: clean(tags.albumArtist),
    track: Number.isFinite(track) ? track : 0,
    year: Number.isFinite(year) ? year : 0,
    genre: clean(tags.genre).replace(/^\((\d+)\)$/, ''),
    picture: tags.picture || null, // { data: Uint8Array, mime }
  };
}

/* ------------------------------ ID3v2 ------------------------------ */

const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

function removeUnsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decodeText(enc, bytes) {
  switch (enc) {
    case 0: return latin1.decode(bytes);
    case 1: {
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be.decode(bytes.subarray(2));
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le.decode(bytes.subarray(2));
      return utf16le.decode(bytes);
    }
    case 2: return utf16be.decode(bytes);
    default: return utf8.decode(bytes);
  }
}

// Posición del terminador de cadena según la codificación (1 byte o 2 bytes nulos).
function findTerm(bytes, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    return bytes.length;
  }
  const i = bytes.indexOf(0, start);
  return i < 0 ? bytes.length : i;
}

async function readId3v2(file, tags) {
  const hdr = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const ver = hdr[3];
  const flags = hdr[5];
  const size = synchsafe(hdr, 6);
  let b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  if (flags & 0x80 && ver < 4) b = removeUnsync(b);

  let pos = 0;
  if (flags & 0x40) { // cabecera extendida
    pos = ver === 4 ? synchsafe(b, 0) : be32(b, 0) + 4;
  }
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;

  const map = {
    TT2: 'title', TIT2: 'title', TP1: 'artist', TPE1: 'artist', TAL: 'album', TALB: 'album',
    TP2: 'albumArtist', TPE2: 'albumArtist', TRK: 'track', TRCK: 'track',
    TYE: 'year', TYER: 'year', TDRC: 'year', TCO: 'genre', TCON: 'genre',
  };

  while (pos + hdrLen <= b.length) {
    const id = str(b.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // relleno
    let fsize;
    if (ver === 2) fsize = be24(b, pos + 3);
    else if (ver === 4) fsize = synchsafe(b, pos + 4);
    else fsize = be32(b, pos + 4);
    const fflags = ver === 2 ? 0 : (b[pos + 8] << 8) | b[pos + 9];
    let data = b.subarray(pos + hdrLen, pos + hdrLen + fsize);
    pos += hdrLen + fsize;
    if (fsize <= 0) continue;

    if (ver === 4) {
      if (fflags & 0x000c) continue; // comprimido/cifrado: no soportado
      if (fflags & 0x0001) data = data.subarray(4); // longitud de datos
      if (fflags & 0x0002 || flags & 0x80) data = removeUnsync(data);
    }

    if (map[id]) {
      if (!tags[map[id]]) tags[map[id]] = decodeText(data[0], data.subarray(1));
    } else if ((id === 'APIC' || id === 'PIC') && !tags.picture) {
      const enc = data[0];
      let p = 1, mime;
      if (id === 'PIC') {
        const fmt = str(data.subarray(1, 4)).toLowerCase();
        mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        const e = data.indexOf(0, 1);
        mime = str(data.subarray(1, e)) || 'image/jpeg';
        if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase().replace('jpg', 'jpeg');
        p = e + 1;
      }
      p += 1; // tipo de imagen
      const t = findTerm(data, p, enc);
      p = t + (enc === 1 || enc === 2 ? 2 : 1);
      const img = data.slice(p);
      if (img.length > 0) tags.picture = { data: img, mime: sniffImage(img) || mime };
    }
  }
}

async function readId3v1(file, tags) {
  const b = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
  if (str(b.subarray(0, 3)) !== 'TAG') return;
  const s = (a, z) => clean(latin1.decode(b.subarray(a, z)));
  tags.title ||= s(3, 33);
  tags.artist ||= s(33, 63);
  tags.album ||= s(63, 93);
  tags.year ||= s(93, 97);
  if (b[125] === 0 && b[126]) tags.track ||= String(b[126]);
}

/* --------------------------- FLAC / OGG --------------------------- */

function parseVorbisComments(b, tags) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const vendorLen = dv.getUint32(p, true); p += 4 + vendorLen;
  const n = dv.getUint32(p, true); p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const len = dv.getUint32(p, true); p += 4;
    const c = utf8.decode(b.subarray(p, p + len)); p += len;
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    const k = c.slice(0, eq).toUpperCase();
    const v = c.slice(eq + 1);
    const key = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist', TRACKNUMBER: 'track', DATE: 'year', YEAR: 'year', GENRE: 'genre' }[k];
    if (key && !tags[key]) tags[key] = v;
    if (k === 'METADATA_BLOCK_PICTURE' && !tags.picture) {
      try {
        const bin = Uint8Array.from(atob(v), ch => ch.charCodeAt(0));
        parseFlacPicture(bin, tags);
      } catch { /* ignorar */ }
    }
  }
}

function parseFlacPicture(b, tags) {
  let p = 4;
  const mimeLen = be32(b, p); p += 4;
  const mime = str(b.subarray(p, p + mimeLen)); p += mimeLen;
  const descLen = be32(b, p); p += 4 + descLen;
  p += 16;
  const len = be32(b, p); p += 4;
  const img = b.slice(p, p + len);
  if (img.length) tags.picture = { data: img, mime: sniffImage(img) || mime || 'image/jpeg' };
}

async function readFlac(file, tags) {
  let pos = 4;
  for (let guard = 0; guard < 64 && pos < file.size; guard++) {
    const h = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer());
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = be24(h, 1);
    if (type === 4 || (type === 6 && !tags.picture)) {
      const b = new Uint8Array(await file.slice(pos + 4, pos + 4 + len).arrayBuffer());
      if (type === 4) parseVorbisComments(b, tags);
      else parseFlacPicture(b, tags);
    }
    pos += 4 + len;
    if (last) break;
  }
}

async function readOgg(file, tags) {
  // Reconstruye el segundo paquete lógico (comentarios) a partir de las páginas OGG.
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer());
  let pos = 0, packetIndex = 0;
  const chunks = [];
  while (pos + 27 <= buf.length && str(buf.subarray(pos, pos + 4)) === 'OggS') {
    const nSeg = buf[pos + 26];
    const lacing = buf.subarray(pos + 27, pos + 27 + nSeg);
    let dataPos = pos + 27 + nSeg;
    for (let i = 0; i < nSeg; i++) {
      const l = lacing[i];
      if (packetIndex === 1) chunks.push(buf.subarray(dataPos, dataPos + l));
      dataPos += l;
      if (l < 255) {
        packetIndex++;
        if (packetIndex === 2) break;
      }
    }
    pos = dataPos;
    if (packetIndex >= 2) break;
  }
  if (!chunks.length) return;
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const pkt = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { pkt.set(c, o); o += c.length; }
  let start = 0;
  if (str(pkt.subarray(0, 8)) === 'OpusTags') start = 8;
  else if (pkt[0] === 3 && str(pkt.subarray(1, 7)) === 'vorbis') start = 7;
  else return;
  parseVorbisComments(pkt.subarray(start), tags);
}

/* ----------------------------- MP4 / M4A ----------------------------- */

async function readMp4(file, tags) {
  // Busca 'moov' entre los átomos de primer nivel leyendo sólo cabeceras.
  let pos = 0;
  while (pos + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
    let size = be32(h, 0);
    const type = str(h.subarray(4, 8));
    let hdr = 8;
    if (size === 1) { size = be32(h, 8) * 2 ** 32 + be32(h, 12); hdr = 16; }
    else if (size === 0) size = file.size - pos;
    if (size < 8) return;
    if (type === 'moov') {
      const b = new Uint8Array(await file.slice(pos + hdr, pos + size).arrayBuffer());
      const ilst = findPath(b, ['udta', 'meta', 'ilst']) || findPath(b, ['meta', 'ilst']);
      if (ilst) parseIlst(ilst, tags);
      return;
    }
    pos += size;
  }
}

function* atoms(b) {
  let p = 0;
  while (p + 8 <= b.length) {
    let size = be32(b, p);
    const type = str(b.subarray(p + 4, p + 8));
    let hdr = 8;
    if (size === 1) { size = be32(b, p + 12); hdr = 16; }
    else if (size === 0) size = b.length - p;
    if (size < hdr) return;
    yield { type, body: b.subarray(p + hdr, p + size) };
    p += size;
  }
}

function findPath(b, path) {
  let cur = b;
  for (const name of path) {
    let found = null;
    for (const a of atoms(cur)) if (a.type === name) { found = a.body; break; }
    if (!found) return null;
    cur = name === 'meta' ? found.subarray(4) : found; // 'meta' es un full box
  }
  return cur;
}

function parseIlst(b, tags) {
  const map = { '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album', 'aART': 'albumArtist', '\xa9day': 'year', '\xa9gen': 'genre' };
  for (const item of atoms(b)) {
    for (const d of atoms(item.body)) {
      if (d.type !== 'data') continue;
      const dataType = be32(d.body, 0) & 0xffffff;
      const payload = d.body.subarray(8);
      if (map[item.type]) tags[map[item.type]] ||= utf8.decode(payload);
      else if (item.type === 'trkn' && payload.length >= 4) tags.track ||= String((payload[2] << 8) | payload[3]);
      else if (item.type === 'covr' && !tags.picture && payload.length) {
        const img = payload.slice();
        tags.picture = { data: img, mime: sniffImage(img) || (dataType === 14 ? 'image/png' : 'image/jpeg') };
      }
      break;
    }
  }
}

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (str(b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** Duración en segundos usando el decodificador del navegador. */
export function readDuration(file) {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (d) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) ? d : 0);
    };
    const timer = setTimeout(() => finish(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (a.duration === Infinity) { // algunos VBR/OGG: forzar el cálculo
        a.currentTime = 1e7;
        a.ontimeupdate = () => finish(a.duration);
      } else finish(a.duration);
    };
    a.onerror = () => finish(0);
    a.src = url;
  });
}

/** ¿Puede este navegador reproducir el fichero? */
export function canPlay(file) {
  const a = document.createElement('audio');
  const type = file.type || guessMime(file.name);
  return !type || a.canPlayType(type) !== '';
}

export function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase();
  return {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', weba: 'audio/webm', webm: 'audio/webm',
  }[ext] || '';
}

export function isAudioFile(file) {
  return (file.type && file.type.startsWith('audio/')) || /\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav|weba|webm)$/i.test(file.name);
}
