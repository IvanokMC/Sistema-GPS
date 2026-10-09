import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceState, Position, ServerEvent } from '@gps/shared';
import { API_URL, RETENTION_MS, VIEWER_TOKEN, WS_URL } from './config';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface TrackerData {
  status: ConnectionStatus;
  devices: Record<string, DeviceState>;
  /** Lecturas crudas por dispositivo: ordenadas, sin duplicados y dentro de la ventana. */
  positions: Record<string, Position[]>;
  /** Cargando el historial desde la API. */
  loading: boolean;
  error: string | null;
}

/**
 * Inserta lecturas nuevas en una lista ya ordenada, sin duplicar.
 *
 * Las lecturas no llegan en orden: la cola del celular reenvia en lote lo
 * acumulado sin red, y el historial pedido por HTTP se superpone a lo que ya
 * llego por WebSocket. Anadir al final sin mas era lo que hacia que la linea
 * volviera hacia puntos antiguos.
 */
function fusionar(actuales: Position[] | undefined, nuevas: Position[], desde: number): Position[] {
  const porHora = new Map<number, Position>();
  for (const p of actuales ?? []) if (p.timestamp >= desde) porHora.set(p.timestamp, p);
  for (const p of nuevas) if (p.timestamp >= desde) porHora.set(p.timestamp, p);
  return [...porHora.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function pedir<T>(ruta: string): Promise<T> {
  const r = await fetch(`${API_URL}${ruta}`, {
    headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
  });
  if (!r.ok) throw new Error(`La API respondio ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Conexion en vivo con el backend.
 *
 * - Al conectar, pide el historial de la ventana por HTTP: recargar la
 *   pagina no pierde el recorrido.
 * - Reconecta sola con espera creciente.
 * - Cada intento de conexion tiene su propia bandera de cancelacion. La
 *   version anterior compartia una sola entre intentos: al desmontarse y
 *   volver a montarse el componente, el socket viejo se reactivaba y
 *   convivian dos conexiones, cada punto llegaba dos veces y la linea se
 *   dibujaba encima de si misma.
 */
export function useTracker() {
  const [data, setData] = useState<TrackerData>({
    status: 'connecting',
    devices: {},
    positions: {},
    loading: true,
    error: null,
  });

  const recargarRef = useRef<() => Promise<void>>(async () => undefined);

  const agregar = useCallback((nuevas: Position[]) => {
    if (nuevas.length === 0) return;
    const desde = Date.now() - RETENTION_MS;
    setData((prev) => {
      const positions = { ...prev.positions };
      const devices = { ...prev.devices };
      for (const deviceId of new Set(nuevas.map((p) => p.deviceId))) {
        const propias = nuevas.filter((p) => p.deviceId === deviceId);
        positions[deviceId] = fusionar(positions[deviceId], propias, desde);
        const ultima = positions[deviceId][positions[deviceId].length - 1];
        const previa = devices[deviceId];
        // Una lectura atrasada no debe retroceder la posicion actual.
        if (ultima && (!previa?.lastPosition || previa.lastPosition.timestamp <= ultima.timestamp)) {
          devices[deviceId] = { ...previa, deviceId, lastPosition: ultima, lastSeen: Date.now(), online: true };
        }
      }
      return { ...prev, positions, devices };
    });
  }, []);

  const cargarHistorial = useCallback(
    async (deviceIds: string[]) => {
      setData((prev) => ({ ...prev, loading: true }));
      try {
        const resultados = await Promise.all(
          deviceIds.map((id) =>
            pedir<{ positions: Position[] }>(`/devices/${encodeURIComponent(id)}/history`),
          ),
        );
        agregar(resultados.flatMap((r) => r.positions));
        setData((prev) => ({ ...prev, loading: false, error: null }));
      } catch (e) {
        setData((prev) => ({
          ...prev,
          loading: false,
          error: e instanceof Error ? e.message : 'No se pudo cargar el historial',
        }));
      }
    },
    [agregar],
  );

  useEffect(() => {
    let cancelado = false;
    let socket: WebSocket | null = null;
    let reintento = 0;
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    let latido: ReturnType<typeof setInterval> | undefined;

    const conectar = () => {
      if (cancelado) return;
      setData((prev) => ({ ...prev, status: 'connecting' }));

      const actual = new WebSocket(`${WS_URL}?token=${encodeURIComponent(VIEWER_TOKEN)}&role=viewer`);
      socket = actual;
      // Los eventos de un socket que ya no es el vigente se ignoran.
      const vigente = () => !cancelado && socket === actual;

      actual.onopen = () => {
        if (!vigente()) return;
        reintento = 0;
        setData((prev) => ({ ...prev, status: 'online' }));
        actual.send(JSON.stringify({ action: 'subscribe', payload: { deviceIds: ['*'] } }));
        // API Gateway corta las conexiones inactivas a los 10 minutos.
        latido = setInterval(() => {
          if (actual.readyState === WebSocket.OPEN) {
            actual.send(JSON.stringify({ action: 'ping', payload: { t: Date.now() } }));
          }
        }, 4 * 60_000);
      };

      actual.onmessage = (event) => {
        if (!vigente()) return;
        let parsed: ServerEvent;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (parsed.type === 'snapshot') {
          const devices: Record<string, DeviceState> = {};
          for (const d of parsed.payload.devices) devices[d.deviceId] = d;
          setData((prev) => ({ ...prev, devices: { ...prev.devices, ...devices } }));
          void cargarHistorial(Object.keys(devices));
        } else if (parsed.type === 'position') {
          agregar([parsed.payload]);
        } else if (parsed.type === 'removed') {
          // El celular detuvo el rastreo y sus datos se borraron: sale del mapa.
          const { deviceId } = parsed.payload;
          setData((prev) => {
            const devices = { ...prev.devices };
            const positions = { ...prev.positions };
            delete devices[deviceId];
            delete positions[deviceId];
            return { ...prev, devices, positions };
          });
        } else if (parsed.type === 'device') {
          const d = parsed.payload;
          setData((prev) => ({
            ...prev,
            devices: { ...prev.devices, [d.deviceId]: { ...prev.devices[d.deviceId], ...d } },
          }));
        }
      };

      actual.onclose = () => {
        if (latido) clearInterval(latido);
        if (!vigente()) return;
        setData((prev) => ({ ...prev, status: 'offline' }));
        const espera = Math.min(1000 * 2 ** reintento, 15_000);
        reintento++;
        temporizador = setTimeout(conectar, espera);
      };

      actual.onerror = () => actual.close();
    };

    recargarRef.current = async () => {
      const ids = await pedir<{ devices: DeviceState[] }>('/devices')
        .then((r) => r.devices.map((d) => d.deviceId))
        .catch(() => []);
      await cargarHistorial(ids);
    };

    conectar();

    return () => {
      cancelado = true;
      if (temporizador) clearTimeout(temporizador);
      if (latido) clearInterval(latido);
      socket?.close();
    };
  }, [agregar, cargarHistorial]);

  // Lo que sale de la ventana se descarta tambien aqui, igual que en el servidor.
  useEffect(() => {
    const id = setInterval(() => {
      const desde = Date.now() - RETENTION_MS;
      setData((prev) => {
        let cambio = false;
        const positions: Record<string, Position[]> = {};
        for (const [k, lista] of Object.entries(prev.positions)) {
          const vigentes = lista.filter((p) => p.timestamp >= desde);
          if (vigentes.length !== lista.length) cambio = true;
          positions[k] = vigentes;
        }
        return cambio ? { ...prev, positions } : prev;
      });
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  const recargar = useCallback(() => recargarRef.current(), []);

  return { ...data, recargar };
}
