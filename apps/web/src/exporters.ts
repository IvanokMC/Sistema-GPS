import type { Stop, TrackPoint, TrackRun } from '@gps/shared';
import { MOTION_LABEL } from './modes';

/** Escapa texto para XML: el deviceId viene de la red y va dentro del GPX. */
const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GPX 1.1: un segmento por tramo sin cortes, para que los visores no unan los huecos. */
export function toGpx(deviceId: string, runs: TrackRun[]): string {
  const segmentos = runs
    .map(
      (run) =>
        `    <trkseg>\n${run.points
          .map(
            (p) =>
              `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">` +
              (p.altitude !== undefined ? `<ele>${p.altitude.toFixed(1)}</ele>` : '') +
              `<time>${new Date(p.timestamp).toISOString()}</time></trkpt>`,
          )
          .join('\n')}\n    </trkseg>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rastreo GPS" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${xml(deviceId)}</name>
${segmentos}
  </trk>
</gpx>
`;
}

/** GeoJSON: una linea por tramo de un mismo modo, mas las paradas como puntos. */
export function toGeoJson(deviceId: string, runs: TrackRun[], stops: Stop[]): string {
  const lineas = runs.flatMap((run) =>
    run.segments
      .filter((s) => s.points.length > 1)
      .map((s) => ({
        type: 'Feature',
        properties: {
          deviceId,
          modo: s.mode,
          etiqueta: MOTION_LABEL[s.mode],
          desde: new Date(s.points[0].timestamp).toISOString(),
          hasta: new Date(s.points[s.points.length - 1].timestamp).toISOString(),
        },
        geometry: { type: 'LineString', coordinates: s.points.map((p) => [p.lng, p.lat]) },
      })),
  );
  const paradas = stops.map((s) => ({
    type: 'Feature',
    properties: {
      deviceId,
      tipo: 'parada',
      desde: new Date(s.from).toISOString(),
      hasta: new Date(s.to).toISOString(),
    },
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
  }));
  return JSON.stringify({ type: 'FeatureCollection', features: [...lineas, ...paradas] }, null, 2);
}

/** CSV con la ruta ya limpia. */
export function toCsv(points: TrackPoint[]): string {
  const cabecera = 'hora,latitud,longitud,precision_m,velocidad_kmh,altitud_m,modo';
  const filas = points.map((p) =>
    [
      new Date(p.timestamp).toISOString(),
      p.lat.toFixed(7),
      p.lng.toFixed(7),
      p.accuracy?.toFixed(1) ?? '',
      (p.speedMs * 3.6).toFixed(2),
      p.altitude?.toFixed(1) ?? '',
      p.mode,
    ].join(','),
  );
  return [cabecera, ...filas].join('\n');
}

export function descargar(nombre: string, contenido: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
