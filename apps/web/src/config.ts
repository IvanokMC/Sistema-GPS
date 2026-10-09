/** Configuracion incrustada al compilar (archivo .env de apps/web). */
export const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080';
export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');

/**
 * Credencial de SOLO LECTURA. Viaja dentro de este JavaScript, asi que
 * cualquiera que abra la pagina puede leerla: por eso no permite escribir.
 */
export const VIEWER_TOKEN =
  import.meta.env.VITE_VIEWER_TOKEN ?? import.meta.env.VITE_AUTH_TOKEN ?? 'dev-viewer';

/** Ventana que conserva el servidor. El dashboard nunca muestra mas que esto. */
export const RETENTION_MS = Number(import.meta.env.VITE_RETENTION_MIN ?? 10) * 60_000;

/** Sin datos durante este tiempo, el dispositivo se muestra como sin señal. */
export const STALE_MS = 90_000;
