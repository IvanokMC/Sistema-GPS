import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { cleanLabel } from '@gps/shared';

export interface Identidad {
  /** Unico por instalacion. Lo que distingue a este celular en el mapa. */
  id: string;
  /** Nombre que se muestra en el dashboard. */
  nombre: string;
}

const CLAVE_ID = 'gps.identidad.id.v1';
const CLAVE_NOMBRE = 'gps.identidad.nombre.v1';

/**
 * Antes el identificador venia fijo dentro del APK ("oppo-a78"). Cualquier
 * celular que instalara esa misma app decia ser el Oppo: el servidor veia un
 * solo dispositivo, con las ubicaciones de ambos mezcladas, y el mapa mostraba
 * a veces uno y a veces el otro.
 *
 * Ahora cada instalacion genera el suyo la primera vez y lo guarda: el modelo
 * del telefono mas un sufijo aleatorio, p. ej. "cph2565-k3f9qz".
 */
let cache: Identidad | null = null;
let pendiente: Promise<Identidad> | null = null;

function nombrePorDefecto(): string {
  if (Platform.OS === 'web') return 'Navegador';
  // El nombre que el usuario le puso al telefono en Ajustes, si existe.
  const propio = cleanLabel(Device.deviceName ?? undefined);
  if (propio) return propio;
  const marca = Device.manufacturer ?? Device.brand ?? '';
  const modelo = Device.modelName ?? 'Celular';
  return cleanLabel(`${marca} ${modelo}`) ?? 'Celular';
}

function generarId(): string {
  const base = (Platform.OS === 'web' ? 'web' : (Device.modelName ?? 'celular'))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'celular';
  const sufijo = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${base}-${sufijo}`;
}

async function cargar(): Promise<Identidad> {
  let id: string | null = null;
  let nombre: string | null = null;
  try {
    [id, nombre] = await Promise.all([AsyncStorage.getItem(CLAVE_ID), AsyncStorage.getItem(CLAVE_NOMBRE)]);
  } catch {
    // Sin almacenamiento se usa uno temporal; la siguiente apertura reintentara guardarlo.
  }
  if (!id) {
    id = generarId();
    try {
      await AsyncStorage.setItem(CLAVE_ID, id);
    } catch {
      /* se reintenta al reabrir */
    }
  }
  return { id, nombre: nombre || nombrePorDefecto() };
}

/** Identidad de este celular. Se resuelve una vez y queda en memoria. */
export function identidad(): Promise<Identidad> {
  if (cache) return Promise.resolve(cache);
  pendiente ??= cargar().then((i) => (cache = i));
  return pendiente;
}

/** Cambia el nombre visible. El identificador no cambia nunca. */
export async function renombrar(nombre: string): Promise<Identidad> {
  const actual = await identidad();
  const limpio = cleanLabel(nombre) ?? nombrePorDefecto();
  cache = { ...actual, nombre: limpio };
  try {
    await AsyncStorage.setItem(CLAVE_NOMBRE, limpio);
  } catch {
    /* el nombre dura hasta cerrar la app */
  }
  return cache;
}
