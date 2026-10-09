#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { TrackerStack } from '../lib/tracker-stack';

const app = new App();

// Las credenciales se pasan por variable de entorno para no dejarlas en el repo:
//   GPS_DEVICE_TOKEN   escritura (app del celular)
//   GPS_VIEWER_TOKEN   lectura (dashboard publico)
//   GPS_ALLOWED_DEVICES  lista separada por comas, p. ej. "oppo-a78"
const deviceToken = app.node.tryGetContext('deviceToken') ?? process.env.GPS_DEVICE_TOKEN ?? '';
const viewerToken = app.node.tryGetContext('viewerToken') ?? process.env.GPS_VIEWER_TOKEN ?? '';
const allowed: string =
  app.node.tryGetContext('allowedDevices') ?? process.env.GPS_ALLOWED_DEVICES ?? 'oppo-a78';

if (!deviceToken || !viewerToken) {
  throw new Error('Faltan GPS_DEVICE_TOKEN y GPS_VIEWER_TOKEN. Ver BITACORA.md, seccion de despliegue.');
}
if (deviceToken === viewerToken) {
  throw new Error('Las credenciales de escritura y de lectura deben ser distintas.');
}

new TrackerStack(app, 'GpsTracker', {
  deviceToken,
  viewerToken,
  allowedDevices: allowed.split(',').map((d) => d.trim()).filter(Boolean),
  positionTtlSeconds: Number(app.node.tryGetContext('positionTtlSeconds') ?? 600),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Rastreo GPS en tiempo real: WebSocket + Lambda + DynamoDB',
});
