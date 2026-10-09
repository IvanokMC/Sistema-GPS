import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { TABLE_CONNECTIONS } from './env.js';
import type { ClientRole } from '@gps/shared';

export interface ConnectionRecord {
  connectionId: string;
  role: ClientRole;
  deviceId?: string;
  /** Lista de deviceId que el viewer quiere seguir, o ['*'] para todos. */
  subscriptions?: string[];
  connectedAt: number;
  /** Epoch en SEGUNDOS: DynamoDB limpia conexiones zombie automaticamente. */
  ttl: number;
}

/** Las conexiones WebSocket de API Gateway expiran a las 2 horas. */
const CONNECTION_TTL_SECONDS = 2 * 60 * 60;

export async function saveConnection(
  record: Omit<ConnectionRecord, 'ttl' | 'connectedAt'>,
): Promise<void> {
  const now = Date.now();
  await ddb.send(
    new PutCommand({
      TableName: TABLE_CONNECTIONS(),
      Item: {
        ...record,
        connectedAt: now,
        ttl: Math.floor(now / 1000) + CONNECTION_TTL_SECONDS,
      } satisfies ConnectionRecord,
    }),
  );
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_CONNECTIONS(),
      Key: { connectionId },
    }),
  );
}

/**
 * Devuelve las conexiones de dashboards activas.
 *
 * Usa el GSI por rol en vez de un Scan para que el costo no crezca con el
 * numero de trackers conectados: cada posicion que entra dispara esta consulta.
 */
export async function listViewers(): Promise<ConnectionRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CONNECTIONS(),
      IndexName: 'role-index',
      KeyConditionExpression: '#role = :role',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': 'viewer' satisfies ClientRole },
    }),
  );
  return (result.Items ?? []) as ConnectionRecord[];
}

/** Solo para depuracion: lista todas las conexiones. */
export async function listAllConnections(): Promise<ConnectionRecord[]> {
  const result = await ddb.send(new ScanCommand({ TableName: TABLE_CONNECTIONS() }));
  return (result.Items ?? []) as ConnectionRecord[];
}

/** Un viewer recibe la posicion si sigue a ese dispositivo o se suscribio a todos. */
export function isSubscribed(conn: ConnectionRecord, deviceId: string): boolean {
  const subs = conn.subscriptions;
  if (!subs || subs.length === 0) return true;
  return subs.includes('*') || subs.includes(deviceId);
}
