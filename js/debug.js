// Versión de la app y registro de diagnóstico (sólo en el móvil, últimos 150 eventos).
export const VERSION = '9 · 12 nov 2026';

const KEY = 'localmusic-log';
let entries = [];
try { entries = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { entries = []; }

let saveTimer;
export function log(msg) {
  const d = new Date();
  const time = `${d.getDate()}/${d.getMonth() + 1} ${d.toLocaleTimeString('es', { hour12: false })}`;
  entries.push(`${time} ${document.visibilityState === 'hidden' ? '[bloqueado/2º plano] ' : ''}${msg}`);
  if (entries.length > 150) entries = entries.slice(-150);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* sin espacio */ } }, 500);
}

export function getLog() { return [...entries].reverse(); }
export function clearLog() { entries = []; try { localStorage.removeItem(KEY); } catch { /* nada */ } }

export function environment() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/);
  return {
    version: VERSION,
    system: ios ? `iOS ${ios[1]}.${ios[2]}${ios[3] ? '.' + ios[3] : ''}` : (ua.match(/Android [\d.]+/)?.[0] || navigator.platform || 'desconocido'),
    installed: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    mediaSession: 'mediaSession' in navigator,
    serviceWorker: !!navigator.serviceWorker?.controller,
  };
}

document.addEventListener('visibilitychange', () => log(document.visibilityState === 'hidden' ? 'App en segundo plano / pantalla bloqueada' : 'App en primer plano'));
