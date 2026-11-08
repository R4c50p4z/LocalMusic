#!/usr/bin/env python3
"""LocalMusic: tu propio "Spotify" con tu música local, sin suscripciones.

Uso:
    python3 server.py --music /ruta/a/tu/musica [--port 8080] [--host 0.0.0.0]

Sólo usa la librería estándar de Python. Si instalas `mutagen`
(pip install mutagen) leerá etiquetas (título, artista, álbum, duración)
y carátulas incrustadas; si no, deduce la información del nombre del archivo.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    import mutagen  # type: ignore
except ImportError:  # pragma: no cover - opcional
    mutagen = None

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"

AUDIO_EXTS = {".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wav", ".webm", ".alac"}
COVER_NAMES = ("cover", "folder", "front", "album", "albumart")
COVER_EXTS = (".jpg", ".jpeg", ".png", ".webp")

mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("audio/ogg", ".oga")
mimetypes.add_type("audio/ogg", ".opus")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/aac", ".aac")
mimetypes.add_type("audio/webm", ".webm")
mimetypes.add_type("application/manifest+json", ".webmanifest")


# --------------------------------------------------------------------------- #
# Biblioteca
# --------------------------------------------------------------------------- #

def track_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:16]


def _first(tags, *keys):
    if not tags:
        return None
    for k in keys:
        try:
            v = tags.get(k)
        except Exception:
            v = None
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            v = v[0] if v else None
        if v is None:
            continue
        if hasattr(v, "text"):  # ID3 frames
            v = v.text[0] if v.text else None
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def _parse_int(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, tuple):
        value = value[0]
    m = re.match(r"\s*(\d+)", str(value))
    return int(m.group(1)) if m else None


def read_metadata(path: Path, music_root: Path) -> dict:
    rel = path.relative_to(music_root).as_posix()
    parts = path.relative_to(music_root).parts
    stem = path.stem

    # Valores por defecto deducidos de la ruta: Artista/Álbum/NN - Título.ext
    title = re.sub(r"^\d+[\s.\-_]+", "", stem).strip() or stem
    artist = parts[-3] if len(parts) >= 3 else (parts[-2] if len(parts) == 2 else "Desconocido")
    album = parts[-2] if len(parts) >= 2 else "Sin álbum"
    if " - " in title and len(parts) < 3:
        a, t = title.split(" - ", 1)
        artist, title = a.strip(), t.strip()
    m = re.match(r"^(\d+)", stem)
    track_no = int(m.group(1)) if m else None
    duration = None
    year = None
    embedded_cover = False

    if mutagen is not None:
        try:
            f = mutagen.File(path)
        except Exception:
            f = None
        if f is not None:
            if getattr(f, "info", None) is not None and getattr(f.info, "length", None):
                duration = round(float(f.info.length), 2)
            tags = f.tags
            title = _first(tags, "TIT2", "title", "\xa9nam", "TITLE") or title
            artist = _first(tags, "TPE1", "artist", "\xa9ART", "ARTIST", "TPE2", "albumartist", "aART") or artist
            album = _first(tags, "TALB", "album", "\xa9alb", "ALBUM") or album
            year_raw = _first(tags, "TDRC", "date", "\xa9day", "DATE", "year")
            year = _parse_int(year_raw)
            tn = None
            if tags is not None:
                try:
                    tn = tags.get("trkn")
                    tn = tn[0] if tn else None
                except Exception:
                    tn = None
            track_no = _parse_int(tn or _first(tags, "TRCK", "tracknumber", "TRACKNUMBER")) or track_no
            embedded_cover = _extract_embedded_cover(f) is not None

    return {
        "id": track_id(rel),
        "path": rel,
        "title": title,
        "artist": artist,
        "album": album,
        "year": year,
        "track": track_no,
        "duration": duration,
        "embeddedCover": embedded_cover,
    }


def _extract_embedded_cover(f):
    """Devuelve (bytes, mime) de la carátula incrustada o None."""
    if f is None:
        return None
    tags = getattr(f, "tags", None)
    try:
        # FLAC
        pics = getattr(f, "pictures", None)
        if pics:
            return pics[0].data, pics[0].mime or "image/jpeg"
        if tags is None:
            return None
        # ID3 (mp3, aiff, wav con id3)
        if hasattr(tags, "getall"):
            apic = tags.getall("APIC")
            if apic:
                return apic[0].data, apic[0].mime or "image/jpeg"
        # MP4 / M4A
        covr = tags.get("covr") if hasattr(tags, "get") else None
        if covr:
            data = bytes(covr[0])
            mime = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
            return data, mime
        # Ogg Vorbis / Opus
        b64 = tags.get("metadata_block_picture") if hasattr(tags, "get") else None
        if b64:
            import base64
            from mutagen.flac import Picture  # type: ignore

            pic = Picture(base64.b64decode(b64[0]))
            return pic.data, pic.mime or "image/jpeg"
    except Exception:
        return None
    return None


def find_folder_cover(directory: Path) -> Path | None:
    try:
        entries = {p.name.lower(): p for p in directory.iterdir() if p.is_file()}
    except OSError:
        return None
    for name in COVER_NAMES:
        for ext in COVER_EXTS:
            p = entries.get(name + ext)
            if p:
                return p
    # cualquier imagen suelta en la carpeta
    for lname, p in sorted(entries.items()):
        if lname.endswith(COVER_EXTS):
            return p
    return None


class Library:
    def __init__(self, music_root: Path):
        self.root = music_root
        self.cache_file = DATA_DIR / "library.json"
        self.lock = threading.Lock()
        self.tracks: dict[str, dict] = {}
        self.scanning = False
        self.last_scan: float | None = None
        self._load_cache()

    def _load_cache(self):
        try:
            data = json.loads(self.cache_file.read_text("utf-8"))
            if data.get("root") == str(self.root):
                self.tracks = {t["id"]: t for t in data.get("tracks", [])}
                self.last_scan = data.get("lastScan")
        except (OSError, ValueError, KeyError):
            pass

    def _save_cache(self):
        DATA_DIR.mkdir(exist_ok=True)
        tmp = self.cache_file.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"root": str(self.root), "lastScan": self.last_scan,
                        "tracks": list(self.tracks.values())}, ensure_ascii=False),
            "utf-8",
        )
        tmp.replace(self.cache_file)

    def scan(self):
        with self.lock:
            if self.scanning:
                return
            self.scanning = True
        try:
            old_by_path = {t["path"]: t for t in self.tracks.values()}
            new: dict[str, dict] = {}
            for dirpath, dirnames, filenames in os.walk(self.root, followlinks=True):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for fn in filenames:
                    if fn.startswith(".") or Path(fn).suffix.lower() not in AUDIO_EXTS:
                        continue
                    p = Path(dirpath) / fn
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    rel = p.relative_to(self.root).as_posix()
                    old = old_by_path.get(rel)
                    if old and old.get("mtime") == st.st_mtime and old.get("size") == st.st_size:
                        if not old.get("hasCover"):  # quizá se añadió un cover.jpg después
                            old["hasCover"] = find_folder_cover(p.parent) is not None
                        new[old["id"]] = old
                        continue
                    meta = read_metadata(p, self.root)
                    meta["hasCover"] = meta["embeddedCover"] or find_folder_cover(p.parent) is not None
                    meta["mtime"] = st.st_mtime
                    meta["size"] = st.st_size
                    meta["added"] = old["added"] if old else time.time()
                    new[meta["id"]] = meta
            self.tracks = new
            self.last_scan = time.time()
            self._save_cache()
            print(f"[LocalMusic] Biblioteca escaneada: {len(new)} canciones", flush=True)
        finally:
            self.scanning = False

    def scan_async(self):
        threading.Thread(target=self.scan, daemon=True).start()

    def public_tracks(self) -> list[dict]:
        keys = ("id", "title", "artist", "album", "year", "track", "duration", "added", "hasCover")
        return [{k: t.get(k) for k in keys} for t in self.tracks.values()]

    def file_for(self, tid: str) -> Path | None:
        t = self.tracks.get(tid)
        if not t:
            return None
        p = (self.root / t["path"]).resolve()
        try:
            p.relative_to(self.root.resolve())
        except ValueError:
            return None
        return p if p.is_file() else None

    def cover_for(self, tid: str):
        p = self.file_for(tid)
        if not p:
            return None
        if mutagen is not None and self.tracks[tid].get("embeddedCover"):
            try:
                c = _extract_embedded_cover(mutagen.File(p))
                if c:
                    return c
            except Exception:
                pass
        folder = find_folder_cover(p.parent)
        if folder:
            mime = mimetypes.guess_type(folder.name)[0] or "image/jpeg"
            return folder.read_bytes(), mime
        return None


# --------------------------------------------------------------------------- #
# Playlists
# --------------------------------------------------------------------------- #

class Playlists:
    def __init__(self):
        self.file = DATA_DIR / "playlists.json"
        self.lock = threading.Lock()
        try:
            self.items: dict[str, dict] = json.loads(self.file.read_text("utf-8"))
        except (OSError, ValueError):
            self.items = {}

    def _save(self):
        DATA_DIR.mkdir(exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(self.file)

    def all(self):
        return sorted(self.items.values(), key=lambda p: p.get("created", 0))

    def create(self, name: str, tracks: list[str] | None = None):
        with self.lock:
            pid = uuid.uuid4().hex[:12]
            self.items[pid] = {"id": pid, "name": name[:200] or "Nueva playlist",
                               "tracks": list(tracks or []), "created": time.time()}
            self._save()
            return self.items[pid]

    def update(self, pid: str, data: dict):
        with self.lock:
            pl = self.items.get(pid)
            if not pl:
                return None
            if isinstance(data.get("name"), str):
                pl["name"] = data["name"][:200]
            if isinstance(data.get("tracks"), list):
                pl["tracks"] = [str(t) for t in data["tracks"]]
            self._save()
            return pl

    def delete(self, pid: str) -> bool:
        with self.lock:
            if self.items.pop(pid, None) is None:
                return False
            self._save()
            return True


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    server_version = "LocalMusic/1.0"
    library: Library
    playlists: Playlists

    def log_message(self, fmt, *args):  # menos ruido en consola
        if os.environ.get("LOCALMUSIC_DEBUG"):
            super().log_message(fmt, *args)

    # -- utilidades --
    def _json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, msg=""):
        self._json({"error": msg or status.phrase}, status)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 5_000_000:
            raise ValueError("demasiado grande")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def _send_file(self, path: Path, content_type: str | None = None, cache="no-cache"):
        size = path.stat().st_size
        ctype = content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = HTTPStatus.OK
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:  # sufijo: últimos N bytes
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with path.open("rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # el navegador cortó (normal al saltar de canción)

    # -- rutas --
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/api/library":
            return self._json({
                "tracks": self.library.public_tracks(),
                "scanning": self.library.scanning,
                "lastScan": self.library.last_scan,
                "metadata": mutagen is not None,
            })
        if path.startswith("/api/stream/"):
            f = self.library.file_for(path.rsplit("/", 1)[-1])
            if not f:
                return self._error(HTTPStatus.NOT_FOUND, "Canción no encontrada")
            return self._send_file(f, cache="private, max-age=3600")
        if path.startswith("/api/cover/"):
            c = self.library.cover_for(path.rsplit("/", 1)[-1])
            if not c:
                return self._error(HTTPStatus.NOT_FOUND, "Sin carátula")
            data, mime = c
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "private, max-age=86400")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
            return
        if path == "/api/playlists":
            return self._json(self.playlists.all())
        if path.startswith("/api/"):
            return self._error(HTTPStatus.NOT_FOUND)

        # estáticos
        rel = path.lstrip("/") or "index.html"
        target = (STATIC_DIR / rel).resolve()
        try:
            target.relative_to(STATIC_DIR)
        except ValueError:
            return self._error(HTTPStatus.FORBIDDEN)
        if not target.is_file():
            target = STATIC_DIR / "index.html"  # SPA fallback
        return self._send_file(target)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
        except ValueError:
            return self._error(HTTPStatus.BAD_REQUEST, "JSON inválido")
        if path == "/api/rescan":
            self.library.scan_async()
            return self._json({"ok": True})
        if path == "/api/playlists":
            name = str(data.get("name") or "Nueva playlist")
            tracks = data.get("tracks") if isinstance(data.get("tracks"), list) else []
            return self._json(self.playlists.create(name, tracks), HTTPStatus.CREATED)
        return self._error(HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/playlists/"):
            return self._error(HTTPStatus.NOT_FOUND)
        try:
            data = self._read_json()
        except ValueError:
            return self._error(HTTPStatus.BAD_REQUEST, "JSON inválido")
        pl = self.playlists.update(path.rsplit("/", 1)[-1], data)
        return self._json(pl) if pl else self._error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/playlists/") and self.playlists.delete(path.rsplit("/", 1)[-1]):
            return self._json({"ok": True})
        return self._error(HTTPStatus.NOT_FOUND)


def main():
    ap = argparse.ArgumentParser(description="LocalMusic: streaming de tu música local")
    ap.add_argument("--music", default=os.environ.get("MUSIC_DIR", str(Path.home() / "Music")),
                    help="Carpeta con tu música (por defecto ~/Music o $MUSIC_DIR)")
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"),
                    help="0.0.0.0 = accesible desde otros dispositivos de tu red")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    args = ap.parse_args()

    root = Path(args.music).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"La carpeta de música no existe: {root}")

    Handler.library = Library(root)
    Handler.playlists = Playlists()
    Handler.library.scan_async()

    if mutagen is None:
        print("[LocalMusic] Aviso: 'mutagen' no instalado; uso nombres de archivo como metadatos.\n"
              "             Para etiquetas y carátulas: pip install mutagen")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"[LocalMusic] Música: {root}")
    print(f"[LocalMusic] Abre http://localhost:{args.port} (o http://<IP-de-tu-PC>:{args.port} desde el móvil)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nAdiós 👋")


if __name__ == "__main__":
    main()
