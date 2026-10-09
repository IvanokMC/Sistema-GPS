/** Lee una variable de entorno obligatoria y falla rapido si falta. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const TABLE_CONNECTIONS = () => requireEnv('TABLE_CONNECTIONS');
export const TABLE_POSITIONS = () => requireEnv('TABLE_POSITIONS');
export const TABLE_DEVICES = () => requireEnv('TABLE_DEVICES');

/**
 * Ventana de retencion del historial, en segundos. Por defecto 10 minutos.
 *
 * Cumple dos funciones distintas:
 *
 *  1. Marca de expiracion (TTL) para que DynamoDB borre las filas viejas sin
 *     que haya que administrar nada. El borrado fisico es *diferido*: AWS no
 *     garantiza el instante exacto, solo que ocurrira despues del vencimiento.
 *
 *  2. Filtro de lectura. Como el borrado fisico se retrasa, las consultas
 *     acotan ademas por marca de tiempo. Asi, aunque una fila vencida siga
 *     ocupando espacio un rato mas, nunca se devuelve al cliente y la ventana
 *     observable es exacta.
 */
export const POSITION_TTL_SECONDS = Number(process.env.POSITION_TTL_SECONDS ?? '600');

/** Instante a partir del cual una posicion se considera vigente. */
export function retentionCutoffMs(now = Date.now()): number {
  return now - POSITION_TTL_SECONDS * 1000;
}
