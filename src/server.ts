import http from 'node:http';
import type { AddressInfo } from 'node:net';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { type GatewayConfig, loadConfig } from './config.js';
import { SnapshotProjection } from './domain/snapshot.js';
import { createEventsRouter } from './routes/events.js';
import { createGitHubWebhookRouter } from './routes/githubWebhook.js';
import { createHealthRouter } from './routes/health.js';
import { createSnapshotRouter } from './routes/snapshot.js';
import { SseHub } from './sse/sseHub.js';
import { SqliteEventStore } from './store/sqliteStore.js';
import { WsHub } from './ws/wsHub.js';

const LOCAL_ECOSYSTEM_ORIGIN_REGEX =
  /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i;
const VERCEL_ORIGIN_REGEX =
  /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i;

export interface GatewayServer {
  app: express.Express;
  httpServer: http.Server;
  config: GatewayConfig;
  store: SqliteEventStore;
  snapshot: SnapshotProjection;
  wsHub: WsHub | null;
  sseHub: SseHub;
  port: number;
  baseUrl: string;
  wsUrl: string;
  sseUrl: string;
  start: () => Promise<number>;
  close: () => Promise<void>;
}

export function isAllowedCorsOrigin(
  origin: string | undefined,
  corsOriginConfig: string,
): boolean {
  if (!origin) return true;
  const configured = corsOriginConfig
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.includes('*') || configured.includes(origin)) {
    return true;
  }
  return LOCAL_ECOSYSTEM_ORIGIN_REGEX.test(origin) || VERCEL_ORIGIN_REGEX.test(origin);
}

function buildCorsOriginMatcher(
  corsOriginConfig: string,
): (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) => void {
  return (origin, callback) => {
    callback(null, isAllowedCorsOrigin(origin, corsOriginConfig));
  };
}

export function createGatewayServer(
  overrides: Partial<GatewayConfig> = {},
): GatewayServer {
  const config = loadConfig(overrides);
  const store = new SqliteEventStore(config.dbPath);
  const snapshot = new SnapshotProjection(config.recentEventsLimit);

  // Hydrate projection from SQLite on startup
  const hydration = store.getHydrationData(config.recentEventsLimit);
  snapshot.hydrateFromRows(hydration.rowsAsc, {
    totalEvents: hydration.totalEvents,
    lastEventSeq: hydration.lastEventSeq,
    bySource: hydration.bySource,
    byDivision: hydration.byDivision,
    bySeverity: hydration.bySeverity,
  });

  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use(
    cors({
      origin: buildCorsOriginMatcher(config.corsOrigin),
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-lokatalenta-signature',
        'Last-Event-ID',
        'Cache-Control',
      ],
      optionsSuccessStatus: 204,
    }),
  );

  const httpServer = http.createServer(app);

  let wsHub: WsHub | null = null;
  let sseHub!: SseHub;

  const getCurrentSnapshot = () =>
    snapshot.getSnapshot({
      wsClients: wsHub?.clientCount() ?? 0,
      sseClients: sseHub?.clientCount() ?? 0,
    });

  if (config.enableWs) {
    wsHub = new WsHub({
      httpServer,
      getSnapshot: getCurrentSnapshot,
      heartbeatMs: config.wsHeartbeatMs,
    });
  }

  sseHub = new SseHub({
    store,
    getSnapshot: getCurrentSnapshot,
    keepaliveMs: config.sseKeepaliveMs,
  });

  let actualPort = config.port;
  const getPort = () => actualPort;

  app.use(
    createHealthRouter({
      getPort,
      store,
      snapshot,
      wsHub,
      sseHub,
    }),
  );
  app.use(createSnapshotRouter({ snapshot, wsHub, sseHub }));
  app.get('/events/stream', sseHub.handleConnection);
  app.use(createEventsRouter({ config, store, snapshot, wsHub, sseHub }));
  app.use(createGitHubWebhookRouter({ config, store, snapshot, wsHub, sseHub }));

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not Found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const message =
      status === 413
        ? 'Payload too large'
        : err instanceof Error && status < 500
          ? err.message
          : 'Internal Server Error';
    if (!res.headersSent) {
      res.status(status).json({ ok: false, error: message });
    }
  });

  let started = false;
  let closed = false;

  const serverObj: GatewayServer = {
    app,
    httpServer,
    config,
    store,
    snapshot,
    wsHub,
    sseHub,
    get port() {
      return actualPort;
    },
    get baseUrl() {
      return `http://127.0.0.1:${actualPort}`;
    },
    get wsUrl() {
      return `ws://127.0.0.1:${actualPort}/ws`;
    },
    get sseUrl() {
      return `http://127.0.0.1:${actualPort}/events/stream`;
    },
    start: () =>
      new Promise<number>((resolve, reject) => {
        if (started) {
          resolve(actualPort);
          return;
        }
        const onError = (err: Error) => {
          reject(err);
        };
        httpServer.once('error', onError);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', onError);
          started = true;
          const addr = httpServer.address() as AddressInfo | null;
          if (addr && typeof addr.port === 'number') {
            actualPort = addr.port;
          }
          resolve(actualPort);
        });
      }),
    close: async () => {
      if (closed) return;
      closed = true;
      sseHub.close();
      if (wsHub) {
        await wsHub.close();
      }
      await new Promise<void>((resolve) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
      store.close();
    },
  };

  return serverObj;
}
