import type { Position } from './protocol.js';

const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Distancia en metros entre dos coordenadas (formula de Haversine). */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Longitud total de un recorrido, en metros. */
export function trackLengthMeters(positions: Position[]): number {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    total += distanceMeters(positions[i - 1], positions[i]);
  }
  return total;
}

/**
 * Decide si vale la pena enviar una lectura nueva.
 *
 * El GPS de un celular quieto sigue reportando cada segundo con ruido de
 * varios metros. Enviar todo gasta bateria, datos y writes de DynamoDB, asi
 * que solo transmitimos cuando el dispositivo realmente se movio o cuando
 * paso suficiente tiempo como para querer confirmar que sigue vivo.
 */
export function shouldReport(
  last: Position | null,
  next: Position,
  opts: { minDistanceMeters?: number; maxIntervalMs?: number } = {},
): boolean {
  const minDistance = opts.minDistanceMeters ?? 15;
  const maxInterval = opts.maxIntervalMs ?? 60_000;

  if (!last) return true;
  if (next.timestamp - last.timestamp >= maxInterval) return true;
  return distanceMeters(last, next) >= minDistance;
}

/** Formatea metros como "820 m" o "3.4 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/** Convierte m/s a km/h con un decimal. */
export function formatSpeed(metersPerSecond?: number): string {
  if (metersPerSecond === undefined || !Number.isFinite(metersPerSecond) || metersPerSecond < 0) {
    return '—';
  }
  return `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}

/** Rumbo inicial de a hacia b, en grados: 0 = norte, sentido horario. */
export function bearingDegrees(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const RUMBOS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

/** 0° -> "N", 135° -> "SE"... */
export function compassLabel(degrees: number): string {
  return RUMBOS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

/** Duracion legible: "45 s", "3 min 20 s", "1 h 05 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
