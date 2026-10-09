/**
 * Autenticacion del sistema.
 *
 * Hay dos credenciales con permisos distintos, y una lista de dispositivos:
 *
 *   DEVICE_TOKEN   escritura. Solo lo tiene la app del celular.
 *   VIEWER_TOKEN   lectura. Lo lleva el dashboard.
 *   ALLOWED_DEVICES  identificadores que pueden enviar posiciones.
 *
 * La separacion importa porque el dashboard es una pagina publica: su token
 * viaja dentro del JavaScript y cualquiera puede leerlo. Con un unico token,
 * leerlo bastaba para inyectar posiciones falsas. Ahora ese token solo permite
 * mirar.
 */
import { isValidDeviceId } from '@gps/shared';

export type Role = 'device' | 'viewer';

/** Comparacion en tiempo constante para no filtrar el token caracter por caracter. */
function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function roleFor(token: string | undefined | null): Role | null {
  const t = (token ?? '').replace(/^Bearer\s+/i, '');
  if (timingSafeEqual(t, process.env.DEVICE_TOKEN ?? '')) return 'device';
  if (timingSafeEqual(t, process.env.VIEWER_TOKEN ?? '')) return 'viewer';
  return null;
}

export function allowedDevices(): string[] {
  return (process.env.ALLOWED_DEVICES ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * Con "*" en la lista, cualquier celular que tenga la app puede aparecer: la
 * unica barrera es la credencial de escritura incrustada en la app. Sin "*",
 * solo los identificadores listados.
 */
export function isAllowedDevice(deviceId: string): boolean {
  if (!isValidDeviceId(deviceId)) return false;
  const lista = allowedDevices();
  return lista.includes('*') || lista.includes(deviceId);
}
