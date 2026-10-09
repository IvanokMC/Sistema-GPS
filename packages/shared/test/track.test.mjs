// Pruebas del procesamiento de ruta. Cada caso reproduce un defecto que se
// veia en el dashboard.  Ejecutar:  npm test -w @gps/shared
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTrack,
  segmentTrack,
  trackStats,
  classifyMotion,
  createReportFilter,
  distanceMeters,
} from '../dist/index.js';

const T0 = 1_800_000_000_000;
const BASE = { lat: -13.5403, lng: -71.9564 };
/** Desplaza una coordenada unos metros hacia el norte / este. */
const mover = (p, norteM, esteM) => ({
  lat: p.lat + norteM / 111_320,
  lng: p.lng + esteM / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
});
const lectura = (seg, coord, extra = {}) => ({
  deviceId: 'oppo-a78',
  timestamp: T0 + seg * 1000,
  accuracy: 8,
  ...coord,
  ...extra,
});
const opciones = { now: T0 + 10 * 60_000, windowMs: 20 * 60_000 };

test('clasifica la velocidad en los cuatro modos', () => {
  assert.equal(classifyMotion(0.2), 'quieto');
  assert.equal(classifyMotion(1.4), 'caminando');
  assert.equal(classifyMotion(3.5), 'corriendo');
  assert.equal(classifyMotion(12), 'vehiculo');
  assert.equal(classifyMotion(NaN), 'quieto');
});

test('lecturas tardias se ordenan y no hacen volver la linea atras', () => {
  const crudas = [0, 1, 2, 3, 4, 5].map((s) => lectura(s * 3, mover(BASE, s * 4, 0), { speed: 1.3 }));
  // Llega primero el final y despues el principio, como tras un corte de red.
  const desordenadas = [...crudas.slice(3), ...crudas.slice(0, 3)];
  const ruta = cleanTrack(desordenadas, opciones);
  const horas = ruta.map((p) => p.timestamp);
  assert.deepEqual(horas, [...horas].sort((a, b) => a - b));
  assert.equal(ruta.length, 6);
});

test('una lectura recibida dos veces no se dibuja dos veces', () => {
  const p = lectura(0, BASE);
  const ruta = cleanTrack([p, { ...p }, lectura(3, mover(BASE, 5, 0))], opciones);
  assert.equal(ruta.length, 2);
});

test('la oscilacion estando quieto se colapsa en un solo punto', () => {
  // 20 lecturas dispersas hasta 6 m alrededor del mismo lugar, sin velocidad.
  const quieto = Array.from({ length: 20 }, (_, i) =>
    lectura(i * 3, mover(BASE, Math.sin(i) * 6, Math.cos(i * 1.7) * 6), { speed: 0 }),
  );
  const ruta = cleanTrack(quieto, opciones);
  const unicas = new Set(ruta.map((p) => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`));
  assert.equal(unicas.size, 1, 'todas las lecturas de la parada comparten coordenada');
  assert.ok(distanceMeters(ruta[0], BASE) < 3, 'el centro cae cerca del lugar real');
});

test('un salto imposible del receptor se descarta', () => {
  const crudas = [
    lectura(0, BASE, { speed: 1.4 }),
    lectura(2, mover(BASE, 3, 0), { speed: 1.4 }),
    lectura(4, mover(BASE, 900, 0), { speed: 1.4 }), // 900 m en 2 s
    lectura(6, mover(BASE, 8, 0), { speed: 1.4 }),
  ];
  const ruta = cleanTrack(crudas, opciones);
  assert.equal(ruta.length, 3);
  assert.ok(ruta.every((p) => distanceMeters(p, BASE) < 20));
});

test('una primera lectura mala no envenena las siguientes', () => {
  // Tipico al arrancar: la primera ubicacion es una aproximacion por antena
  // a varios km, y despues llegan las lecturas buenas del GPS.
  const mala = lectura(0, mover(BASE, 8000, 0), { accuracy: 30 });
  const buenas = Array.from({ length: 15 }, (_, i) =>
    lectura(2 + i * 2, mover(BASE, i * 3, 0), { speed: 1.4 }),
  );
  const ruta = cleanTrack([mala, ...buenas], opciones);
  assert.equal(ruta.length, 15, 'todas las lecturas buenas se conservan');
  assert.ok(ruta.every((p) => distanceMeters(p, BASE) < 60));
});

test('dos picos seguidos tambien se descartan', () => {
  const crudas = [];
  for (let i = 0; i < 20; i++) {
    const pico = i === 9 || i === 10;
    crudas.push(lectura(i * 2, mover(BASE, pico ? 700 : i * 3, pico ? 400 : 0), { speed: 1.4 }));
  }
  const ruta = cleanTrack(crudas, opciones);
  assert.equal(ruta.length, 18);
  const [tramo, ...resto] = segmentTrack(ruta);
  assert.equal(resto.length, 0, 'la ruta sigue siendo un solo tramo');
  assert.equal(tramo.points.length, 18);
});

test('las lecturas imprecisas no entran en la ruta', () => {
  const ruta = cleanTrack(
    [lectura(0, BASE), lectura(3, mover(BASE, 80, 0), { accuracy: 150 }), lectura(6, mover(BASE, 4, 0))],
    opciones,
  );
  assert.equal(ruta.length, 2);
});

test('un corte de señal separa la ruta en tramos que no se unen', () => {
  const antes = [0, 1, 2].map((s) => lectura(s * 3, mover(BASE, s * 4, 0), { speed: 1.3 }));
  const despues = [0, 1, 2].map((s) =>
    lectura(300 + s * 3, mover(BASE, 400 + s * 4, 0), { speed: 1.3 }),
  );
  const tramos = segmentTrack(cleanTrack([...antes, ...despues], opciones));
  assert.equal(tramos.length, 2);
});

test('caminar, correr y conducir producen tramos de color continuos', () => {
  const crudas = [];
  let pos = BASE;
  let s = 0;
  const fase = (n, velocidad) => {
    for (let i = 0; i < n; i++) {
      pos = mover(pos, velocidad * 2, 0);
      s += 2;
      crudas.push(lectura(s, pos, { speed: velocidad }));
    }
  };
  fase(10, 1.4); // caminar
  fase(10, 3.5); // correr
  fase(10, 12); // vehiculo

  const [tramo] = segmentTrack(cleanTrack(crudas, opciones));
  assert.deepEqual(
    tramo.segments.map((g) => g.mode),
    ['caminando', 'corriendo', 'vehiculo'],
  );
  // Cada tramo empieza donde termino el anterior: sin huecos en la linea.
  for (let i = 1; i < tramo.segments.length; i++) {
    const fin = tramo.segments[i - 1].points.at(-1);
    const inicio = tramo.segments[i].points[0];
    assert.equal(fin.timestamp, inicio.timestamp);
  }

  const stats = trackStats(cleanTrack(crudas, opciones));
  assert.ok(stats.distanceM > 0);
  assert.ok(Math.abs(stats.maxSpeedMs - 12) < 0.01);
  assert.ok(stats.timeByMode.vehiculo > 0);
});

test('una lectura suelta no cambia el modo gracias a la mediana', () => {
  const crudas = Array.from({ length: 11 }, (_, i) =>
    lectura(i * 2, mover(BASE, i * 2.8, 0), { speed: i === 5 ? 9 : 1.4 }),
  );
  const modos = cleanTrack(crudas, opciones).map((p) => p.mode);
  assert.ok(modos.every((m) => m === 'caminando'), modos.join(','));
});

/* ----------------------------- Filtro de envio ----------------------------- */

const filtroBase = {
  maxAccuracyM: 35,
  heartbeatMs: 30_000,
  movingIntervalMs: 5_000,
  minDistanceM: 6,
  maxAgeMs: 30_000,
};

test('el latido se dispara aunque el sistema repita lecturas quietas', () => {
  const f = createReportFilter(filtroBase);
  let reloj = T0;
  assert.equal(f.decide(lectura(0, BASE), reloj).send, true);
  const enviadas = [];
  for (let s = 2; s <= 70; s += 2) {
    reloj = T0 + s * 1000;
    const d = f.decide({ ...lectura(s, mover(BASE, 0.5, 0)), speed: 0 }, reloj);
    if (d.send) enviadas.push(d.reason);
  }
  assert.deepEqual(enviadas, ['latido', 'latido']);
});

test('una lectura vieja en cache del sistema se ignora', () => {
  const f = createReportFilter(filtroBase);
  const d = f.decide(lectura(0, BASE), T0 + 5 * 60_000);
  assert.deepEqual(d, { send: false, reason: 'antigua' });
});

test('al moverse se envia por distancia', () => {
  const f = createReportFilter(filtroBase);
  f.decide(lectura(0, BASE), T0);
  const d = f.decide(lectura(3, mover(BASE, 7, 0), { speed: 1.4 }), T0 + 3000);
  assert.equal(d.send && d.reason, 'movimiento');
});

test('bajo techo, sin lecturas precisas, el latido envia la mejor disponible', () => {
  const f = createReportFilter(filtroBase);
  f.decide(lectura(0, BASE), T0);
  const envios = [];
  for (let s = 2; s <= 32; s += 2) {
    const d = f.decide(lectura(s, BASE, { accuracy: s === 10 ? 40 : 90 }), T0 + s * 1000);
    if (d.send) envios.push(d);
  }
  assert.equal(envios.length, 1, 'un solo latido en 30 s');
  assert.equal(envios[0].reason, 'latido');
  assert.equal(envios[0].position.accuracy, 40, 'elige la lectura mas precisa del intervalo');
});
