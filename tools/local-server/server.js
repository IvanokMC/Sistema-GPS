/**
 * Servidor de desarrollo.
 *
 * Reproduce el comportamiento del backend en AWS —mismas rutas, mismas
 * credenciales, misma retencion— pero guardando todo en memoria. Sirve para
 * probar la app y el dashboard sin desplegar ni gastar.
 *
 *   node server.js
 *
 * Variables:
 *   PORT                  8080
 *   GPS_DEVICE_TOKEN      dev-device   (escritura: la app del celular)
 *   GPS_VIEWER_TOKEN      dev-viewer   (lectura: el dashboard)
 *   GPS_ALLOWED_DEVICES   oppo-a78,simulador-1
 *   POSITION_TTL_SECONDS  600
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { isValidDeviceId, parseClientMessage, parsePosition } from '@gps/shared';

const PORT = Number(process.env.PORT ?? 8080);
const DEVICE_TOKEN = process.env.GPS_DEVICE_TOKEN ?? 'dev-device';
const VIEWER_TOKEN = process.env.GPS_VIEWER_TOKEN ?? 'dev-viewer';
const ALLOWED = (process.env.GPS_ALLOWED_DEVICES ?? '*')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean);
const RETENTION_SECONDS = Number(process.env.POSITION_TTL_SECONDS ?? '600');

/** deviceId -> { deviceId, lastPosition, lastSeen, online } */
const devices = new Map();
/** deviceId -> Position[] */
const history = new Map();
/** Sockets con rol viewer */
const viewers = new Set();

/** "*" en la lista: cualquier celular con la app; si no, solo los listados. */
const permitido = (id) => isValidDeviceId(id) && (ALLOWED.includes('*') || ALLOWED.includes(id));

const roleFor = (token) => {
  const t = (token ?? '').replace(/^Bearer\s+/i, '');
  if (t && t === DEVICE_TOKEN) return 'device';
  if (t && t === VIEWER_TOKEN) return 'viewer';
  return null;
};

const send = (socket, event) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
};

const broadcast = (deviceId, event) => {
  for (const viewer of viewers) {
    const subs = viewer.gps.subscriptions;
    if (!subs || subs.includes('*') || subs.includes(deviceId)) send(viewer, event);
  }
};

/** Mismo criterio que AWS: fuera de la ventana no se devuelve ni se guarda. */
function purgarAntiguas(now = Date.now()) {
  const cutoff = now - RETENTION_SECONDS * 1000;
  // Igual que el TTL de la tabla de dispositivos en AWS.
  for (const [deviceId, d] of devices) {
    if ((d.lastSeen ?? 0) < cutoff) devices.delete(deviceId);
  }
  for (const [deviceId, list] of history) {
    const vigentes = list.filter((p) => p.timestamp >= cutoff);
    if (vigentes.length === 0) history.delete(deviceId);
    else if (vigentes.length !== list.length) history.set(deviceId, vigentes);
  }
}
setInterval(() => purgarAntiguas(), 15_000).unref();

/** Guarda y difunde posiciones ya validadas. Devuelve cuantas acepto. */
function ingerir(items) {
  const now = Date.now();
  let accepted = 0;
  const ajenos = new Set();

  for (const item of items.slice(0, 200)) {
    const position = parsePosition(item, now);
    if (!position) continue;
    if (!permitido(position.deviceId)) {
      ajenos.add(position.deviceId);
      continue;
    }
    accepted++;

    const list = history.get(position.deviceId) ?? [];
    // Una lectura repetida (misma hora) reemplaza a la anterior en vez de duplicarse.
    const idx = list.findIndex((p) => p.timestamp === position.timestamp);
    if (idx >= 0) list[idx] = position;
    else list.push(position);
    list.sort((a, b) => a.timestamp - b.timestamp);
    history.set(position.deviceId, list);

    const previo = devices.get(position.deviceId);
    if (!previo?.lastPosition || previo.lastPosition.timestamp <= position.timestamp) {
      devices.set(position.deviceId, {
        deviceId: position.deviceId,
        label: position.label ?? previo?.label,
        lastPosition: position,
        lastSeen: now,
        online: true,
      });
    }
    broadcast(position.deviceId, { type: 'position', payload: position });
  }
  return { accepted, rejected: items.length - accepted, ajenos: [...ajenos] };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const role = roleFor(req.headers.authorization);
  if (!role) return json(res, 401, { error: 'No autorizado' });

  if (req.method === 'POST' && url.pathname === '/positions') {
    if (role !== 'device') return json(res, 403, { error: 'Esta credencial solo permite lectura' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { error: 'JSON invalido' });
      }
      const items = Array.isArray(payload) ? payload : (payload?.positions ?? [payload]);
      const r = ingerir(items);
      if (r.accepted === 0 && r.ajenos.length > 0) {
        return json(res, 403, { error: 'Dispositivo no autorizado', devices: r.ajenos });
      }
      json(res, 200, { accepted: r.accepted, rejected: r.rejected, serverTime: Date.now() });
    });
    return;
  }

  const borrar = url.pathname.match(/^\/devices\/([^/]+)$/);
  if (req.method === 'DELETE' && borrar) {
    if (role !== 'device') return json(res, 403, { error: 'Esta credencial solo permite lectura' });
    const deviceId = decodeURIComponent(borrar[1]);
    if (!permitido(deviceId)) return json(res, 400, { error: 'Identificador no valido' });
    const borradas = history.get(deviceId)?.length ?? 0;
    history.delete(deviceId);
    devices.delete(deviceId);
    broadcast(deviceId, { type: 'removed', payload: { deviceId } });
    console.log(`[x] ${deviceId} detuvo el rastreo, ${borradas} posiciones borradas`);
    return json(res, 200, { deviceId, borradas });
  }

  if (url.pathname === '/devices') {
    return json(res, 200, { devices: [...devices.values()].filter((d) => permitido(d.deviceId)) });
  }

  const match = url.pathname.match(/^\/devices\/([^/]+)\/history$/);
  if (match) {
    const deviceId = decodeURIComponent(match[1]);
    const to = Number(url.searchParams.get('to')) || Date.now();
    const pedido = Number(url.searchParams.get('from')) || to - RETENTION_SECONDS * 1000;
    const from = Math.max(pedido, Date.now() - RETENTION_SECONDS * 1000);
    const positions = (history.get(deviceId) ?? []).filter(
      (p) => p.timestamp >= from && p.timestamp <= to,
    );
    return json(res, 200, { deviceId, from, to, count: positions.length, positions });
  }

  json(res, 404, { error: 'Ruta no encontrada' });
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const role = url.searchParams.get('role') === 'tracker' ? 'tracker' : 'viewer';
  const deviceId = (url.searchParams.get('deviceId') ?? '').trim();
  const credencial = roleFor(url.searchParams.get('token'));

  const autorizado =
    role === 'viewer' ? credencial !== null : credencial === 'device' && permitido(deviceId);

  if (!autorizado) {
    send(socket, { type: 'error', payload: { code: 'UNAUTHORIZED', message: 'Credencial o dispositivo no autorizado' } });
    socket.close(1008, 'unauthorized');
    return;
  }

  socket.gps = { role, deviceId, subscriptions: role === 'viewer' ? ['*'] : undefined };
  console.log(`[+] ${role}${deviceId ? ' ' + deviceId : ''} conectado`);

  if (role === 'viewer') {
    viewers.add(socket);
    send(socket, { type: 'snapshot', payload: { devices: [...devices.values()] } });
  }

  socket.on('message', (raw) => {
    const message = parseClientMessage(raw.toString());
    if (!message) {
      send(socket, { type: 'error', payload: { code: 'BAD_REQUEST', message: 'Mensaje invalido' } });
      return;
    }
    if (message.action === 'ping') {
      send(socket, { type: 'pong', payload: { t: message.payload?.t ?? 0, serverTime: Date.now() } });
      return;
    }
    if (message.action === 'subscribe') {
      socket.gps.subscriptions = message.payload?.deviceIds ?? ['*'];
      send(socket, { type: 'snapshot', payload: { devices: [...devices.values()] } });
      return;
    }
    if (socket.gps.role !== 'tracker') {
      send(socket, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Solo un tracker envia posiciones' } });
      return;
    }
    const items = message.action === 'position' ? [message.payload] : (message.payload?.positions ?? []);
    const r = ingerir(items.map((p) => ({ ...p, deviceId: socket.gps.deviceId })));
    send(socket, { type: 'ack', payload: { accepted: r.accepted, rejected: r.rejected, serverTime: Date.now() } });
  });

  socket.on('close', () => {
    viewers.delete(socket);
    console.log(`[-] ${role}${deviceId ? ' ' + deviceId : ''} desconectado`);
  });
});

function localAddresses() {
  const result = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) result.push(iface.address);
    }
  }
  return result;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Servidor GPS local escuchando');
  console.log(`  Escritura (celular): ${DEVICE_TOKEN}`);
  console.log(`  Lectura (dashboard): ${VIEWER_TOKEN}`);
  console.log(`  Dispositivos:        ${ALLOWED.includes('*') ? 'cualquiera con la app' : ALLOWED.join(', ')}`);
  console.log(`  Retencion:           ${RETENTION_SECONDS} s`);
  console.log(`  Local:  http://localhost:${PORT}`);
  for (const address of localAddresses()) console.log(`  LAN:    http://${address}:${PORT}`);
  console.log('');
});
