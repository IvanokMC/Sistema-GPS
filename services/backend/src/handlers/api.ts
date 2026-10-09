import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  deleteDeviceData,
  getHistory,
  listDevices,
  savePositions,
  updateDeviceState,
} from '../lib/positions.js';
import { POSITION_TTL_SECONDS } from '../lib/env.js';
import { broadcastToViewers } from '../lib/broadcast.js';
import { isAllowedDevice, roleFor } from '../lib/auth.js';
import { parsePosition, trackLengthMeters, type Position } from '@gps/shared';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'content-type': 'application/json',
};

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: CORS,
  body: JSON.stringify(body),
});

/**
 * API HTTP del sistema.
 *
 *   POST /positions                     -> ingesta de coordenadas
 *   GET  /devices                       -> dispositivos y ultimo estado
 *   GET  /devices/{deviceId}/history    -> recorrido historico
 *        ?from=<epoch ms>&to=<epoch ms>&limit=<n>
 *
 * La ingesta existe ademas del WebSocket porque la tarea de segundo plano del
 * telefono vive en un contexto efimero: el sistema la despierta, le entrega
 * una lectura y puede destruirla enseguida. Un WebSocket necesita completar
 * un handshake y mantenerse vivo, algo que ese contexto no garantiza; una
 * peticion HTTP, en cambio, se resuelve en una sola operacion.
 *
 * El WebSocket sigue siendo el canal del dashboard, que sí tiene una pagina
 * abierta sosteniendo la conexion.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const role = roleFor(event.headers?.authorization);
  if (!role) return json(401, { error: 'No autorizado' });

  const path = event.rawPath ?? '';
  const method = event.requestContext?.http?.method ?? 'GET';
  const params = event.queryStringParameters ?? {};

  /* ------------------------------- Ingesta ------------------------------- */

  if (method === 'POST' && path.endsWith('/positions')) {
    // El token de lectura viaja en el dashboard publico: no sirve para escribir.
    if (role !== 'device') return json(403, { error: 'Esta credencial solo permite lectura' });

    let payload: unknown;
    try {
      payload = JSON.parse(event.body ?? '');
    } catch {
      return json(400, { error: 'JSON invalido' });
    }

    const entrada = Array.isArray(payload)
      ? payload
      : ((payload as { positions?: unknown[] })?.positions ?? [payload]);

    const now = Date.now();
    const aceptadas: Position[] = [];
    const ajenos = new Set<string>();
    for (const item of entrada.slice(0, 200)) {
      const position = parsePosition(item, now);
      if (!position) continue;
      // Aunque alguien obtenga la credencial, solo los dispositivos de la
      // lista pueden aparecer en el mapa.
      if (!isAllowedDevice(position.deviceId)) {
        ajenos.add(position.deviceId);
        continue;
      }
      aceptadas.push(position);
    }

    if (ajenos.size > 0 && aceptadas.length === 0) {
      return json(403, { error: 'Dispositivo no autorizado', devices: [...ajenos] });
    }

    if (aceptadas.length === 0) {
      return json(400, { error: 'Ninguna posicion valida', accepted: 0 });
    }

    await savePositions(aceptadas);

    const ultima = aceptadas.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    await updateDeviceState(ultima);

    // Difusion al dashboard. Si falla, la coordenada ya quedo guardada: el
    // mapa se pondra al dia con la siguiente, asi que no abortamos la ingesta.
    const endpoint = process.env.WS_ENDPOINT;
    if (endpoint) {
      try {
        for (const position of aceptadas) {
          await broadcastToViewers(endpoint, position.deviceId, {
            type: 'position',
            payload: position,
          });
        }
      } catch (error) {
        console.error('Fallo la difusion al dashboard:', error);
      }
    }

    return json(200, {
      accepted: aceptadas.length,
      rejected: entrada.length - aceptadas.length,
      serverTime: Date.now(),
    });
  }

  /* --------------------------- Fin del rastreo ---------------------------- */

  // DELETE /devices/{deviceId}: el celular detuvo el rastreo; se borra todo lo
  // suyo de inmediato en vez de esperar a que venza la retencion.
  const borrar = path.match(/\/devices\/([^/]+)$/);
  if (method === 'DELETE' && borrar) {
    if (role !== 'device') return json(403, { error: 'Esta credencial solo permite lectura' });
    const deviceId = decodeURIComponent(borrar[1]);
    if (!isAllowedDevice(deviceId)) return json(400, { error: 'Identificador no valido' });

    const borradas = await deleteDeviceData(deviceId);
    const endpoint = process.env.WS_ENDPOINT;
    if (endpoint) {
      try {
        await broadcastToViewers(endpoint, deviceId, { type: 'removed', payload: { deviceId } });
      } catch (error) {
        console.error('Fallo el aviso de borrado al dashboard:', error);
      }
    }
    return json(200, { deviceId, borradas });
  }

  /* ------------------------------ Consultas ------------------------------ */

  if (path.endsWith('/devices')) {
    return json(200, { devices: await listDevices() });
  }

  const match = path.match(/\/devices\/([^/]+)\/history$/);
  if (match) {
    const deviceId = decodeURIComponent(match[1]);
    const to = Number(params.to) || Date.now();
    // Por defecto, toda la ventana de retencion (5 minutos).
    const from = Number(params.from) || to - POSITION_TTL_SECONDS * 1000;
    const limit = Math.min(Number(params.limit) || 2000, 5000);

    const positions = await getHistory(deviceId, from, to, limit);
    return json(200, {
      deviceId,
      from,
      to,
      count: positions.length,
      distanceMeters: Math.round(trackLengthMeters(positions)),
      positions,
    });
  }

  return json(404, { error: 'Ruta no encontrada' });
};
