/**
 * Protocolo de mensajes compartido entre la app movil (tracker),
 * el dashboard web (viewer) y el backend WebSocket en AWS.
 *
 * El mismo protocolo lo habla el servidor local de desarrollo
 * (tools/local-server), de modo que las apps no cambian al pasar a AWS.
 */

/** Rol con el que un cliente abre la conexion WebSocket. */
export type ClientRole = 'tracker' | 'viewer';

/** Una lectura de GPS tomada por un dispositivo. */
export interface Position {
  /** Identificador estable del dispositivo que reporta. */
  deviceId: string;
  /** Latitud en grados decimales (WGS84). */
  lat: number;
  /** Longitud en grados decimales (WGS84). */
  lng: number;
  /** Radio de incertidumbre horizontal en metros. */
  accuracy?: number;
  /** Altitud sobre el nivel del mar en metros. */
  altitude?: number;
  /** Velocidad instantanea en metros por segundo. */
  speed?: number;
  /** Rumbo en grados, 0 = norte, sentido horario. */
  heading?: number;
  /** Momento de la lectura, epoch en milisegundos. */
  timestamp: number;
  /** Nivel de bateria del dispositivo, 0..1. */
  battery?: number;
  /** Nombre legible del dispositivo ("Celular de Ivan", "OPPO CPH2565"). */
  label?: string;
}

/** Estado publicado de un dispositivo, tal como lo ve el dashboard. */
export interface DeviceState {
  deviceId: string;
  label?: string;
  lastPosition?: Position;
  /** Epoch ms de la ultima vez que el backend recibio algo del dispositivo. */
  lastSeen?: number;
  online: boolean;
}

/* -------------------------------------------------------------------------- */
/*                          Cliente  ->  Servidor                             */
/* -------------------------------------------------------------------------- */

/** El tracker envia una sola lectura de GPS. */
export interface PositionMessage {
  action: 'position';
  payload: Position;
}

/**
 * El tracker envia lecturas acumuladas mientras estuvo sin red.
 * Se usa para vaciar la cola offline al reconectar.
 */
export interface PositionBatchMessage {
  action: 'positionBatch';
  payload: { positions: Position[] };
}

/** El viewer pide recibir actualizaciones de ciertos dispositivos. */
export interface SubscribeMessage {
  action: 'subscribe';
  /** Lista de deviceId, o ['*'] para todos. */
  payload: { deviceIds: string[] };
}

/** Latido para mantener viva la conexion y detectar cortes. */
export interface PingMessage {
  action: 'ping';
  payload?: { t: number };
}

export type ClientMessage =
  | PositionMessage
  | PositionBatchMessage
  | SubscribeMessage
  | PingMessage;

/* -------------------------------------------------------------------------- */
/*                          Servidor  ->  Cliente                             */
/* -------------------------------------------------------------------------- */

/** Confirmacion de que el backend acepto y persistio N posiciones. */
export interface AckEvent {
  type: 'ack';
  payload: { accepted: number; rejected: number; serverTime: number };
}

/** Difusion de una posicion nueva hacia los viewers suscritos. */
export interface PositionEvent {
  type: 'position';
  payload: Position;
}

/** Cambio de estado de un dispositivo (se conecto, se desconecto). */
export interface DeviceEvent {
  type: 'device';
  payload: DeviceState;
}

/** Foto inicial del estado que recibe un viewer al suscribirse. */
export interface SnapshotEvent {
  type: 'snapshot';
  payload: { devices: DeviceState[] };
}

/** El dispositivo detuvo el rastreo y sus datos se borraron: quitarlo del mapa. */
export interface DeviceRemovedEvent {
  type: 'removed';
  payload: { deviceId: string };
}

export interface PongEvent {
  type: 'pong';
  payload: { t: number; serverTime: number };
}

export interface ErrorEvent {
  type: 'error';
  payload: { code: string; message: string };
}

export type ServerEvent =
  | AckEvent
  | PositionEvent
  | DeviceEvent
  | SnapshotEvent
  | DeviceRemovedEvent
  | PongEvent
  | ErrorEvent;

/* -------------------------------------------------------------------------- */
/*                               Validacion                                   */
/* -------------------------------------------------------------------------- */

const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Valida una posicion recibida por la red. Devuelve la posicion normalizada
 * o null si el payload no es utilizable. El backend descarta los null en vez
 * de cerrar la conexion, para que un GPS con una lectura mala no tumbe la sesion.
 */
export function parsePosition(input: unknown, now = Date.now()): Position | null {
  if (typeof input !== 'object' || input === null) return null;
  const p = input as Record<string, unknown>;

  const deviceId = typeof p.deviceId === 'string' ? p.deviceId.trim() : '';
  if (!isValidDeviceId(deviceId)) return null;

  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;

  // Un reloj desfasado mas de un dia hace inutilizable el historial ordenado.
  let timestamp = Number(p.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    timestamp = now;
  }

  const optionalNumber = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    deviceId,
    lat,
    lng,
    timestamp,
    accuracy: optionalNumber(p.accuracy),
    altitude: optionalNumber(p.altitude),
    speed: optionalNumber(p.speed),
    heading: optionalNumber(p.heading),
    battery: optionalNumber(p.battery),
    label: cleanLabel(p.label),
  };
}

/**
 * Identificador de dispositivo valido: minusculas, digitos y guiones.
 * Cada instalacion de la app genera el suyo (p. ej. "cph2565-k3f9qz").
 */
export function isValidDeviceId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(id);
}

/** Nombre visible: texto corto, sin caracteres de control. */
export function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const limpio = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return limpio || undefined;
}

/** Parseo defensivo de un mensaje entrante en formato JSON. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const action = (data as Record<string, unknown>).action;
  if (
    action === 'position' ||
    action === 'positionBatch' ||
    action === 'subscribe' ||
    action === 'ping'
  ) {
    return data as ClientMessage;
  }
  return null;
}
