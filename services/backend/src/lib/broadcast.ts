import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { deleteConnection, isSubscribed, listViewers } from './connections.js';
import type { ServerEvent } from '@gps/shared';

let cached: ApiGatewayManagementApiClient | undefined;

function apiClient(endpoint: string): ApiGatewayManagementApiClient {
  if (!cached) {
    cached = new ApiGatewayManagementApiClient({ endpoint });
  }
  return cached;
}

/** Envia un evento a una sola conexion. Devuelve false si ya estaba cerrada. */
export async function sendTo(
  endpoint: string,
  connectionId: string,
  event: ServerEvent,
): Promise<boolean> {
  try {
    await apiClient(endpoint).send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(event)),
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof GoneException) {
      // El cliente se fue sin avisar: limpiamos la fila para no reintentar siempre.
      await deleteConnection(connectionId).catch(() => undefined);
      return false;
    }
    console.error('Error enviando a la conexion', connectionId, error);
    return false;
  }
}

/**
 * Difunde un evento a todos los dashboards suscritos al dispositivo.
 * Los envios van en paralelo porque un viewer lento no debe retrasar al resto.
 */
export async function broadcastToViewers(
  endpoint: string,
  deviceId: string,
  event: ServerEvent,
): Promise<number> {
  const viewers = await listViewers();
  const targets = viewers.filter((v) => isSubscribed(v, deviceId));

  const results = await Promise.all(
    targets.map((v) => sendTo(endpoint, v.connectionId, event)),
  );
  return results.filter(Boolean).length;
}

/** Construye la URL de callback de API Gateway a partir del contexto del evento. */
export function endpointFrom(domainName: string, stage: string): string {
  return `https://${domainName}/${stage}`;
}
