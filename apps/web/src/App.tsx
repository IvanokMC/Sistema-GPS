import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import L from 'leaflet';
import {
  cleanTrack,
  compassLabel,
  formatDistance,
  formatDuration,
  segmentTrack,
  trackStats,
  type Position,
  type TrackPoint,
  type TrackRun,
  type TrackStats,
} from '@gps/shared';
import { useTracker } from './useTracker';
import { BASE_LAYERS, MapView, type BaseLayerId, type MapTrack } from './MapView';
import { SpeedChart } from './SpeedChart';
import { MODE_COLOR, MOTION_LABEL, MOTION_MODES } from './modes';
import { descargar, toCsv, toGeoJson, toGpx } from './exporters';
import { RETENTION_MS, STALE_MS } from './config';

/* -------------------------------------------------------------------------- */
/*                                 Utilidades                                 */
/* -------------------------------------------------------------------------- */

/** Preferencia recordada en este navegador. El almacenamiento puede no existir
 *  (ventana privada, bloqueado): en ese caso vale el valor por defecto. */
function usePreferencia<T>(clave: string, inicial: T): [T, (v: T) => void] {
  const [valor, setValor] = useState<T>(() => {
    try {
      const guardado = localStorage.getItem(`gps.${clave}`);
      return guardado === null ? inicial : (JSON.parse(guardado) as T);
    } catch {
      return inicial;
    }
  });
  const guardar = useCallback(
    (v: T) => {
      setValor(v);
      try {
        localStorage.setItem(`gps.${clave}`, JSON.stringify(v));
      } catch {
        /* sin almacenamiento: la preferencia dura solo esta visita */
      }
    },
    [clave],
  );
  return [valor, guardar];
}

function useAhora(intervaloMs = 1000): number {
  const [ahora, setAhora] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), intervaloMs);
    return () => clearInterval(id);
  }, [intervaloMs]);
  return ahora;
}

const hace = (ms: number) => (ms < 5_000 ? 'ahora' : `hace ${formatDuration(ms)}`);
const kmh = (ms: number) => (ms * 3.6).toFixed(1);

/** Un celular que no reporta en toda la ventana de retencion deja de listarse:
 *  sus datos ya se borraron en el servidor. */
const VISIBLE_MS = RETENTION_MS;

interface Pista {
  points: TrackPoint[];
  runs: TrackRun[];
  stats: TrackStats;
  current: TrackPoint | null;
  crudas: number;
}

const VENTANAS = [1, 2, 5, 10].filter((m) => m * 60_000 <= RETENTION_MS);
const PRECISIONES = [15, 25, 35, 50, 100];

/* -------------------------------------------------------------------------- */
/*                                    App                                     */
/* -------------------------------------------------------------------------- */

export function App() {
  const { status, devices, positions, loading, error, recargar } = useTracker();
  const ahora = useAhora();

  const [capa, setCapa] = usePreferencia<BaseLayerId>('capa', 'calles');
  const [ventanaMin, setVentanaMin] = usePreferencia('ventanaMin', RETENTION_MS / 60_000);
  const [maxPrecision, setMaxPrecision] = usePreferencia('maxPrecision', 35);
  const [mostrarPrecision, setMostrarPrecision] = usePreferencia('mostrarPrecision', true);
  const [mostrarParadas, setMostrarParadas] = usePreferencia('mostrarParadas', true);
  const [suavizarParadas, setSuavizarParadas] = usePreferencia('suavizarParadas', true);
  const [seguir, setSeguir] = useState(true);
  const [ocultarAntes, setOcultarAntes] = useState(0);
  const [mapa, setMapa] = useState<L.Map | null>(null);
  const [verTabla, setVerTabla] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [elegido, setElegido] = useState<string | null>(null);
  /** Rutas en el mapa: solo la del celular elegido, o las de todos. */
  const [rutas, setRutas] = useState<'seleccionado' | 'todos'>('todos');

  const windowMs = ventanaMin * 60_000;

  /** Hora de la ultima lectura conocida de un celular. */
  const ultimaDe = (id: string) =>
    Math.max(devices[id]?.lastPosition?.timestamp ?? 0, positions[id]?.[positions[id].length - 1]?.timestamp ?? 0);

  // Celulares con actividad reciente, en orden alfabetico estable (ordenar por
  // actividad haria saltar la lista cada segundo). Un identificador que no
  // reporta hace mas de 30 min, como el de una instalacion antigua, no se lista.
  const ids = Object.keys(devices)
    .filter((id) => ahora - ultimaDe(id) < VISIBLE_MS)
    .sort((a, b) => nombreDe(a).localeCompare(nombreDe(b)));
  const clave = ids.join(',');

  function nombreDe(id: string): string {
    const lista = positions[id];
    return devices[id]?.label ?? lista?.[lista.length - 1]?.label ?? id;
  }

  // Por defecto se sigue al que reporto mas recientemente.
  const masReciente = ids.reduce<string | null>((a, b) => (a === null || ultimaDe(b) > ultimaDe(a) ? b : a), null);
  const deviceId = elegido && ids.includes(elegido) ? elegido : masReciente;

  // La eleccion automatica se fija una vez: si siguiera al ultimo que
  // reporto, con dos celulares la camara saltaria de uno a otro cada segundo.
  useEffect(() => {
    if ((!elegido || !ids.includes(elegido)) && masReciente) setElegido(masReciente);
  }, [elegido, clave, masReciente]);

  // Las rutas se recalculan con cada lectura nueva y cada segundo (la ventana avanza).
  const pistas = useMemo(() => {
    const salida: Record<string, Pista> = {};
    for (const id of clave ? clave.split(',') : []) {
      const crudas: Position[] = (positions[id] ?? []).filter((p) => p.timestamp >= ocultarAntes);
      const base = { now: ahora, windowMs, snapStops: suavizarParadas };
      const points = cleanTrack(crudas, { ...base, maxAccuracyM: maxPrecision });
      // El marcador si muestra la ultima lectura aunque sea imprecisa: mejor una
      // posicion con su circulo de incertidumbre que ninguna.
      const todas = cleanTrack(crudas, { ...base, maxAccuracyM: 1000 });
      salida[id] = {
        points,
        runs: segmentTrack(points),
        stats: trackStats(points),
        current: todas[todas.length - 1] ?? null,
        crudas: crudas.length,
      };
    }
    return salida;
  }, [clave, positions, ahora, windowMs, maxPrecision, suavizarParadas, ocultarAntes]);

  const enVivoDe = (id: string) => status === 'online' && ahora - ultimaDe(id) < STALE_MS;

  const pista = deviceId ? (pistas[deviceId] ?? null) : null;
  const ultimaHora = deviceId ? ultimaDe(deviceId) || null : null;
  const edad = ultimaHora ? ahora - ultimaHora : Infinity;
  const enVivo = deviceId ? enVivoDe(deviceId) : false;
  const actual = pista?.current ?? null;

  const tracks: MapTrack[] = ids
    .filter((id) => pistas[id])
    .map((id) => ({
      deviceId: id,
      nombre: nombreDe(id),
      points: pistas[id].points,
      runs: pistas[id].runs,
      stops: pistas[id].stats.stops,
      current: pistas[id].current,
      enVivo: enVivoDe(id),
      seleccionado: id === deviceId,
      mostrarRuta: rutas === 'todos' || id === deviceId,
    }));

  /**
   * Al tocar un celular: su ruta queda sola en el mapa y la camara se acerca
   * hasta encuadrar todo su recorrido. Si todavia no tiene ruta, se acerca a
   * su posicion. Despues sigue al celular mientras se mueve.
   */
  const seleccionar = (id: string) => {
    setElegido(id);
    setRutas('seleccionado');
    const p = pistas[id];
    if (!mapa || !p?.current) return;
    const coords = p.points.map((q) => [q.lat, q.lng] as [number, number]);
    coords.push([p.current.lat, p.current.lng]);
    const limites = L.latLngBounds(coords);
    // Una ruta muy corta (o un celular quieto) encuadraria a un zoom absurdo.
    if (limites.getNorthEast().distanceTo(limites.getSouthWest()) < 60) {
      mapa.flyTo([p.current.lat, p.current.lng], 18, { duration: 0.8 });
    } else {
      mapa.flyToBounds(limites, { padding: [70, 70], maxZoom: 18, duration: 0.8 });
    }
    // Seguir despues del vuelo: si siguiera durante el, la camara cortaria
    // el encuadre para ir a la posicion actual.
    setSeguir(false);
    mapa.once('moveend', () => setSeguir(true));
  };

  const verTodos = () => {
    setRutas('todos');
    if (!mapa) return;
    const coords = tracks.flatMap((t) => (t.current ? [[t.current.lat, t.current.lng] as [number, number]] : []));
    if (coords.length === 0) return;
    setSeguir(false);
    if (coords.length === 1) mapa.setView(coords[0], 17);
    else mapa.fitBounds(coords, { padding: [80, 80], maxZoom: 18 });
  };

  /* ------------------------------- Acciones ------------------------------- */

  const centrar = () => {
    if (mapa && actual) mapa.setView([actual.lat, actual.lng], Math.max(mapa.getZoom(), 17));
    setSeguir(true);
  };

  const verRuta = () => {
    if (!mapa || !pista || pista.points.length === 0) return;
    setSeguir(false);
    const coords = pista.points.map((p) => [p.lat, p.lng] as [number, number]);
    if (actual) coords.push([actual.lat, actual.lng]);
    mapa.fitBounds(coords, { padding: [60, 60], maxZoom: 18 });
  };

  const pantallaCompleta = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };

  const copiar = async () => {
    if (!actual) return;
    try {
      await navigator.clipboard.writeText(`${actual.lat.toFixed(6)}, ${actual.lng.toFixed(6)}`);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch {
      /* portapapeles no disponible: las coordenadas siguen visibles */
    }
  };

  const exportar = (formato: 'gpx' | 'geojson' | 'csv') => {
    if (!pista || !deviceId) return;
    const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const nombre = `ruta-${deviceId}-${sello}`;
    if (formato === 'gpx') descargar(`${nombre}.gpx`, toGpx(deviceId, pista.runs), 'application/gpx+xml');
    if (formato === 'geojson')
      descargar(`${nombre}.geojson`, toGeoJson(deviceId, pista.runs, pista.stats.stops), 'application/geo+json');
    if (formato === 'csv') descargar(`${nombre}.csv`, toCsv(pista.points), 'text/csv');
  };

  /* -------------------------------- Vista --------------------------------- */

  const stats = pista?.stats;
  const tiempoTotal = stats ? MOTION_MODES.reduce((a, m) => a + stats.timeByMode[m], 0) : 0;

  return (
    <div className="layout">
      <main className="map-area">
        <MapView
          tracks={tracks}
          seguidoId={deviceId}
          capa={capa}
          seguir={seguir}
          mostrarPrecision={mostrarPrecision}
          mostrarParadas={mostrarParadas}
          onArrastre={() => setSeguir(false)}
          onMapa={setMapa}
        />

        {/* Resumen legible de un vistazo, sobre el mapa. */}
        <div className="hud" aria-live="polite">
          <span className={`hud__dot ${enVivo ? 'hud__dot--live' : ''}`} />
          <span className="hud__estado">{enVivo ? 'En vivo' : actual ? 'Sin señal' : 'Esperando datos'}</span>
          {actual && (
            <>
              <span className="hud__sep" />
              <span className="line-key" style={{ background: MODE_COLOR[actual.mode] }} />
              <span>{MOTION_LABEL[actual.mode]}</span>
              <span className="hud__vel">{kmh(actual.speedMs)} km/h</span>
            </>
          )}
        </div>

        <div className="toolbar" role="toolbar" aria-label="Controles del mapa">
          <Boton activo={seguir} onClick={() => (seguir ? setSeguir(false) : centrar())} titulo="Seguir la posición">
            <IconoSeguir />
          </Boton>
          <Boton onClick={centrar} titulo="Centrar en la posición actual" deshabilitado={!actual}>
            <IconoCentrar />
          </Boton>
          <Boton onClick={verRuta} titulo="Ver la ruta completa" deshabilitado={!pista?.points.length}>
            <IconoRuta />
          </Boton>
          {ids.length > 1 && (
            <Boton onClick={verTodos} titulo="Ver todos los celulares">
              <IconoTodos />
            </Boton>
          )}
          <span className="toolbar__sep" />
          <Boton activo={mostrarPrecision} onClick={() => setMostrarPrecision(!mostrarPrecision)} titulo="Mostrar círculo de precisión">
            <IconoPrecision />
          </Boton>
          <Boton activo={mostrarParadas} onClick={() => setMostrarParadas(!mostrarParadas)} titulo="Mostrar paradas">
            <IconoParada />
          </Boton>
          <span className="toolbar__sep" />
          <Boton onClick={() => mapa?.zoomIn()} titulo="Acercar">
            <IconoMas />
          </Boton>
          <Boton onClick={() => mapa?.zoomOut()} titulo="Alejar">
            <IconoMenos />
          </Boton>
          <Boton onClick={pantallaCompleta} titulo="Pantalla completa">
            <IconoPantalla />
          </Boton>
        </div>

        <div className="capas" role="radiogroup" aria-label="Tipo de mapa">
          {(Object.keys(BASE_LAYERS) as BaseLayerId[]).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={capa === id}
              className={`capas__opcion ${capa === id ? 'is-on' : ''}`}
              onClick={() => setCapa(id)}
            >
              {BASE_LAYERS[id].nombre}
            </button>
          ))}
        </div>

        <div className="leyenda" aria-label="Leyenda de colores">
          {MOTION_MODES.map((m) => (
            <span key={m} className="leyenda__item">
              <span className="line-key line-key--lg" style={{ background: MODE_COLOR[m] }} />
              {MOTION_LABEL[m]}
            </span>
          ))}
        </div>
      </main>

      <aside className="panel">
        <header className="panel__header">
          <div>
            <h1>Rastreo GPS</h1>
            <p className="panel__sub">
              {status === 'online' ? 'Conectado' : status === 'connecting' ? 'Conectando…' : 'Sin conexión, reintentando'}
              {loading && ' · cargando historial'}
            </p>
          </div>
          <span className={`pill pill--${status}`}>{status === 'online' ? 'En línea' : status === 'connecting' ? '…' : 'Offline'}</span>
        </header>

        {/* Filtro de ventana: aplica a todo lo que esta debajo. */}
        <div className="filtros" role="radiogroup" aria-label="Ventana de tiempo">
          <span className="filtros__label">Últimos</span>
          {VENTANAS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={ventanaMin === m}
              className={`seg ${ventanaMin === m ? 'is-on' : ''}`}
              onClick={() => setVentanaMin(m)}
            >
              {m} min
            </button>
          ))}
        </div>

        {error && <p className="aviso aviso--error">{error}</p>}

        {ids.length > 0 && (
          <section className="card" aria-labelledby="t-celulares">
            <div className="card__head">
              <h2 id="t-celulares">Celulares ({ids.length})</h2>
              {ids.length > 1 && (
                <button type="button" className="link" onClick={verTodos}>
                  Ver todos en el mapa
                </button>
              )}
            </div>
            {ids.length > 1 && (
              <div className="rutas" role="radiogroup" aria-label="Rutas en el mapa">
                <span className="muted pequeno">Rutas en el mapa</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={rutas === 'seleccionado'}
                  className={`seg ${rutas === 'seleccionado' ? 'is-on' : ''}`}
                  onClick={() => setRutas('seleccionado')}
                >
                  Solo {deviceId ? nombreDe(deviceId) : 'el elegido'}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={rutas === 'todos'}
                  className={`seg ${rutas === 'todos' ? 'is-on' : ''}`}
                  onClick={() => setRutas('todos')}
                >
                  Todos
                </button>
              </div>
            )}
            <ul className="celulares">
              {ids.map((id) => {
                const c = pistas[id]?.current;
                const vivo = enVivoDe(id);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className={`celular ${id === deviceId ? 'is-on' : ''}`}
                      onClick={() => seleccionar(id)}
                      aria-pressed={id === deviceId}
                    >
                      <span className={`celular__estado ${vivo ? 'is-vivo' : ''}`} aria-hidden="true" />
                      <span className="celular__nombre">
                        <strong>{nombreDe(id)}</strong>
                        <span className="muted pequeno">
                          {vivo ? 'En vivo' : `Sin señal ${hace(ahora - ultimaDe(id))}`}
                        </span>
                      </span>
                      {c && (
                        <span className="celular__vel">
                          <span className="line-key" style={{ background: MODE_COLOR[c.mode] }} />
                          {kmh(c.speedMs)} km/h
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!deviceId ? (
          <div className="vacio">
            <p>Ningún dispositivo ha enviado datos todavía.</p>
            <p className="muted">Abre la app en el celular y pulsa “Iniciar rastreo”.</p>
          </div>
        ) : (
          <>
            <section className="card hero">
              <div className="hero__fila">
                <div>
                  <div className="hero__valor">
                    {actual ? kmh(actual.speedMs) : '—'}
                    <span className="hero__unidad">km/h</span>
                  </div>
                  <div className="hero__modo">
                    {actual && <span className="line-key" style={{ background: MODE_COLOR[actual.mode] }} />}
                    {actual ? MOTION_LABEL[actual.mode] : 'Sin datos'}
                    {actual && actual.mode !== 'quieto' && actual.heading !== undefined && (
                      <span className="muted"> · rumbo {compassLabel(actual.heading)}</span>
                    )}
                  </div>
                </div>
                <div className="hero__estado">
                  <strong>{nombreDe(deviceId)}</strong>
                  <span className="muted pequeno">{deviceId}</span>
                  <span className={enVivo ? 'ok' : 'muted'}>
                    {ultimaHora ? `${enVivo ? 'Actualizado' : 'Sin señal'} ${hace(edad)}` : 'Sin lecturas'}
                  </span>
                  {actual?.battery !== undefined && <span className="muted">Batería {Math.round(actual.battery * 100)}%</span>}
                </div>
              </div>
            </section>

            <section className="stats" aria-label="Resumen del recorrido">
              <Stat etiqueta="Distancia" valor={stats ? formatDistance(stats.distanceM) : '—'} />
              <Stat etiqueta="Duración" valor={stats ? formatDuration(stats.durationMs) : '—'} />
              <Stat etiqueta="Vel. máxima" valor={stats ? `${kmh(stats.maxSpeedMs)} km/h` : '—'} />
              <Stat etiqueta="Vel. media en mov." valor={stats ? `${kmh(stats.avgMovingSpeedMs)} km/h` : '—'} />
              <Stat etiqueta="Altitud" valor={actual?.altitude !== undefined ? `${Math.round(actual.altitude)} m` : '—'} />
              <Stat
                etiqueta="Precisión"
                valor={actual?.accuracy !== undefined ? `±${Math.round(actual.accuracy)} m` : '—'}
                aviso={actual?.accuracy !== undefined && actual.accuracy > maxPrecision}
              />
            </section>

            <Tarjeta titulo={`Velocidad (km/h) · últimos ${ventanaMin} min`}>
              <div className="leyenda-inline">
                {MOTION_MODES.map((m) => (
                  <span key={m}>
                    <span className="line-key" style={{ background: MODE_COLOR[m] }} />
                    {MOTION_LABEL[m]}
                  </span>
                ))}
              </div>
              <SpeedChart points={pista?.points ?? []} runs={pista?.runs ?? []} windowMs={windowMs} now={ahora} />
            </Tarjeta>

            <Tarjeta titulo="Tiempo por modo">
              {tiempoTotal > 0 && stats ? (
                <>
                  <div className="barra" role="img" aria-label="Proporción de tiempo en cada modo">
                    {MOTION_MODES.filter((m) => stats.timeByMode[m] > 0).map((m) => (
                      <span
                        key={m}
                        className="barra__seg"
                        style={{ flexGrow: stats.timeByMode[m], background: MODE_COLOR[m] }}
                        title={`${MOTION_LABEL[m]}: ${formatDuration(stats.timeByMode[m])}`}
                      />
                    ))}
                  </div>
                  <ul className="modos">
                    {MOTION_MODES.map((m) => (
                      <li key={m}>
                        <span className="rect-key" style={{ background: MODE_COLOR[m] }} />
                        <span>{MOTION_LABEL[m]}</span>
                        <span className="modos__valor">{formatDuration(stats.timeByMode[m])}</span>
                        <span className="modos__pct">{Math.round((stats.timeByMode[m] / tiempoTotal) * 100)}%</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">Aún no hay suficiente recorrido.</p>
              )}
            </Tarjeta>

            <Tarjeta titulo={`Paradas (${stats?.stops.length ?? 0})`}>
              {stats && stats.stops.length > 0 ? (
                <ul className="paradas">
                  {stats.stops.map((s) => (
                    <li key={s.from}>
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          setSeguir(false);
                          mapa?.setView([s.lat, s.lng], 18);
                        }}
                      >
                        {new Date(s.from).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                      </button>
                      <span className="muted">detenido {formatDuration(s.to - s.from)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Sin paradas de más de 30 s en la ventana.</p>
              )}
            </Tarjeta>

            <Tarjeta titulo="Ubicación actual">
              {actual ? (
                <>
                  <p className="coords">
                    {actual.lat.toFixed(6)}, {actual.lng.toFixed(6)}
                  </p>
                  <div className="acciones">
                    <button type="button" className="btn" onClick={() => void copiar()}>
                      {copiado ? 'Copiado ✓' : 'Copiar'}
                    </button>
                    <a
                      className="btn"
                      href={`https://www.google.com/maps?q=${actual.lat},${actual.lng}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Google Maps
                    </a>
                    <a
                      className="btn"
                      href={`https://www.openstreetmap.org/?mlat=${actual.lat}&mlon=${actual.lng}#map=18/${actual.lat}/${actual.lng}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      OpenStreetMap
                    </a>
                  </div>
                </>
              ) : (
                <p className="muted">Sin posición.</p>
              )}
            </Tarjeta>

            <Tarjeta titulo="Opciones">
              <label className="campo">
                <span>Precisión mínima para la ruta</span>
                <select className="select" value={maxPrecision} onChange={(e) => setMaxPrecision(Number(e.target.value))}>
                  {PRECISIONES.map((p) => (
                    <option key={p} value={p}>
                      ±{p} m {p === 35 ? '(recomendado)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <Interruptor
                activo={suavizarParadas}
                onCambio={setSuavizarParadas}
                texto="Unificar paradas"
                detalle="Evita el nudo de líneas que dibuja la oscilación del GPS estando quieto."
              />
              <Interruptor activo={mostrarPrecision} onCambio={setMostrarPrecision} texto="Círculo de precisión" />
              <Interruptor activo={mostrarParadas} onCambio={setMostrarParadas} texto="Marcar paradas" />

              <div className="campo">
                <span>Exportar la ruta</span>
                <div className="acciones">
                  <button type="button" className="btn" onClick={() => exportar('gpx')} disabled={!pista?.points.length}>
                    GPX
                  </button>
                  <button type="button" className="btn" onClick={() => exportar('geojson')} disabled={!pista?.points.length}>
                    GeoJSON
                  </button>
                  <button type="button" className="btn" onClick={() => exportar('csv')} disabled={!pista?.points.length}>
                    CSV
                  </button>
                </div>
              </div>
              <div className="acciones">
                <button type="button" className="btn" onClick={() => void recargar()}>
                  Recargar historial
                </button>
                <button type="button" className="btn" onClick={() => setOcultarAntes(Date.now())}>
                  Limpiar vista
                </button>
                {ocultarAntes > 0 && (
                  <button type="button" className="btn" onClick={() => setOcultarAntes(0)}>
                    Restaurar
                  </button>
                )}
              </div>
              <p className="muted pequeno">
                {pista?.crudas ?? 0} lecturas recibidas · {pista?.points.length ?? 0} en la ruta tras filtrar
              </p>
            </Tarjeta>

            <Tarjeta
              titulo="Datos"
              accion={
                <button type="button" className="link" onClick={() => setVerTabla(!verTabla)} aria-expanded={verTabla}>
                  {verTabla ? 'Ocultar' : 'Ver tabla'}
                </button>
              }
            >
              {verTabla ? <Tabla puntos={pista?.points ?? []} /> : <p className="muted">Últimas lecturas de la ruta, en texto.</p>}
            </Tarjeta>
          </>
        )}
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Piezas menores                                */
/* -------------------------------------------------------------------------- */

function Tarjeta({ titulo, accion, children }: { titulo: string; accion?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card__head">
        <h2>{titulo}</h2>
        {accion}
      </div>
      {children}
    </section>
  );
}

function Stat({ etiqueta, valor, aviso }: { etiqueta: string; valor: string; aviso?: boolean }) {
  return (
    <div className={`stat ${aviso ? 'stat--aviso' : ''}`}>
      <span className="stat__label">{etiqueta}</span>
      <span className="stat__valor">{valor}</span>
    </div>
  );
}

function Interruptor({
  activo,
  onCambio,
  texto,
  detalle,
}: {
  activo: boolean;
  onCambio: (v: boolean) => void;
  texto: string;
  detalle?: string;
}) {
  return (
    <label className="interruptor">
      <input type="checkbox" checked={activo} onChange={(e) => onCambio(e.target.checked)} />
      <span className="interruptor__pista" aria-hidden="true" />
      <span>
        {texto}
        {detalle && <span className="muted pequeno bloque">{detalle}</span>}
      </span>
    </label>
  );
}

function Tabla({ puntos }: { puntos: TrackPoint[] }) {
  const filas = [...puntos].reverse().slice(0, 30);
  if (filas.length === 0) return <p className="muted">Sin datos.</p>;
  return (
    <div className="tabla-scroll">
      <table className="tabla">
        <thead>
          <tr>
            <th>Hora</th>
            <th>Latitud</th>
            <th>Longitud</th>
            <th>km/h</th>
            <th>±m</th>
            <th>Modo</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((p) => (
            <tr key={p.timestamp}>
              <td>{new Date(p.timestamp).toLocaleTimeString('es-PE')}</td>
              <td>{p.lat.toFixed(5)}</td>
              <td>{p.lng.toFixed(5)}</td>
              <td>{kmh(p.speedMs)}</td>
              <td>{p.accuracy !== undefined ? Math.round(p.accuracy) : '—'}</td>
              <td>{MOTION_LABEL[p.mode]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Boton({
  activo,
  onClick,
  titulo,
  deshabilitado,
  children,
}: {
  activo?: boolean;
  onClick: () => void;
  titulo: string;
  deshabilitado?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tool ${activo ? 'is-on' : ''}`}
      onClick={onClick}
      title={titulo}
      aria-label={titulo}
      aria-pressed={activo}
      disabled={deshabilitado}
    >
      {children}
    </button>
  );
}

/* Iconos de trazo, 20 px. */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const IconoSeguir = () => (
  <Svg>
    <path d="M12 2 19 21 12 17 5 21Z" />
  </Svg>
);
const IconoCentrar = () => (
  <Svg>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Svg>
);
const IconoRuta = () => (
  <Svg>
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M8 19h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7" />
  </Svg>
);
const IconoTodos = () => (
  <Svg>
    <circle cx="7" cy="8" r="2.5" />
    <circle cx="17" cy="8" r="2.5" />
    <circle cx="12" cy="17" r="2.5" />
  </Svg>
);
const IconoPrecision = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" strokeOpacity=".5" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
  </Svg>
);
const IconoParada = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);
const IconoMas = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
const IconoMenos = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
);
const IconoPantalla = () => (
  <Svg>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
