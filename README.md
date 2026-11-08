# 🎵 LocalMusic

Tu propio "Spotify" personal: escucha **tu música** (mp3, flac, m4a, ogg, opus, wav…) desde el navegador
del ordenador o del móvil, **sin suscripciones, sin anuncios y sin que tus datos salgan de casa**.

- Biblioteca por **canciones, álbumes y artistas**, con carátulas
- **Búsqueda** instantánea (ignora tildes y mayúsculas)
- **Playlists** propias, **cola** de reproducción, aleatorio y repetir (todo / una)
- Controles en la **pantalla de bloqueo** del móvil y teclas multimedia
- Se puede **instalar como app** en el móvil ("Añadir a pantalla de inicio")
- Recuerda la canción y el segundo donde lo dejaste
- Sin dependencias obligatorias: sólo Python 3.9+

## Puesta en marcha

```bash
git clone <este-repo> && cd LocalMusic
pip install mutagen          # opcional, pero recomendado (lee etiquetas y carátulas)
python3 server.py --music "/ruta/a/tu/musica"
```

Abre **http://localhost:8080**. Desde el móvil (en la misma WiFi) abre `http://<IP-de-tu-PC>:8080`
— la IP la ves con `ipconfig` (Windows) o `ip a` / `ifconfig` (Linux/Mac).

Opciones: `--port 8080`, `--host 0.0.0.0` (usa `127.0.0.1` para que sólo lo veas tú en el PC).
También puedes usar las variables `MUSIC_DIR`, `PORT` y `HOST`.

### Organización recomendada de la carpeta

```
Música/
  Artista/
    Álbum/
      01 - Canción.mp3
      cover.jpg        ← carátula (opcional si ya va incrustada)
```

Si los archivos tienen etiquetas (ID3, Vorbis, MP4) se usan esas; si no, se deduce todo de las carpetas
y el nombre del archivo. Al añadir música nueva pulsa **⟳ Re-escanear biblioteca**.

## Atajos de teclado

| Tecla | Acción |
|---|---|
| Espacio | Reproducir / pausar |
| ← / → | −10 s / +10 s |
| Shift + ← / → | Canción anterior / siguiente |
| S / R / M | Aleatorio / Repetir / Silenciar |
| / | Buscar |

## Escuchar fuera de casa

El servidor está pensado para tu red local. Para usarlo desde fuera, lo más sencillo y seguro es
[Tailscale](https://tailscale.com) (gratis para uso personal): instálalo en el PC y en el móvil y abre
`http://<nombre-del-pc>:8080`. **No abras el puerto en el router**: LocalMusic no tiene contraseña.

## ¿De dónde saco la música?

De tus CDs (ripeados), compras en Bandcamp/Qobuz/7digital, música libre (Free Music Archive, Jamendo)
o tus propias grabaciones. Respeta los derechos de autor.

## Datos

Las playlists y la caché de la biblioteca se guardan en `data/` (junto a `server.py`).
Haz copia de `data/playlists.json` si quieres conservarlas.
