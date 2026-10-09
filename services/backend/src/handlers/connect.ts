import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { saveConnection } from '../lib/connections.js';
import { broadcastToViewers, endpointFrom } from '../lib/broadcast.js';
import { getDevice, updateDeviceState } from '../lib/positions.js';
import type { ClientRole } from '@gps/shared';

/** Ruta $connect: registra la conexion y avisa a los dashboards. */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const { connectionId, domainName, stage } = event.requestContext;

  // El autorizador ya valido estos valores; aqui solo los leemos.
  const authContext = (event.requestContext as unknown as {
    authorizer?: { role?: string; deviceId?: string };
  }).authorizer;

  const role: ClientRole = authContext?.role === 'viewer' ? 'viewer' : 'tracker';
  const deviceId = authContext?.deviceId || undefined;

  await saveConnection({
    connectionId,
    role,
    deviceId,
    subscriptions: role === 'viewer' ? ['*'] : undefined,
  });

  if (role === 'tracker' && deviceId) {
    const existing = await getDevice(deviceId);
    const state = {
      deviceId,
      lastPosition: existing?.lastPosition,
      lastSeen: Date.now(),
      online: true,
    };
    if (existing?.lastPosition) {
      await updateDeviceState(existing.lastPosition);
    }
    await broadcastToViewers(endpointFrom(domainName, stage), deviceId, {
      type: 'device',
      payload: state,
    });
  }

  return { statusCode: 200, body: 'connected' };
};
