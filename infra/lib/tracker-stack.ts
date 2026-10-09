import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
  WebSocketLambdaIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { WebSocketLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import type { Construct } from 'constructs';

export interface TrackerStackProps extends StackProps {
  /** Credencial de escritura: solo la tiene la app del celular. */
  deviceToken: string;
  /** Credencial de lectura: la lleva el dashboard publico. */
  viewerToken: string;
  /** Dispositivos que pueden enviar posiciones. */
  allowedDevices: string[];
  /** Segundos que se conserva el historial antes de que el TTL lo borre. */
  positionTtlSeconds?: number;
}

const HANDLERS = path.join(__dirname, '../../services/backend/src/handlers');

export class TrackerStack extends Stack {
  constructor(scope: Construct, id: string, props: TrackerStackProps) {
    super(scope, id, props);

    // 10 minutos: la tabla no crece y el recorrido visible es siempre reciente.
    const positionTtlSeconds = props.positionTtlSeconds ?? 600;

    /* ------------------------------- Tablas ------------------------------- */

    // Conexiones WebSocket activas. PAY_PER_REQUEST porque el trafico de un
    // rastreador es intermitente y no queremos pagar capacidad reservada.
    const connections = new dynamodb.Table(this, 'Connections', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Permite buscar "todos los viewers" sin escanear la tabla entera.
    connections.addGlobalSecondaryIndex({
      indexName: 'role-index',
      partitionKey: { name: 'role', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Historial de posiciones: (deviceId, timestamp) permite consultar el
    // recorrido de un dispositivo en un rango de tiempo con un solo Query.
    const positions = new dynamodb.Table(this, 'Positions', {
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Ultimo estado conocido por dispositivo: es lo que carga el dashboard al abrir.
    const devices = new dynamodb.Table(this, 'Devices', {
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Un celular que deja de reportar desaparece solo al vencer la retencion.
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /* ------------------------------ Lambdas ------------------------------- */

    const commonEnv = {
      TABLE_CONNECTIONS: connections.tableName,
      TABLE_POSITIONS: positions.tableName,
      TABLE_DEVICES: devices.tableName,
      POSITION_TTL_SECONDS: String(positionTtlSeconds),
      DEVICE_TOKEN: props.deviceToken,
      VIEWER_TOKEN: props.viewerToken,
      ALLOWED_DEVICES: props.allowedDevices.join(','),
      // Reutiliza la conexion TCP del SDK entre invocaciones.
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    };

    const makeFn = (fnId: string, entry: string) =>
      new NodejsFunction(this, fnId, {
        entry: path.join(HANDLERS, entry),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64, // ~20% mas barato que x86
        memorySize: 256,
        timeout: Duration.seconds(15),
        environment: commonEnv,
        // Grupo explicito: sin esto CDK crea un custom resource extra solo
        // para fijar la retencion, y los logs quedarian para siempre.
        logGroup: new logs.LogGroup(this, fnId + 'Logs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          format: OutputFormat.ESM,
          minify: true,
          sourceMap: true,
          target: 'node22',
          // El SDK de AWS ya viene en el runtime: no lo empaquetamos.
          externalModules: ['@aws-sdk/*'],
        },
      });

    const connectFn = makeFn('ConnectFn', 'connect.ts');
    const disconnectFn = makeFn('DisconnectFn', 'disconnect.ts');
    const messageFn = makeFn('MessageFn', 'message.ts');
    const apiFn = makeFn('ApiFn', 'api.ts');
    const authorizerFn = makeFn('AuthorizerFn', 'authorizer.ts');

    for (const fn of [connectFn, disconnectFn, messageFn]) {
      connections.grantReadWriteData(fn);
      positions.grantReadWriteData(fn);
      devices.grantReadWriteData(fn);
    }
    // La API HTTP ahora tambien ingiere posiciones y las difunde al dashboard.
    positions.grantReadWriteData(apiFn);
    devices.grantReadWriteData(apiFn);
    connections.grantReadWriteData(apiFn);

    /* --------------------------- API WebSocket ---------------------------- */

    const authorizer = new WebSocketLambdaAuthorizer('ConnectAuthorizer', authorizerFn, {
      identitySource: ['route.request.querystring.token'],
    });

    const wsApi = new apigwv2.WebSocketApi(this, 'TrackerWebSocketApi', {
      apiName: id + '-ws',
      description: 'Ingesta de posiciones GPS en tiempo real',
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnectIntegration', connectFn),
        authorizer,
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectFn),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('DefaultIntegration', messageFn),
      },
    });

    const wsStage = new apigwv2.WebSocketStage(this, 'ProdStage', {
      webSocketApi: wsApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // Necesario para que las Lambdas puedan responder por PostToConnection.
    for (const fn of [connectFn, disconnectFn, messageFn, apiFn]) {
      wsStage.grantManagementApiAccess(fn);
    }

    // La API HTTP necesita saber a donde difundir. Se fija despues de crear
    // la etapa porque la URL no existe hasta entonces.
    apiFn.addEnvironment('WS_ENDPOINT', `https://${wsApi.apiId}.execute-api.${this.region}.amazonaws.com/${wsStage.stageName}`);

    /* ------------------------------ API HTTP ------------------------------ */

    const httpApi = new apigwv2.HttpApi(this, 'TrackerHttpApi', {
      apiName: id + '-http',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type', 'authorization'],
      },
    });

    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFn);

    httpApi.addRoutes({
      path: '/positions',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/devices',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/devices/{deviceId}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/devices/{deviceId}/history',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    /* ------------------------------ Salidas ------------------------------- */

    new CfnOutput(this, 'WebSocketUrl', {
      value: wsStage.url,
      description: 'Pon esto en EXPO_PUBLIC_WS_URL y VITE_WS_URL',
    });
    new CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Pon esto en VITE_API_URL',
    });
    new CfnOutput(this, 'PositionsTableName', { value: positions.tableName });
  }
}
