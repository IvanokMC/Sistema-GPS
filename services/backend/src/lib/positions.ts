import { BatchWriteCommand, DeleteCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { isAllowedDevice } from './auth.js';
import { POSITION_TTL_SECONDS, TABLE_DEVICES, TABLE_POSITIONS, retentionCutoffMs } from './env.js';
import type { DeviceState, Position } from '@gps/shared';

const ttlFor = (timestampMs: number) =>
  Math.floor(timestampMs / 1000) + POSITION_TTL_SECONDS;

/** DynamoDB acepta como maximo 25 items por BatchWrite. */
const BATCH_LIMIT = 25;

/** Guarda el historial de posiciones. La clave (deviceId, timestamp) permite
 *  consultar un rango de tiempo de un dispositivo con un solo Query. */
export async function savePositions(positions: Position[]): Promise<void> {
  if (positions.length === 0) return;

  for (let i = 0; i < positions.length; i += BATCH_LIMIT) {
    const chunk = positions.slice(i, i + BATCH_LIMIT);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_POSITIONS()]: chunk.map((p) => ({
            PutRequest: { Item: { ...p, ttl: ttlFor(p.timestamp) } },
          })),
        },
      }),
    );
  }
}

/** Actualiza la fila "ultimo estado conocido" que lee el dashboard al abrir. */
export async function updateDeviceState(position: Position): Promise<void> {
  // El nombre no viaja en cada lectura: si esta no lo trae, se conserva el guardado.
  const label = position.label ?? (await getDevice(position.deviceId))?.label;
  await ddb.send(
    new PutCommand({
      TableName: TABLE_DEVICES(),
      Item: {
        deviceId: position.deviceId,
        label,
        lastPosition: position,
        lastSeen: Date.now(),
        online: true,
        // La fila del dispositivo tambien caduca: sin esto, cada celular que
        // alguna vez uso la app dejaria una fila para siempre.
        ttl: ttlFor(Date.now()),
      } satisfies DeviceState & { lastSeen: number; ttl: number },
    }),
  );
}

/** Marca un dispositivo como desconectado sin borrar su ultima posicion. */
export async function markDeviceOffline(deviceId: string): Promise<void> {
  const current = await getDevice(deviceId);
  await ddb.send(
    new PutCommand({
      TableName: TABLE_DEVICES(),
      Item: { ...(current ?? { deviceId }), deviceId, online: false, lastSeen: Date.now() },
    }),
  );
}

export async function getDevice(deviceId: string): Promise<DeviceState | undefined> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_DEVICES(),
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
      Limit: 1,
    }),
  );
  return result.Items?.[0] as DeviceState | undefined;
}

export async function listDevices(): Promise<DeviceState[]> {
  const result = await ddb.send(new ScanCommand({ TableName: TABLE_DEVICES() }));
  // El TTL de DynamoDB borra con retraso: una fila vencida puede seguir en la
  // tabla un rato. Se filtra aqui para no mostrar celulares que ya caducaron.
  const vigente = retentionCutoffMs();
  // Filas de dispositivos que ya no estan autorizados (pruebas antiguas) no
  // se muestran: el dashboard solo ve los de la lista vigente.
  return ((result.Items ?? []) as DeviceState[]).filter(
    (d) => isAllowedDevice(d.deviceId) && (d.lastSeen ?? 0) >= vigente,
  );
}

/** Recorrido de un dispositivo entre dos instantes, en orden cronologico. */
export async function getHistory(
  deviceId: string,
  fromMs: number,
  toMs: number,
  limit = 2000,
): Promise<Position[]> {
  // El borrado por TTL es diferido, asi que una fila vencida puede seguir en
  // la tabla. Recortamos el inicio de la consulta a la ventana de retencion
  // para no devolver nunca datos que deberian haber desaparecido.
  const cutoff = retentionCutoffMs();
  const from = Math.max(fromMs, cutoff);

  if (from > toMs) return [];

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_POSITIONS(),
      KeyConditionExpression: 'deviceId = :d AND #ts BETWEEN :from AND :to',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ':d': deviceId, ':from': from, ':to': toMs },
      ScanIndexForward: true,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as Position[];
}

/**
 * Borra todo lo que hay de un dispositivo: su recorrido y su fila de estado.
 * Se usa cuando el celular detiene el rastreo. Devuelve cuantas posiciones borro.
 */
export async function deleteDeviceData(deviceId: string): Promise<number> {
  let borradas = 0;
  let desde: Record<string, unknown> | undefined;
  do {
    const pagina = await ddb.send(
      new QueryCommand({
        TableName: TABLE_POSITIONS(),
        KeyConditionExpression: 'deviceId = :d',
        ExpressionAttributeValues: { ':d': deviceId },
        ProjectionExpression: 'deviceId, #ts',
        ExpressionAttributeNames: { '#ts': 'timestamp' },
        ExclusiveStartKey: desde,
      }),
    );
    const claves = (pagina.Items ?? []) as { deviceId: string; timestamp: number }[];
    for (let i = 0; i < claves.length; i += BATCH_LIMIT) {
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE_POSITIONS()]: claves.slice(i, i + BATCH_LIMIT).map((k) => ({
              DeleteRequest: { Key: { deviceId: k.deviceId, timestamp: k.timestamp } },
            })),
          },
        }),
      );
    }
    borradas += claves.length;
    desde = pagina.LastEvaluatedKey;
  } while (desde);

  await ddb.send(new DeleteCommand({ TableName: TABLE_DEVICES(), Key: { deviceId } }));
  return borradas;
}
