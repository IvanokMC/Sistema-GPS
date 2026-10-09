import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/ddb.js';
import { TABLE_CONNECTIONS } from '../lib/env.js';
import { deleteConnection, type ConnectionRecord } from '../lib/connections.js';
import { broadcastToViewers, endpointFrom } from '../lib/broadcast.js';
import { getDevice, markDeviceOffline } from '../lib/positions.js';

/** Ruta $disconnect: limpia la conexion y marca el dispositivo como offline. */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const { connectionId, domainName, stage } = event.requestContext;

  // Leemos la fila antes de borrarla: es donde esta guardado el deviceId.
  const stored = await ddb.send(
    new GetCommand({ TableName: TABLE_CONNECTIONS(), Key: { connectionId } }),
  );
  const record = stored.Item as ConnectionRecord | undefined;

  await deleteConnection(connectionId);

  if (record?.role === 'tracker' && record.deviceId) {
    await markDeviceOffline(record.deviceId);
    const state = await getDevice(record.deviceId);
    await broadcastToViewers(endpointFrom(domainName, stage), record.deviceId, {
      type: 'device',
      payload: state ?? { deviceId: record.deviceId, online: false },
    });
  }

  return { statusCode: 200, body: 'disconnected' };
};
