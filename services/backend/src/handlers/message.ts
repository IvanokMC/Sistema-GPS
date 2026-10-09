import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/ddb.js';
import { isAllowedDevice } from '../lib/auth.js';
import { TABLE_CONNECTIONS } from '../lib/env.js';
import type { ConnectionRecord } from '../lib/connections.js';
import { broadcastToViewers, endpointFrom, sendTo } from '../lib/broadcast.js';
import { listDevices, savePositions, updateDeviceState } from '../lib/positions.js';
import { parseClientMessage, parsePosition, type Position } from '@gps/shared';

/**
 * Ruta $default: unico punto de entrada para todos los mensajes ya
 * establecida la conexion. Enruta por el campo `action` del payload.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = endpointFrom(domainName, stage);

  const message = parseClientMessage(event.body ?? '');
  if (!message) {
    await sendTo(endpoint, connectionId, {
      type: 'error',
      payload: { code: 'BAD_REQUEST', message: 'Mensaje JSON invalido o accion desconocida' },
    });
    return { statusCode: 400, body: 'bad request' };
  }

  const stored = await ddb.send(
    new GetCommand({ TableName: TABLE_CONNECTIONS(), Key: { connectionId } }),
  );
  const connection = stored.Item as ConnectionRecord | undefined;
  if (!connection) {
    return { statusCode: 410, body: 'conexion desconocida' };
  }

  switch (message.action) {
    case 'ping': {
      await sendTo(endpoint, connectionId, {
        type: 'pong',
        payload: { t: message.payload?.t ?? 0, serverTime: Date.now() },
      });
      return { statusCode: 200, body: 'pong' };
    }

    case 'subscribe': {
      const deviceIds = Array.isArray(message.payload?.deviceIds)
        ? message.payload.deviceIds.filter((d) => typeof d === 'string').slice(0, 100)
        : ['*'];

      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_CONNECTIONS(),
          Key: { connectionId },
          UpdateExpression: 'SET subscriptions = :s',
          ExpressionAttributeValues: { ':s': deviceIds },
        }),
      );

      const devices = await listDevices();
      const visible = deviceIds.includes('*')
        ? devices
        : devices.filter((d) => deviceIds.includes(d.deviceId));

      await sendTo(endpoint, connectionId, {
        type: 'snapshot',
        payload: { devices: visible },
      });
      return { statusCode: 200, body: 'subscribed' };
    }

    case 'position':
    case 'positionBatch': {
      if (connection.role !== 'tracker' || !connection.deviceId || !isAllowedDevice(connection.deviceId)) {
        await sendTo(endpoint, connectionId, {
          type: 'error',
          payload: { code: 'FORBIDDEN', message: 'Solo un tracker puede enviar posiciones' },
        });
        return { statusCode: 403, body: 'forbidden' };
      }

      const raw =
        message.action === 'position'
          ? [message.payload]
          : (message.payload?.positions ?? []);

      const now = Date.now();
      const accepted: Position[] = [];
      for (const item of raw.slice(0, 200)) {
        const position = parsePosition(item, now);
        // El deviceId autenticado manda: un cliente no puede escribir en la
        // pista de otro dispositivo aunque lo declare en el payload.
        if (position) {
          accepted.push({ ...position, deviceId: connection.deviceId });
        }
      }

      const rejected = raw.length - accepted.length;

      if (accepted.length > 0) {
        await savePositions(accepted);

        const latest = accepted.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
        await updateDeviceState(latest);

        // Al dashboard solo le interesa dibujar; le mandamos el lote completo
        // para que la linea del recorrido no pierda puntos tras un corte de red.
        for (const position of accepted) {
          await broadcastToViewers(endpoint, position.deviceId, {
            type: 'position',
            payload: position,
          });
        }
      }

      await sendTo(endpoint, connectionId, {
        type: 'ack',
        payload: { accepted: accepted.length, rejected, serverTime: Date.now() },
      });

      return { statusCode: 200, body: 'ok' };
    }
  }
};
