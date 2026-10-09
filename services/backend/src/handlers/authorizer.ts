import type {
  APIGatewayAuthorizerResult,
  APIGatewayRequestAuthorizerEvent,
} from 'aws-lambda';
import { isAllowedDevice, roleFor } from '../lib/auth.js';

/**
 * Autorizador del handshake WebSocket ($connect).
 *
 * El cliente se conecta a  wss://.../prod?token=...&role=viewer
 * (o role=tracker&deviceId=... para un dispositivo).
 *
 *  - viewer:  cualquier token valido (el de lectura basta).
 *  - tracker: exige el token de escritura Y un dispositivo de la lista.
 *
 * IMPORTANTE: una API WebSocket exige una politica IAM como respuesta. El
 * formato simplificado { isAuthorized } solo lo admiten las APIs HTTP;
 * devolverlo aqui hace fallar el handshake con HTTP 500.
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const params = event.queryStringParameters ?? {};
  const role = params.role === 'tracker' ? 'tracker' : 'viewer';
  const deviceId = (params.deviceId ?? '').trim();
  const credencial = roleFor(params.token);

  const permitido =
    role === 'viewer'
      ? credencial !== null
      : credencial === 'device' && isAllowedDevice(deviceId);

  return {
    principalId: deviceId || role,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: permitido ? 'Allow' : 'Deny',
          Resource: event.methodArn,
        },
      ],
    },
    context: { role, deviceId },
  };
};
