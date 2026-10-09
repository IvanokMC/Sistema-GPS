import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { CONFIG } from './config';
import { uplink } from './uplink';
import { identidad, type Identidad } from './identity';
import type { Position } from '@gps/shared';

/** Convierte una lectura de expo-location al formato del protocolo. */
export function toPosition(
  location: Location.LocationObject,
  yo: Identidad,
  battery?: number,
): Position {
  return {
    deviceId: yo.id,
    label: yo.nombre,
    lat: location.coords.latitude,
    lng: location.coords.longitude,
    accuracy: location.coords.accuracy ?? undefined,
    altitude: location.coords.altitude ?? undefined,
    // Android devuelve -1 cuando no puede calcular velocidad o rumbo.
    speed: location.coords.speed != null && location.coords.speed >= 0
      ? location.coords.speed
      : undefined,
    heading: location.coords.heading != null && location.coords.heading >= 0
      ? location.coords.heading
      : undefined,
    timestamp: location.timestamp || Date.now(),
    battery,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Tarea de segundo plano                             */
/* -------------------------------------------------------------------------- */

/**
 * expo-location entrega aqui las lecturas cuando la app no esta en primer
 * plano. La tarea debe registrarse en el ambito del modulo (no dentro de un
 * componente) porque el sistema puede reactivarla sin que la interfaz exista.
 */
TaskManager.defineTask(CONFIG.backgroundTaskName, async ({ data, error }) => {
  if (error) {
    console.error('Tarea de ubicacion:', error.message);
    return;
  }

  const locations = (data as { locations?: Location.LocationObject[] })?.locations ?? [];
  if (locations.length === 0) return;

  let battery: number | undefined;
  try {
    battery = await Battery.getBatteryLevelAsync();
  } catch {
    battery = undefined;
  }

  await uplink.connect();

  // El sistema puede entregar varias lecturas juntas y no siempre en orden.
  const ordenadas = [...locations].sort((a, b) => a.timestamp - b.timestamp);
  console.log('[gps] tarea:', ordenadas.length, 'lectura(s), precision', ordenadas.map((l) => Math.round(l.coords.accuracy ?? -1)).join(','));

  const yo = await identidad();
  for (const location of ordenadas) {
    await uplink.push(toPosition(location, yo, battery));
  }
});

/* -------------------------------------------------------------------------- */
/*                                 Permisos                                   */
/* -------------------------------------------------------------------------- */

export interface PermissionResult {
  foreground: boolean;
  background: boolean;
  message: string;
}

/**
 * Pide los permisos en el orden que exige Android 11+: primero el de uso en
 * primer plano y solo despues el de segundo plano. Pedirlos juntos hace que
 * el sistema deniegue el segundo sin mostrar el dialogo.
 */
export async function requestPermissions(): Promise<PermissionResult> {
  const foreground = await Location.requestForegroundPermissionsAsync();

  if (foreground.status !== 'granted') {
    return {
      foreground: false,
      background: false,
      message: 'Sin permiso de ubicacion no se puede rastrear nada.',
    };
  }

  // En la web no existe el concepto de segundo plano: el navegador solo
  // reporta mientras la pestaña esta viva.
  if (Platform.OS === 'web') {
    return {
      foreground: true,
      background: false,
      message: 'En navegador el rastreo se detiene al cerrar la pestaña.',
    };
  }

  const background = await Location.requestBackgroundPermissionsAsync();

  return {
    foreground: true,
    background: background.status === 'granted',
    message:
      background.status === 'granted'
        ? 'Permisos completos: el rastreo sigue con la pantalla apagada.'
        : 'Falta "Permitir todo el tiempo" en Ajustes > Apps > Rastreo GPS > Ubicacion. ' +
          'Sin eso el registro se detiene al salir de la app.',
  };
}

/* -------------------------------------------------------------------------- */
/*                            Arranque y parada                               */
/* -------------------------------------------------------------------------- */

export async function isTracking(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  return Location.hasStartedLocationUpdatesAsync(CONFIG.backgroundTaskName);
}

/** Enciende el rastreo continuo. Devuelve un mensaje de estado para la interfaz. */
export async function startTracking(): Promise<string> {
  await uplink.connect();

  if (Platform.OS === 'web') {
    // react-native-web no implementa la tarea de segundo plano; en PC
    // usamos el watcher normal del navegador.
    await startWebWatcher();
    return 'Rastreando desde el navegador.';
  }

  // Pide activar la "precision de ubicacion mejorada" de Google, que combina
  // GPS con WiFi y redes moviles. Sin ella, bajo techo o entre edificios el
  // receptor tarda mucho mas en fijar posicion y la precision cae a 50-100 m.
  // Si el usuario rechaza el dialogo, seguimos solo con GPS.
  try {
    await Location.enableNetworkProviderAsync();
  } catch {
    console.log('[gps] precision mejorada no activada');
  }

  // Volvemos a registrar siempre, incluso si el sistema dice que ya estaba
  // activo. Tras actualizar la aplicacion o si el sistema mata el proceso, el
  // registro puede quedar "a medias": TaskManager lo da por vivo pero la
  // suscripcion real de ubicacion se perdio, y entonces no llega ni una
  // lectura. Al no ser idempotente ese estado, cancelamos y empezamos de cero.
  if (await isTracking()) {
    await Location.stopLocationUpdatesAsync(CONFIG.backgroundTaskName).catch(() => undefined);
  }

  await Location.startLocationUpdatesAsync(CONFIG.backgroundTaskName, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: CONFIG.locationIntervalMs,
    distanceInterval: CONFIG.locationDistanceM,
    // Sin esto ColorOS congela el proceso a los pocos minutos de apagar
    // la pantalla y el rastreo simplemente deja de reportar.
    foregroundService: {
      notificationTitle: 'Rastreo GPS activo',
      notificationBody: 'Registrando tu recorrido en tiempo real',
      notificationColor: '#2563eb',
      killServiceOnDestroy: false,
    },
    // Android agrupa lecturas para ahorrar bateria; 0 = entregarlas al instante.
    deferredUpdatesInterval: 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });

  return 'Rastreo activo, incluso con la pantalla apagada.';
}

export async function stopTracking(): Promise<string> {
  if (Platform.OS === 'web') {
    stopWebWatcher();
  } else if (await isTracking()) {
    await Location.stopLocationUpdatesAsync(CONFIG.backgroundTaskName);
  }
  // Primero se apaga el GPS, despues se borra: asi ninguna lectura tardia
  // vuelve a crear los datos recien borrados.
  const yo = await identidad();
  const borrado = await uplink.borrarDatos(yo.id);
  uplink.disconnect();
  return borrado
    ? 'Rastreo detenido. Tus datos se borraron del servidor.'
    : 'Rastreo detenido. Sin conexión para borrar ahora: el servidor los borrará solo en 10 minutos.';
}

/**
 * Indica si el ahorro de energia esta activo. Con el activado, ColorOS apaga
 * la peticion de ubicacion de las apps en segundo plano a los pocos minutos:
 * fue la causa de que el rastreo se detuviera solo.
 */
export async function isLowPowerMode(): Promise<boolean> {
  try {
    return await Battery.isLowPowerModeEnabledAsync();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                        Rastreo en navegador (PC)                           */
/* -------------------------------------------------------------------------- */

let webSubscription: Location.LocationSubscription | null = null;

async function startWebWatcher(): Promise<void> {
  if (webSubscription) return;
  webSubscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: CONFIG.locationIntervalMs,
      distanceInterval: CONFIG.locationDistanceM,
    },
    (location) => {
      void identidad().then((yo) => uplink.push(toPosition(location, yo)));
    },
  );
}

function stopWebWatcher(): void {
  webSubscription?.remove();
  webSubscription = null;
}
