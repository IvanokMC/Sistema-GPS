/**
 * Prueba de humo: se conecta como dashboard y verifica que las posiciones
 * que envia un tracker llegan difundidas por el servidor.
 *   node viewer-test.mjs
 */
import WebSocket from 'ws';

const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8080';
const TOKEN = process.env.GPS_AUTH_TOKEN ?? 'dev-token';
const DURATION_MS = Number(process.env.DURATION_MS ?? 9000);

const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(TOKEN)}&role=viewer`);
let positions = 0;
let snapshots = 0;
let deviceEvents = 0;

socket.on('open', () => {
  console.log('[viewer] conectado');
  socket.send(JSON.stringify({ action: 'subscribe', payload: { deviceIds: ['*'] } }));
});

socket.on('message', (raw) => {
  const event = JSON.parse(raw.toString());
  if (event.type === 'snapshot') {
    snapshots++;
    console.log(`[viewer] snapshot con ${event.payload.devices.length} dispositivo(s)`);
  } else if (event.type === 'device') {
    deviceEvents++;
    console.log(`[viewer] device ${event.payload.deviceId} online=${event.payload.online}`);
  } else if (event.type === 'position') {
    positions++;
    if (positions <= 2) {
      console.log(`[viewer] posicion ${event.payload.lat.toFixed(5)}, ${event.payload.lng.toFixed(5)}`);
    }
  }
});

socket.on('error', (err) => console.error('[viewer] error:', err.message));

setTimeout(() => {
  console.log(`[viewer] RESUMEN snapshots=${snapshots} device=${deviceEvents} positions=${positions}`);
  process.exit(positions > 0 ? 0 : 1);
}, DURATION_MS);
