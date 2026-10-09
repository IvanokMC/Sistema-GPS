import { MOTION_LABEL, MOTION_MODES, type MotionMode } from '@gps/shared';

/**
 * Color por modo de movimiento.
 *
 * Los tres modos en movimiento usan las tres primeras posiciones de una
 * paleta categorica validada (daltonismo y contraste) sobre el fondo del
 * panel, en todas las combinaciones de pares, porque en el mapa pueden
 * aparecer los tres a la vez. "Detenido" va en gris neutro: no es un tipo de
 * trayecto sino su ausencia.
 *
 * Orden fijo: un modo conserva su color aunque los demas no aparezcan.
 */
export const MODE_COLOR: Record<MotionMode, string> = {
  quieto: '#898781',
  caminando: '#3987e5',
  corriendo: '#d95926',
  vehiculo: '#199e70',
};

export { MOTION_LABEL, MOTION_MODES };
export type { MotionMode };
