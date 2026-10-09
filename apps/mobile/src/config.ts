/**
 * Configuracion leida de variables EXPO_PUBLIC_* (archivo .env).
 * Expo las incrusta en el bundle en tiempo de compilacion, asi que cambiar
 * el .env exige reiniciar el servidor de Metro con --clear.
 */

/**
 * Deriva la URL de la API HTTP a partir de la del WebSocket.
 *
 * En AWS ambas viven en dominios distintos, asi que se puede fijar aparte con
 * EXPO_PUBLIC_API_URL. Para el servidor local de desarrollo, que sirve las dos
 * cosas en el mismo puerto, basta con cambiar el esquema.
 */
function derivarApiUrl(wsUrl: string): string {
  const explicita = process.env.EXPO_PUBLIC_API_URL;
  if (explicita) return explicita.replace(/\/$/, '');
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/prod$/, '');
}

const WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? 'ws://localhost:8080';

export const CONFIG = {
  wsUrl: WS_URL,

  /**
   * API HTTP de ingesta. La tarea de segundo plano envia por aqui y no por
   * WebSocket: el sistema la despierta en un contexto efimero que puede
   * destruirse antes de que un handshake llegue a completarse, mientras que
   * una peticion HTTP se resuelve en una sola operacion.
   */
  apiUrl: derivarApiUrl(WS_URL),
  /** Credencial de escritura. El dashboard tiene otra, que solo permite leer. */
  authToken: process.env.EXPO_PUBLIC_DEVICE_TOKEN ?? process.env.EXPO_PUBLIC_AUTH_TOKEN ?? 'dev-device',

  /** Nombre de la tarea registrada en TaskManager para el rastreo en segundo plano. */
  backgroundTaskName: 'gps-background-location',

  /**
   * Cada cuanto pide el sistema una lectura, en milisegundos.
   *
   * 2 s da una ruta con curvas suaves incluso en vehiculo (a 40 km/h, un
   * punto cada 22 m). El filtro de envio decide despues cuales se transmiten,
   * asi que un intervalo corto no multiplica el trafico estando quieto.
   */
  locationIntervalMs: 2_000,

  /**
   * Metros de movimiento que el sistema exige antes de entregar una lectura.
   *
   * Debe quedar en 0. Con cualquier valor mayor, Android deja de entregar
   * lecturas mientras el dispositivo esta quieto y el latido periodico nunca
   * llega a evaluarse. El filtrado lo hace la app, no el sistema.
   */
  locationDistanceM: 0,

  /** Filtro de envio (ver createReportFilter en @gps/shared). */
  report: {
    /** Lecturas con peor precision no forman parte de la ruta. */
    maxAccuracyM: 35,
    /** Aunque no se mueva, un envio cada 30 s demuestra que sigue vivo. */
    heartbeatMs: 30_000,
    /** En movimiento, al menos un punto cada 4 s para que la linea no se corte. */
    movingIntervalMs: 4_000,
    /** Desplazamiento minimo; se agranda solo si la precision es peor. */
    minDistanceM: 6,
    /** Lecturas en cache mas viejas que esto se ignoran: dibujarian una
     *  linea desde donde estuviste antes hasta donde estas ahora. */
    maxAgeMs: 30_000,
  },

  /** Tiempo maximo de espera de una peticion antes de darla por fallida. */
  requestTimeoutMs: 10_000,

  /** Tope de posiciones guardadas mientras no hay red. */
  offlineQueueLimit: 2_000,
} as const;
