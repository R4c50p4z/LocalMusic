// Versión de la app y registro de diagnóstico (sólo en el móvil, últimos 150 eventos).
export const VERSION = '12 · 13 nov 2026';

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

// Desde iOS 26, Apple congela la versión que el iPhone comunica a las webs en «18.x»
// para todos. Safari indica su propia versión (igual a la de iOS) en «Version/…»,
// pero las apps instaladas en la pantalla de inicio a menudo no la incluyen.
function systemName() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/);
  if (!ios) return ua.match(/Android [\d.]+/)?.[0] || navigator.platform || 'desconocido';
  const reported = `${ios[1]}.${ios[2]}${ios[3] ? '.' + ios[3] : ''}`;
  const safari = ua.match(/Version\/(\d+)(?:\.(\d+))?/);
  if (safari && +safari[1] >= 26) return `iOS ${safari[1]}${safari[2] ? '.' + safari[2] : ''}`;
  if (+ios[1] === 18 && +ios[2] >= 6) return 'iOS 18.6 o posterior (el iPhone no indica la versión exacta)';
  return `iOS ${reported}`;
}

export function environment() {
  return {
    version: VERSION,
    system: systemName(),
    installed: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    mediaSession: 'mediaSession' in navigator,
    audioSession: navigator.audioSession ? navigator.audioSession.type : null,
    serviceWorker: !!navigator.serviceWorker?.controller,
  };
}

document.addEventListener('visibilitychange', () => log(document.visibilityState === 'hidden' ? 'App en segundo plano / pantalla bloqueada' : 'App en primer plano'));
