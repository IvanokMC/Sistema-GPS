import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import {
  bearingDegrees,
  formatDuration,
  type Stop,
  type TrackPoint,
  type TrackRun,
} from '@gps/shared';
import { MODE_COLOR, MOTION_LABEL } from './modes';

/* -------------------------------------------------------------------------- */
/*                               Capas base                                   */
/* -------------------------------------------------------------------------- */

export type BaseLayerId = 'calles' | 'oscuro' | 'satelite' | 'osm' | 'relieve';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

interface CapaBase {
  nombre: string;
  url: string;
  attribution: string;
  /** Zoom maximo que sirve el proveedor; por encima se amplian sus imagenes. */
  nativo: number;
  subdomains?: string;
  /** Capas transparentes encima (nombres de calles y lugares). */
  encima?: string[];
}

/**
 * Proveedores que no exigen clave de API. CARTO se descarto: desde 2026
 * responde con una imagen de "API KEY REQUIRED" en lugar del mapa.
 */
export const BASE_LAYERS: Record<BaseLayerId, CapaBase> = {
  calles: {
    nombre: 'Calles',
    url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
    attribution: 'Mapa &copy; Esri, HERE, Garmin, OpenStreetMap',
    nativo: 19,
  },
  oscuro: {
    nombre: 'Oscuro',
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    attribution: 'Mapa &copy; Esri, HERE, Garmin, OpenStreetMap',
    nativo: 16,
    encima: [`${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`],
  },
  satelite: {
    nombre: 'Satélite',
    url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics',
    nativo: 19,
    encima: [
      `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`,
      `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
    ],
  },
  osm: {
    nombre: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; colaboradores de OpenStreetMap',
    nativo: 19,
  },
  relieve: {
    nombre: 'Relieve',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap &copy; OpenTopoMap (CC-BY-SA)',
    nativo: 17,
    subdomains: 'abc',
  },
};

/* -------------------------------------------------------------------------- */
/*                               Marcador                                     */
/* -------------------------------------------------------------------------- */

/**
 * Marcador de la posicion actual: flecha orientada al rumbo si hay
 * movimiento, punto si esta detenido. El anillo pulsa mientras llegan datos.
 * El HTML solo contiene numeros y colores propios, nunca texto recibido.
 */
function iconoPosicion(
  color: string,
  rumbo: number | null,
  enVivo: boolean,
  seleccionado: boolean,
  atenuado: boolean,
): L.DivIcon {
  const forma =
    rumbo === null
      ? `<circle cx="20" cy="20" r="8" fill="${color}" stroke="#fff" stroke-width="3"/>`
      : `<g transform="rotate(${rumbo.toFixed(0)} 20 20)">
           <circle cx="20" cy="20" r="11" fill="${color}" stroke="#fff" stroke-width="3"/>
           <path d="M20 12 L26 24 L20 21 L14 24 Z" fill="#fff"/>
         </g>`;
  return L.divIcon({
    className: 'pos-icon',
    html: `<div class="pos ${enVivo ? 'pos--live' : 'pos--stale'} ${seleccionado ? 'pos--sel' : ''} ${atenuado ? 'pos--tenue' : ''}" style="--c:${color}">
             <span class="pos__pulse"></span>
             <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">${forma}</svg>
           </div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

/* -------------------------------------------------------------------------- */
/*                                Camara                                      */
/* -------------------------------------------------------------------------- */

function Camara({
  destino,
  seguir,
  onArrastre,
}: {
  destino: [number, number] | null;
  seguir: boolean;
  onArrastre: () => void;
}) {
  const map = useMap();
  const primera = useRef(true);

  // Si el usuario mueve el mapa a mano, deja de seguir: pelear contra la
  // camara mientras se explora es la peor experiencia posible.
  useMapEvents({ dragstart: onArrastre });

  useEffect(() => {
    if (!destino) return;
    if (primera.current) {
      map.setView(destino, 17, { animate: false });
      primera.current = false;
      return;
    }
    if (seguir) map.panTo(destino, { animate: true, duration: 0.6 });
  }, [map, destino?.[0], destino?.[1], seguir]);

  return null;
}

/* -------------------------------------------------------------------------- */
/*                                 Mapa                                       */
/* -------------------------------------------------------------------------- */

export interface MapTrack {
  deviceId: string;
  /** Nombre visible del celular. */
  nombre: string;
  /** El que sigue la camara y muestra el panel. */
  seleccionado: boolean;
  /** Si es false, solo se dibuja su marcador (atenuado), sin ruta ni paradas. */
  mostrarRuta: boolean;
  points: TrackPoint[];
  runs: TrackRun[];
  stops: Stop[];
  /** Ultima lectura, aunque sea imprecisa (el marcador si la muestra). */
  current: TrackPoint | null;
  enVivo: boolean;
}

interface Props {
  tracks: MapTrack[];
  seguidoId: string | null;
  capa: BaseLayerId;
  seguir: boolean;
  mostrarPrecision: boolean;
  mostrarParadas: boolean;
  onArrastre: () => void;
  onMapa: (map: L.Map | null) => void;
}

export function MapView({
  tracks,
  seguidoId,
  capa,
  seguir,
  mostrarPrecision,
  mostrarParadas,
  onArrastre,
  onMapa,
}: Props) {
  const base = BASE_LAYERS[capa];
  const principal = tracks.find((t) => t.deviceId === seguidoId) ?? tracks[0];

  const destino = useMemo<[number, number] | null>(
    () => (principal?.current ? [principal.current.lat, principal.current.lng] : null),
    [principal?.current?.lat, principal?.current?.lng],
  );

  return (
    <MapContainer
      center={[-13.5319, -71.9675]}
      zoom={14}
      maxZoom={20}
      className="map"
      zoomControl={false}
      ref={onMapa}
      preferCanvas={false}
    >
      <TileLayer
        key={capa}
        url={base.url}
        attribution={base.attribution}
        maxZoom={20}
        maxNativeZoom={base.nativo}
        {...(base.subdomains ? { subdomains: base.subdomains } : {})}
      />
      {base.encima?.map((url) => (
        <TileLayer key={`${capa}-${url}`} url={url} maxZoom={20} maxNativeZoom={base.nativo} />
      ))}

      <Camara destino={destino} seguir={seguir} onArrastre={onArrastre} />

      {tracks.map((t) => (
        <Fragment key={t.deviceId}>
          {/* Borde oscuro bajo toda la ruta: se lee igual sobre calles o satelite.
              Se dibuja completo antes que los colores para que en las uniones
              el borde de un tramo no tape el color del siguiente. */}
          {t.mostrarRuta && t.runs.map((run, r) =>
            run.segments.map((seg, i) =>
              seg.points.length > 1 ? (
                <Polyline
                  key={`borde-${r}-${i}`}
                  positions={seg.points.map((p) => [p.lat, p.lng] as [number, number])}
                  pathOptions={{ color: '#0b1220', weight: 9, opacity: 0.5, lineCap: 'round', lineJoin: 'round' }}
                  interactive={false}
                />
              ) : null,
            ),
          )}

          {t.mostrarRuta && t.runs.map((run, r) =>
            run.segments.map((seg, i) => {
              if (seg.points.length < 2) return null;
              const dur = seg.points[seg.points.length - 1].timestamp - seg.points[0].timestamp;
              const vel =
                seg.points.reduce((acc, p) => acc + p.speedMs, 0) / seg.points.length;
              return (
                <Polyline
                  key={`tramo-${r}-${i}`}
                  positions={seg.points.map((p) => [p.lat, p.lng] as [number, number])}
                  pathOptions={{
                    color: MODE_COLOR[seg.mode],
                    weight: 5,
                    opacity: 0.95,
                    lineCap: 'round',
                    lineJoin: 'round',
                  }}
                >
                  <Tooltip sticky direction="top" offset={[0, -8]}>
                    <strong>{MOTION_LABEL[seg.mode]}</strong>
                    <br />
                    {(vel * 3.6).toFixed(1)} km/h promedio · {formatDuration(dur)}
                  </Tooltip>
                </Polyline>
              );
            }),
          )}

          {/* Inicio de cada tramo sin cortes. */}
          {t.mostrarRuta && t.runs.map((run, r) => (
            <CircleMarker
              key={`inicio-${r}`}
              center={[run.points[0].lat, run.points[0].lng]}
              radius={5}
              pathOptions={{ color: '#0b1220', weight: 2, fillColor: '#ffffff', fillOpacity: 1 }}
            >
              <Tooltip direction="top" offset={[0, -6]}>
                {r === 0 ? 'Inicio de la ventana' : 'Reanudó tras un corte de señal'}
                <br />
                {new Date(run.points[0].timestamp).toLocaleTimeString('es-PE')}
              </Tooltip>
            </CircleMarker>
          ))}

          {mostrarParadas && t.mostrarRuta &&
            t.stops.map((s) => (
              <CircleMarker
                key={`parada-${s.from}`}
                center={[s.lat, s.lng]}
                radius={9}
                pathOptions={{ color: '#ffffff', weight: 2, fillColor: MODE_COLOR.quieto, fillOpacity: 1 }}
              >
                <Tooltip direction="top" offset={[0, -8]}>
                  <strong>Detenido {formatDuration(s.to - s.from)}</strong>
                  <br />
                  {new Date(s.from).toLocaleTimeString('es-PE')} – {new Date(s.to).toLocaleTimeString('es-PE')}
                </Tooltip>
              </CircleMarker>
            ))}

        </Fragment>
      ))}

      <Marcadores tracks={tracks} mostrarPrecision={mostrarPrecision} />
    </MapContainer>
  );
}

/**
 * Decide que nombres se muestran fijos sin pisarse.
 *
 * Cuando dos celulares estan cerca, sus etiquetas se superponian y no se leia
 * ninguna. Se calcula donde cae cada nombre en pantalla y, si choca con uno ya
 * ubicado, ese queda visible solo al pasar el mouse. Prioridad: el celular
 * seleccionado, luego los que muestran ruta. Se recalcula al mover o acercar
 * el mapa: al acercarse, los dos nombres vuelven a caber.
 */
function useEtiquetasVisibles(tracks: MapTrack[]): Set<string> {
  const map = useMap();
  const [vista, setVista] = useState(0);
  useMapEvents({
    zoomend: () => setVista((v) => v + 1),
    moveend: () => setVista((v) => v + 1),
  });

  return useMemo(() => {
    const orden = tracks
      .filter((t) => t.current)
      .sort(
        (a, b) =>
          Number(b.seleccionado) - Number(a.seleccionado) || Number(b.mostrarRuta) - Number(a.mostrarRuta),
      );
    const ocupadas: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const visibles = new Set<string>();
    for (const t of orden) {
      const p = map.latLngToContainerPoint([t.current!.lat, t.current!.lng]);
      // Medida aproximada de la etiqueta: ~7.5 px por letra mas el relleno.
      const ancho = t.nombre.length * 7.5 + 22;
      const caja = { x1: p.x - ancho / 2, x2: p.x + ancho / 2, y1: p.y - 50, y2: p.y - 22 };
      const choca = ocupadas.some((o) => caja.x1 < o.x2 && caja.x2 > o.x1 && caja.y1 < o.y2 && caja.y2 > o.y1);
      if (choca) continue;
      ocupadas.push(caja);
      visibles.add(t.deviceId);
    }
    return visibles;
  }, [tracks, vista, map]);
}

function Marcadores({ tracks, mostrarPrecision }: { tracks: MapTrack[]; mostrarPrecision: boolean }) {
  const visibles = useEtiquetasVisibles(tracks);
  return (
    <>
      {tracks.map((t) => (
        <PosicionActual
          key={t.deviceId}
          track={t}
          mostrarPrecision={mostrarPrecision}
          etiquetaFija={visibles.has(t.deviceId)}
        />
      ))}
    </>
  );
}

function PosicionActual({
  track: t,
  mostrarPrecision,
  etiquetaFija,
}: {
  track: MapTrack;
  mostrarPrecision: boolean;
  etiquetaFija: boolean;
}) {
  const c = t.current;
  const color = c && t.enVivo ? MODE_COLOR[c.mode] : '#64748b';
  const rumbo = rumboDe(t);
  const rumboRedondeado = rumbo === null ? null : Math.round(rumbo / 5) * 5;
  // El icono solo se reconstruye si cambia lo que muestra.
  const icono = useMemo(
    () => iconoPosicion(color, rumboRedondeado, t.enVivo, t.seleccionado, !t.mostrarRuta),
    [color, rumboRedondeado, t.enVivo, t.seleccionado, t.mostrarRuta],
  );
  if (!c) return null;

  return (
    <>
      {mostrarPrecision && t.mostrarRuta && c.accuracy !== undefined && (
        // Radio en metros reales (Circle), no en pixeles: antes el circulo
        // tenia el mismo tamaño en pantalla a cualquier zoom.
        <Circle
          center={[c.lat, c.lng]}
          radius={c.accuracy}
          pathOptions={{ color, weight: 1, opacity: 0.6, fillOpacity: 0.12 }}
          interactive={false}
        />
      )}
      <Marker
        position={[c.lat, c.lng]}
        icon={icono}
        zIndexOffset={t.seleccionado ? 2000 : 1000}
        keyboard={false}
      >
        {/* Nombre siempre visible: con varios celulares, el color ya indica el
            modo de movimiento y no puede indicar ademas quien es quien. */}
        {/* react-leaflet no cambia "permanent" en caliente: la clave fuerza a recrearla. */}
        <Tooltip
          key={etiquetaFija ? 'fija' : 'al-pasar'}
          permanent={etiquetaFija}
          direction="top"
          offset={[0, -20]}
          className={`etiqueta ${t.seleccionado ? 'etiqueta--sel' : ''} ${t.mostrarRuta ? '' : 'etiqueta--tenue'}`}
        >
          {t.nombre}
        </Tooltip>
      </Marker>
    </>
  );
}

/** Rumbo a mostrar: el del GPS si se esta moviendo, o el de los dos ultimos puntos. */
function rumboDe(t: MapTrack): number | null {
  const c = t.current;
  if (!c || c.mode === 'quieto') return null;
  if (c.heading !== undefined && c.heading > 0) return c.heading;
  const previo = [...t.points].reverse().find((p) => p.timestamp < c.timestamp && (p.lat !== c.lat || p.lng !== c.lng));
  return previo ? bearingDegrees(previo, c) : null;
}
