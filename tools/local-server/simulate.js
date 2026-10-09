/**
 * Simulador de recorrido realista.
 *
 * Envia posiciones por HTTP —igual que la app del celular— recorriendo fases
 * de caminar, detenerse, correr e ir en vehiculo. Inyecta a proposito los
 * defectos de un GPS real para verificar que el dashboard los absorbe:
 *
 *   - oscilacion de varios metros estando quieto
 *   - picos: lecturas que saltan cientos de metros
 *   - lecturas duplicadas
 *   - un corte de red cuyas lecturas llegan despues, fuera de orden
 *
 *   node simulate.js
 *   API_URL=https://xxx.execute-api.us-east-1.amazonaws.com \
 *     GPS_DEVICE_TOKEN=... DEVICE_ID=oppo-a78 node simulate.js
 *
 *   ACELERAR=3 node simulate.js    # fases tres veces mas cortas
 */
const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const TOKEN = process.env.GPS_DEVICE_TOKEN ?? 'dev-device';
const DEVICE_ID = process.env.DEVICE_ID ?? 'simulador-1';
const LABEL = process.env.LABEL ?? DEVICE_ID;
const ACELERAR = Number(process.env.ACELERAR ?? 1);
const PASO_MS = 2000;

// Punto de partida: cerca de la Plaza de Armas del Cusco.
// Cada simulador arranca en un punto distinto, derivado de su identificador,
// para poder probar varios a la vez sin que se superpongan.
const desplazamiento = [...DEVICE_ID].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 1000, 7) / 1000;
// START_LAT/START_LNG fijan el punto de partida (p. ej. dos celulares juntos).
let pos = process.env.START_LAT
  ? { lat: Number(process.env.START_LAT), lng: Number(process.env.START_LNG) }
  : { lat: -13.51667 - desplazamiento * 0.01, lng: -71.97889 + desplazamiento * 0.012 };
let rumbo = 45;

const FASES = [
  { nombre: 'caminando', seg: 60, vel: 1.4, giro: 4 },
  { nombre: 'detenido', seg: 40, vel: 0, giro: 0 },
  { nombre: 'corriendo', seg: 50, vel: 3.4, giro: 6 },
  { nombre: 'vehiculo', seg: 70, vel: 11, giro: 3 },
  { nombre: 'caminando', seg: 40, vel: 1.3, giro: 8 },
];

const ruido = (m) => (Math.random() - 0.5) * 2 * m;
const mover = (p, metros, grados) => {
  const r = (grados * Math.PI) / 180;
  return {
    lat: p.lat + (metros * Math.cos(r)) / 111_320,
    lng: p.lng + (metros * Math.sin(r)) / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
  };
};

async function enviar(positions) {
  try {
    const r = await fetch(`${API_URL}/positions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ positions }),
    });
    return r.status;
  } catch (e) {
    return `error: ${e.message}`;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Simulador "${DEVICE_ID}" -> ${API_URL}/positions (x${ACELERAR})\n`);
  let enviadas = 0;
  let cola = []; // lecturas retenidas durante el corte de red

  for (let vuelta = 1; ; vuelta++) {
    for (const fase of FASES) {
      // ACELERAR acorta las fases, no el tiempo entre lecturas: asi la
      // distancia recorrida sigue siendo coherente con la velocidad reportada.
      const pasos = Math.max(3, Math.round((fase.seg * 1000) / PASO_MS / ACELERAR));
      process.stdout.write(`\n  vuelta ${vuelta} · ${fase.nombre.padEnd(10)} `);

      for (let i = 0; i < pasos; i++) {
        rumbo += ruido(fase.giro);
        pos = mover(pos, (fase.vel * PASO_MS) / 1000, rumbo);

        const quieto = fase.vel === 0;
        const accuracy = quieto ? 12 + Math.random() * 10 : 5 + Math.random() * 7;
        // Lo que reporta el GPS: posicion real mas un error del orden de su precision.
        let lectura = {
          deviceId: DEVICE_ID,
          label: LABEL,
          ...mover(pos, Math.random() * accuracy * 0.6, Math.random() * 360),
          accuracy,
          altitude: 3400 + ruido(3),
          speed: quieto ? Math.random() * 0.3 : Math.max(0, fase.vel + ruido(fase.vel * 0.15)),
          heading: ((rumbo % 360) + 360) % 360,
          timestamp: Date.now(),
          battery: 0.8,
        };

        // Pico: ~2% de las lecturas saltan 300-800 m.
        if (Math.random() < 0.02) {
          lectura = { ...lectura, ...mover(lectura, 300 + Math.random() * 500, Math.random() * 360) };
          process.stdout.write('!');
        }

        // Corte de red de ~20 s en la fase de vehiculo: se acumula y se envia tarde.
        const enCorte = fase.nombre === 'vehiculo' && i >= 3 && i < Math.min(13, pasos - 2);
        if (enCorte) {
          cola.push(lectura);
          process.stdout.write('~');
        } else {
          const lote = [...cola.reverse(), lectura]; // ademas, fuera de orden
          cola = [];
          const estado = await enviar(lote);
          if (estado === 200) {
            enviadas += lote.length;
            process.stdout.write(lote.length > 1 ? `[${lote.length}]` : '.');
          } else {
            process.stdout.write(`(${estado})`);
          }
          // Duplicado: ~3% de las lecturas se reenvian.
          if (Math.random() < 0.03) {
            await enviar([lectura]);
            process.stdout.write('d');
          }
        }
        await esperar(PASO_MS);
      }
    }
    console.log(`\n  -- vuelta ${vuelta} completa, ${enviadas} lecturas enviadas`);
  }
}

main();
