import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrackPoint, TrackRun } from '@gps/shared';
import { MODE_COLOR, MOTION_LABEL } from './modes';

const ALTO = 150;
const M = { top: 12, right: 14, bottom: 22, left: 34 };

/** Escala vertical "redonda": 10, 20, 40, 60, 80, 100, 120... km/h. */
function techo(maxKmh: number): number {
  if (maxKmh <= 10) return 10;
  if (maxKmh <= 20) return 20;
  return Math.ceil(maxKmh / 20) * 20;
}

interface Props {
  points: TrackPoint[];
  runs: TrackRun[];
  windowMs: number;
  now: number;
}

/**
 * Velocidad a lo largo de la ventana. Una sola magnitud en un solo eje; el
 * color de cada tramo es el modo de movimiento, con la misma leyenda que el
 * mapa. Los cortes de señal quedan como huecos, igual que en la ruta.
 */
export function SpeedChart({ points, runs, windowMs, now }: Props) {
  const contenedor = useRef<HTMLDivElement>(null);
  const [ancho, setAncho] = useState(320);
  const [activo, setActivo] = useState<number | null>(null);

  useEffect(() => {
    const el = contenedor.current;
    if (!el) return;
    const ro = new ResizeObserver(([entrada]) => setAncho(Math.max(200, entrada.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const inicio = now - windowMs;
  const anchoUtil = ancho - M.left - M.right;
  const altoUtil = ALTO - M.top - M.bottom;
  const maxKmh = useMemo(() => techo(Math.max(0, ...points.map((p) => p.speedMs * 3.6))), [points]);

  const x = (t: number) => M.left + ((t - inicio) / windowMs) * anchoUtil;
  const y = (kmh: number) => M.top + altoUtil - (kmh / maxKmh) * altoUtil;

  const trazos = runs.flatMap((run, r) =>
    run.segments
      .filter((s) => s.points.length > 1)
      .map((s, i) => ({
        key: `${r}-${i}`,
        color: MODE_COLOR[s.mode],
        d: s.points
          .map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.timestamp).toFixed(1)},${y(p.speedMs * 3.6).toFixed(1)}`)
          .join(' '),
      })),
  );

  const minutos = Math.round(windowMs / 60_000);
  // Una marca por minuto hasta 5 min; con ventanas mas largas, cada 2 min,
  // para que las etiquetas no se amontonen en un panel angosto.
  const paso = minutos <= 5 ? 1 : 2;
  const marcasX = Array.from({ length: Math.floor(minutos / paso) + 1 }, (_, i) => i * paso).map((k) => ({
    t: now - k * 60_000,
    texto: k === 0 ? 'ahora' : `−${k} min`,
  }));
  const marcasY = [0, maxKmh / 2, maxKmh];

  // Si llegan puntos nuevos, el cursor no queda apuntando fuera de rango.
  const seleccionado = activo !== null ? points[Math.min(activo, points.length - 1)] : null;

  /** El cursor busca la hora mas cercana: nadie apunta a una linea de 2 px. */
  const alMover = (clientX: number) => {
    const svg = contenedor.current?.querySelector('svg');
    if (!svg || points.length === 0) return;
    const { left } = svg.getBoundingClientRect();
    const t = inicio + ((clientX - left - M.left) / anchoUtil) * windowMs;
    let mejor = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].timestamp - t) < Math.abs(points[mejor].timestamp - t)) mejor = i;
    }
    setActivo(mejor);
  };

  const alTeclado = (e: React.KeyboardEvent) => {
    if (points.length === 0) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const base = activo ?? points.length - 1;
      const paso = e.key === 'ArrowLeft' ? -1 : 1;
      setActivo(Math.max(0, Math.min(points.length - 1, base + paso)));
    } else if (e.key === 'Escape') {
      setActivo(null);
    }
  };

  if (points.length === 0) {
    return (
      <div className="chart chart--vacio" ref={contenedor}>
        Sin lecturas en la ventana.
      </div>
    );
  }

  const tooltipIzq = seleccionado ? Math.min(Math.max(x(seleccionado.timestamp), 70), ancho - 70) : 0;

  return (
    <div className="chart" ref={contenedor}>
      <svg
        width={ancho}
        height={ALTO}
        role="img"
        aria-label={`Velocidad en los ultimos ${minutos} minutos. Maxima ${Math.max(...points.map((p) => p.speedMs * 3.6)).toFixed(1)} km/h. Use las flechas para recorrer las lecturas.`}
        tabIndex={0}
        onPointerMove={(e) => alMover(e.clientX)}
        onPointerLeave={() => setActivo(null)}
        onKeyDown={alTeclado}
        onBlur={() => setActivo(null)}
      >
        {marcasY.map((v) => (
          <g key={v}>
            <line className="chart__grid" x1={M.left} x2={ancho - M.right} y1={y(v)} y2={y(v)} />
            <text className="chart__tick" x={M.left - 6} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {marcasX.map((m) => (
          <text key={m.t} className="chart__tick" x={x(m.t)} y={ALTO - 6} textAnchor={m.texto === 'ahora' ? 'end' : 'middle'}>
            {m.texto}
          </text>
        ))}

        {trazos.map((t) => (
          <path key={t.key} d={t.d} fill="none" stroke={t.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {seleccionado && (
          <g pointerEvents="none">
            <line
              className="chart__cursor"
              x1={x(seleccionado.timestamp)}
              x2={x(seleccionado.timestamp)}
              y1={M.top}
              y2={M.top + altoUtil}
            />
            <circle
              cx={x(seleccionado.timestamp)}
              cy={y(seleccionado.speedMs * 3.6)}
              r={5}
              fill={MODE_COLOR[seleccionado.mode]}
              className="chart__dot"
            />
          </g>
        )}
      </svg>

      {seleccionado && (
        <div className="chart__tooltip" style={{ left: tooltipIzq }} role="status">
          <div className="chart__tooltip-valor">{(seleccionado.speedMs * 3.6).toFixed(1)} km/h</div>
          <div className="chart__tooltip-sub">
            <span className="line-key" style={{ background: MODE_COLOR[seleccionado.mode] }} />
            {MOTION_LABEL[seleccionado.mode]} · {new Date(seleccionado.timestamp).toLocaleTimeString('es-PE')}
          </div>
        </div>
      )}
    </div>
  );
}
