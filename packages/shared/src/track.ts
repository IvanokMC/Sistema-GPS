import { distanceMeters } from './geo.js';
import type { Position } from './protocol.js';

/* -------------------------------------------------------------------------- */
/*                         Clasificacion por velocidad                        */
/* -------------------------------------------------------------------------- */

export type MotionMode = 'quieto' | 'caminando' | 'corriendo' | 'vehiculo';

/** Orden fijo: el color de cada modo nunca depende de cuales aparezcan. */
export const MOTION_MODES: readonly MotionMode[] = ['quieto', 'caminando', 'corriendo', 'vehiculo'];

export const MOTION_LABEL: Record<MotionMode, string> = {
  quieto: 'Detenido',
  caminando: 'Caminando',
  corriendo: 'Corriendo',
  vehiculo: 'En vehículo',
};

/**
 * Limites superiores de cada modo, en m/s.
 *
 *   < 0.6 m/s  (2 km/h)   detenido: por debajo, la oscilacion del GPS
 *   < 2.3 m/s  (8 km/h)   caminando
 *   < 5.5 m/s  (20 km/h)  corriendo (incluye bicicleta lenta)
 *   >= 5.5 m/s            vehiculo
 */
export const MOTION_THRESHOLDS = { quieto: 0.6, caminando: 2.3, corriendo: 5.5 } as const;

export function classifyMotion(speedMs: number): MotionMode {
  if (!Number.isFinite(speedMs) || speedMs < MOTION_THRESHOLDS.quieto) return 'quieto';
  if (speedMs < MOTION_THRESHOLDS.caminando) return 'caminando';
  if (speedMs < MOTION_THRESHOLDS.corriendo) return 'corriendo';
  return 'vehiculo';
}

/* -------------------------------------------------------------------------- */
/*                               Limpieza                                     */
/* -------------------------------------------------------------------------- */

export interface TrackOptions {
  /** Lecturas con peor precision se descartan de la ruta. */
  maxAccuracyM?: number;
  /** Un silencio mas largo que esto corta la ruta en dos tramos sin unir. */
  maxGapMs?: number;
  /** Velocidad imposible: un salto que la supere es un error del GPS. */
  maxSpeedMs?: number;
  /** Solo se consideran lecturas dentro de esta ventana hacia atras. */
  windowMs?: number;
  /** Colapsar las lecturas de una parada en un unico punto. */
  snapStops?: boolean;
  now?: number;
}

const DEFAULTS: Required<Omit<TrackOptions, 'now'>> = {
  maxAccuracyM: 50,
  maxGapMs: 90_000,
  maxSpeedMs: 70,
  windowMs: 5 * 60_000,
  snapStops: true,
};

export interface TrackPoint extends Position {
  /** Velocidad usada para clasificar, ya suavizada. */
  speedMs: number;
  mode: MotionMode;
}

/**
 * Convierte lecturas crudas en una ruta utilizable.
 *
 * Cada paso corrige un defecto que se veia en el mapa:
 *
 *  1. Ordenar por hora: las lecturas que llegan tarde (cola sin red) se
 *     pegaban al final y la linea "volvia" a un punto antiguo.
 *  2. Quitar duplicados: una misma lectura recibida dos veces trazaba la
 *     linea encima de si misma y se veia mas gruesa.
 *  3. Descartar mala precision: una lectura con 150 m de error dibuja un
 *     pico que no existe.
 *  4. Descartar saltos imposibles: un punto que implicaria moverse a mas de
 *     250 km/h es un error del receptor, no un recorrido.
 *  5. Colapsar paradas: estando quieto el GPS oscila varios metros y la
 *     linea formaba un nudo de rayas que parecia conectar muchos puntos.
 */
export function cleanTrack(raw: readonly Position[], options: TrackOptions = {}): TrackPoint[] {
  const o = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const desde = now - o.windowMs;

  // 1 y 2: ventana, orden y duplicados (se conserva la lectura mas precisa).
  const porHora = new Map<number, Position>();
  for (const p of raw) {
    if (p.timestamp < desde || p.timestamp > now + 60_000) continue;
    const previa = porHora.get(p.timestamp);
    if (!previa || (p.accuracy ?? Infinity) < (previa.accuracy ?? Infinity)) {
      porHora.set(p.timestamp, p);
    }
  }
  const ordenadas = [...porHora.values()].sort((a, b) => a.timestamp - b.timestamp);

  // 3: precision.
  const precisas = ordenadas.filter((p) => p.accuracy === undefined || p.accuracy <= o.maxAccuracyM);

  // 4: saltos imposibles.
  const aceptadas = quitarPicos(precisas, o.maxSpeedMs, o.maxGapMs);

  // Velocidad de cada punto: la del GPS si la dio (se calcula por efecto
  // Doppler y es fiable incluso a paso lento); si no, la derivada del
  // desplazamiento, anulando movimientos menores que la incertidumbre.
  const crudas = aceptadas.map((p, i) => {
    if (p.speed !== undefined && p.speed >= 0) return p.speed;
    const previa = aceptadas[i - 1];
    if (!previa) return 0;
    const dt = (p.timestamp - previa.timestamp) / 1000;
    if (dt <= 0 || dt * 1000 > o.maxGapMs) return 0;
    const d = distanceMeters(previa, p);
    const ruido = ((p.accuracy ?? 10) + (previa.accuracy ?? 10)) / 2;
    return d < ruido ? 0 : d / dt;
  });

  // Mediana movil de 5: evita que una lectura aislada cambie el modo y
  // pinte un tramo de un solo punto con otro color.
  const puntos: TrackPoint[] = aceptadas.map((p, i) => {
    const vecinas = crudas.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    const speedMs = vecinas[Math.floor(vecinas.length / 2)];
    return { ...p, speedMs, mode: classifyMotion(speedMs) };
  });

  return o.snapStops ? snapStops(puntos, o.maxGapMs) : puntos;
}

/** Un grupo de este tamaño o menor, aislado por saltos imposibles, es un error. */
const MAX_PUNTOS_PICO = 3;

/** true si ir de a hasta b exige una velocidad imposible. */
function esSalto(a: Position, b: Position, maxSpeedMs: number, maxGapMs: number): boolean {
  const dt = (b.timestamp - a.timestamp) / 1000;
  // Tras un corte largo el dispositivo pudo trasladarse de verdad.
  if (dt <= 0 || dt * 1000 > maxGapMs) return false;
  const d = distanceMeters(a, b);
  const tolerancia = (a.accuracy ?? 0) + (b.accuracy ?? 0);
  return d > tolerancia && d / dt > maxSpeedMs;
}

/**
 * Elimina lecturas erroneas del receptor.
 *
 * La version anterior comparaba cada lectura con la ultima aceptada. Fallaba
 * justo en el caso mas comun: si la PRIMERA lectura era mala (una ubicacion
 * aproximada por antena a varios km), se convertia en la referencia y todas
 * las buenas que venian despues se descartaban por "imposibles" hasta que
 * pasaba el tiempo de corte. El recorrido desaparecia durante minuto y medio.
 *
 * Ahora las lecturas se agrupan en tramos coherentes entre si, y se descartan
 * los grupos pequeños que quedan aislados por un salto imposible, esten antes
 * o despues de los buenos. Se repite hasta que no queda ninguno, porque al
 * quitar un pico, los grupos que separaba pueden volver a ser uno solo.
 */
function quitarPicos(puntos: Position[], maxSpeedMs: number, maxGapMs: number): Position[] {
  let actuales = puntos;
  // Una pasada quita un solo grupo: al quitarlo, los vecinos que separaba
  // pueden volver a formar un grupo coherente, y hay que reevaluar. Quitar
  // varios a la vez descartaba tambien la lectura buena que seguia a un pico.
  for (let vuelta = 0; vuelta < 50; vuelta++) {
    const grupos: Position[][] = [];
    for (const p of actuales) {
      const grupo = grupos[grupos.length - 1];
      if (grupo && !esSalto(grupo[grupo.length - 1], p, maxSpeedMs, maxGapMs)) grupo.push(p);
      else grupos.push([p]);
    }
    if (grupos.length === 1) return actuales;

    const saltos = (i: number) =>
      Number(i > 0 && esSalto(grupos[i - 1][grupos[i - 1].length - 1], grupos[i][0], maxSpeedMs, maxGapMs)) +
      Number(
        i < grupos.length - 1 &&
          esSalto(grupos[i][grupos[i].length - 1], grupos[i + 1][0], maxSpeedMs, maxGapMs),
      );

    const mayor = Math.max(...grupos.map((g) => g.length));
    let peor = -1;
    for (let i = 0; i < grupos.length; i++) {
      const g = grupos[i];
      if (g.length > MAX_PUNTOS_PICO || g.length >= mayor || saltos(i) === 0) continue;
      // Primero los picos claros (salto a ambos lados), luego los mas pequeños.
      if (
        peor < 0 ||
        saltos(i) > saltos(peor) ||
        (saltos(i) === saltos(peor) && g.length < grupos[peor].length)
      ) {
        peor = i;
      }
    }
    if (peor < 0) return actuales;
    actuales = grupos.filter((_, i) => i !== peor).flat();
  }
  return actuales;
}

/**
 * Reemplaza las coordenadas de cada parada por su centro, ponderado por la
 * precision de cada lectura. Asi una parada se dibuja como un punto y no como
 * la maraña de rayas que produce la oscilacion del receptor.
 */
function snapStops(points: TrackPoint[], maxGapMs: number): TrackPoint[] {
  const salida = points.map((p) => ({ ...p }));
  let i = 0;
  while (i < salida.length) {
    if (salida[i].mode !== 'quieto') {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < salida.length &&
      salida[j + 1].mode === 'quieto' &&
      salida[j + 1].timestamp - salida[j].timestamp <= maxGapMs
    ) {
      j++;
    }
    if (j > i) {
      let sw = 0;
      let slat = 0;
      let slng = 0;
      for (let k = i; k <= j; k++) {
        const w = 1 / Math.max(1, salida[k].accuracy ?? 10) ** 2;
        sw += w;
        slat += salida[k].lat * w;
        slng += salida[k].lng * w;
      }
      for (let k = i; k <= j; k++) {
        salida[k].lat = slat / sw;
        salida[k].lng = slng / sw;
      }
    }
    i = j + 1;
  }
  return salida;
}

/* -------------------------------------------------------------------------- */
/*                               Tramos                                       */
/* -------------------------------------------------------------------------- */

/** Porcion continua de un mismo modo. Comparte su primer punto con el tramo
 *  anterior, de modo que los colores se suceden sin huecos en la linea. */
export interface TrackSegment {
  mode: MotionMode;
  points: TrackPoint[];
}

/** Porcion de ruta sin cortes de señal. Dos tramos distintos nunca se unen. */
export interface TrackRun {
  points: TrackPoint[];
  segments: TrackSegment[];
}

export function segmentTrack(points: readonly TrackPoint[], maxGapMs = DEFAULTS.maxGapMs): TrackRun[] {
  const runs: TrackRun[] = [];
  let actual: TrackPoint[] = [];

  const cerrar = () => {
    if (actual.length > 0) runs.push({ points: actual, segments: bySegment(actual) });
    actual = [];
  };

  for (const p of points) {
    const previa = actual[actual.length - 1];
    if (previa && p.timestamp - previa.timestamp > maxGapMs) cerrar();
    actual.push(p);
  }
  cerrar();
  return runs;
}

function bySegment(points: TrackPoint[]): TrackSegment[] {
  const segments: TrackSegment[] = [];
  for (const p of points) {
    const ultimo = segments[segments.length - 1];
    if (ultimo && ultimo.mode === p.mode) {
      ultimo.points.push(p);
    } else {
      // El tramo nuevo arranca en el ultimo punto del anterior: la linea no se corta.
      const union = ultimo ? [ultimo.points[ultimo.points.length - 1]] : [];
      segments.push({ mode: p.mode, points: [...union, p] });
    }
  }
  return segments;
}

/* -------------------------------------------------------------------------- */
/*                              Estadisticas                                  */
/* -------------------------------------------------------------------------- */

export interface Stop {
  lat: number;
  lng: number;
  from: number;
  to: number;
}

export interface TrackStats {
  distanceM: number;
  durationMs: number;
  maxSpeedMs: number;
  /** Velocidad media contando solo el tiempo en movimiento. */
  avgMovingSpeedMs: number;
  timeByMode: Record<MotionMode, number>;
  stops: Stop[];
}

/** Duracion minima para mostrar una parada. */
const MIN_STOP_MS = 30_000;

export function trackStats(points: readonly TrackPoint[], maxGapMs = DEFAULTS.maxGapMs): TrackStats {
  const timeByMode: Record<MotionMode, number> = { quieto: 0, caminando: 0, corriendo: 0, vehiculo: 0 };
  let distanceM = 0;
  let movingMs = 0;
  let movingDistance = 0;
  let maxSpeedMs = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = b.timestamp - a.timestamp;
    if (dt <= 0 || dt > maxGapMs) continue;
    timeByMode[b.mode] += dt;
    if (b.mode !== 'quieto') {
      const d = distanceMeters(a, b);
      distanceM += d;
      movingDistance += d;
      movingMs += dt;
    }
  }
  for (const p of points) maxSpeedMs = Math.max(maxSpeedMs, p.speedMs);

  const stops: Stop[] = [];
  let i = 0;
  while (i < points.length) {
    if (points[i].mode !== 'quieto') {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < points.length && points[j + 1].mode === 'quieto') j++;
    const from = points[i].timestamp;
    const to = points[j].timestamp;
    if (to - from >= MIN_STOP_MS) stops.push({ lat: points[i].lat, lng: points[i].lng, from, to });
    i = j + 1;
  }

  return {
    distanceM,
    durationMs: points.length > 1 ? points[points.length - 1].timestamp - points[0].timestamp : 0,
    maxSpeedMs,
    avgMovingSpeedMs: movingMs > 0 ? movingDistance / (movingMs / 1000) : 0,
    timeByMode,
    stops,
  };
}

/* -------------------------------------------------------------------------- */
/*                      Filtro de envio en el dispositivo                      */
/* -------------------------------------------------------------------------- */

export interface ReportFilterOptions {
  /** Precision minima para enviar una lectura como parte de la ruta. */
  maxAccuracyM: number;
  /** Aunque no se mueva, enviar cada tanto para demostrar que sigue vivo. */
  heartbeatMs: number;
  /** En movimiento, no dejar pasar mas de esto sin enviar un punto. */
  movingIntervalMs: number;
  /** Desplazamiento minimo para considerar que hubo movimiento real. */
  minDistanceM: number;
  /** Lecturas mas viejas que esto (en cache del sistema) se ignoran. */
  maxAgeMs: number;
}

export type ReportDecision =
  | { send: true; position: Position; reason: 'primera' | 'movimiento' | 'intervalo' | 'latido' }
  | { send: false; reason: 'antigua' | 'duplicada' | 'imprecisa' | 'sin-cambio' };

/**
 * Decide, lectura por lectura, que se transmite desde el telefono.
 *
 * El latido se mide con el reloj del telefono y no con la hora de las
 * lecturas: si el sistema entrega varias veces la misma lectura en cache, su
 * hora no avanza y un latido basado en ella nunca se dispararia.
 */
export function createReportFilter(options: ReportFilterOptions) {
  let ultimaEnviada: Position | null = null;
  let enviadaEn = 0;
  let ultimaHoraVista = 0;
  /** Mejor lectura imprecisa desde el ultimo envio, por si toca un latido. */
  let mejorDescartada: Position | null = null;

  function aceptar(
    p: Position,
    now: number,
    reason: 'primera' | 'movimiento' | 'intervalo' | 'latido',
  ): ReportDecision {
    ultimaEnviada = p;
    enviadaEn = now;
    mejorDescartada = null;
    return { send: true, position: p, reason };
  }

  return {
    decide(p: Position, now = Date.now()): ReportDecision {
      if (now - p.timestamp > options.maxAgeMs) return { send: false, reason: 'antigua' };
      if (p.timestamp <= ultimaHoraVista) return { send: false, reason: 'duplicada' };
      ultimaHoraVista = p.timestamp;

      const precisa = p.accuracy === undefined || p.accuracy <= options.maxAccuracyM;
      const tocaLatido = now - enviadaEn >= options.heartbeatMs;

      if (!precisa) {
        if (!mejorDescartada || (p.accuracy ?? Infinity) < (mejorDescartada.accuracy ?? Infinity)) {
          mejorDescartada = p;
        }
        // Bajo techo puede no haber lecturas precisas en mucho rato: el
        // latido envia la mejor disponible para no aparecer desconectado.
        if (tocaLatido && ultimaEnviada) {
          return aceptar(mejorDescartada, now, 'latido');
        }
        if (!ultimaEnviada) return aceptar(p, now, 'primera');
        return { send: false, reason: 'imprecisa' };
      }

      if (!ultimaEnviada) return aceptar(p, now, 'primera');

      const d = distanceMeters(ultimaEnviada, p);
      const umbral = Math.max(options.minDistanceM, (p.accuracy ?? 0) * 0.5);
      const enMovimiento = (p.speed ?? 0) >= MOTION_THRESHOLDS.quieto;

      if (d >= umbral) return aceptar(p, now, 'movimiento');
      if (enMovimiento && now - enviadaEn >= options.movingIntervalMs) {
        return aceptar(p, now, 'intervalo');
      }
      if (tocaLatido) return aceptar(p, now, 'latido');
      return { send: false, reason: 'sin-cambio' };
    },

    reset() {
      ultimaEnviada = null;
      enviadaEn = 0;
      ultimaHoraVista = 0;
      mejorDescartada = null;
    },
  };
}
