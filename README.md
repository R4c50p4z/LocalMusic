# LocalMusic

Un reproductor estilo Spotify para **las canciones que ya tienes descargadas en el móvil**.
Funciona sin conexión, sin cuentas y sin servidor: es una web app (PWA) que se instala en la
pantalla de inicio y guarda tu música dentro de la propia app.

## Qué hace

- **Importar música** del móvil: archivos sueltos o una carpeta entera. En Android también
  puedes usar *Compartir → LocalMusic* desde el gestor de archivos.
- Lee las **etiquetas y carátulas** (MP3/ID3, M4A/AAC, FLAC, OGG/Opus, WAV). Si una canción no
  tiene etiquetas, deduce artista y título del nombre del archivo (`Artista - Título.mp3`).
- **Inicio** con accesos rápidos, lo que más escuchas, añadido recientemente y tus artistas.
- **Buscar** por canción, artista o álbum (sin importar tildes) y explorar por género.
- **Tu biblioteca**: playlists, álbumes, artistas, «Tus me gusta» y todas las canciones.
- **Playlists**: crear, renombrar, añadir/quitar canciones y borrar.
- **Reproductor** a pantalla completa con fondo del color de la carátula, aleatorio,
  repetir (todo / una), cola de reproducción, «reproducir a continuación» y gestos
  (desliza hacia abajo para cerrar, a los lados para cambiar de canción).
- **Controles en la pantalla de bloqueo** y auriculares (Media Session).
- Recuerda la cola y la posición cuando vuelves a abrir la app.
- Editar título/artista/álbum y eliminar canciones de la biblioteca.
- **Tus estadísticas** (guardadas sólo en el móvil): tiempo escuchado, media diaria, mejor día,
  reproducciones, rachas de días seguidos, gráfica por día/mes, a qué horas escuchas, tops de
  canciones, artistas y álbumes, e historial reciente. Filtra por 7 días, 30 días, este año o
  siempre. Sólo cuenta el tiempo que la música suena de verdad (los saltos no suman).
- **Copia de seguridad**: guarda en un archivo tus estadísticas, me gusta y playlists para
  recuperarlos si cambias de móvil o reinstalas la app.

> Las canciones se **copian** dentro del almacenamiento de la app (IndexedDB). Los archivos
> originales del móvil nunca se modifican ni se borran.

## Cómo usarla en el móvil

La app necesita servirse por HTTPS para poder instalarse y funcionar sin conexión.
La forma más fácil es GitHub Pages (gratis):

1. En GitHub, ve a **Settings → Pages** y en *Source* elige **GitHub Actions**.
2. Cada vez que se suben cambios a la rama principal del repositorio, el flujo
   `.github/workflows/pages.yml` publica la app en `https://<tu-usuario>.github.io/LocalMusic/`
   (también puedes lanzarlo a mano desde **Actions → Publicar en GitHub Pages → Run workflow**).
3. Abre esa dirección en el móvil e instálala:
   - **Android (Chrome):** menú ⋮ → *Instalar aplicación* / *Añadir a pantalla de inicio*.
   - **iPhone (Safari):** botón Compartir → *Añadir a pantalla de inicio*.
4. Toca **Añadir canciones** y elige tu música.

## Probarla en el ordenador

No hay nada que compilar; basta con cualquier servidor estático:

```bash
python3 -m http.server 8000
```

y abre <http://localhost:8000>.

## Estructura

```
index.html            Estructura de la página
css/styles.css        Estilos
js/app.js             Interfaz: pantallas, menús, reproductor
js/player.js          Motor de reproducción, cola y pantalla de bloqueo
js/library.js         Biblioteca: importar, álbumes, artistas, playlists, me gusta
js/metadata.js        Lector de etiquetas y carátulas (sin dependencias)
js/db.js              Almacenamiento en IndexedDB
sw.js                 Service worker (modo sin conexión y «Compartir»)
manifest.webmanifest  Datos de instalación de la PWA
```

## Límites conocidos

- Los formatos que se pueden reproducir dependen del navegador (p. ej. Safari en iPhone no
  reproduce OGG antiguos; FLAC y Opus funcionan en versiones recientes).
- El espacio disponible lo decide el navegador. La app pide almacenamiento persistente para
  que el sistema no borre tu música; en Ajustes puedes ver cuánto ocupa.
- En iPhone, «Elegir carpeta» no está disponible: selecciona los archivos desde *Archivos*.
