import { Router } from 'express';
import type { SnapshotProjection } from '../domain/snapshot.js';
import type { SseHub } from '../sse/sseHub.js';
import type { SqliteEventStore } from '../store/sqliteStore.js';
import type { WsHub } from '../ws/wsHub.js';

export function createHealthRouter(deps: {
  getPort: () => number;
  store: SqliteEventStore;
  snapshot: SnapshotProjection;
  wsHub: WsHub | null;
  sseHub: SseHub;
}): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const wsClients = deps.wsHub?.clientCount() ?? 0;
    const sseClients = deps.sseHub.clientCount();
    const stats = deps.snapshot.getStats({ wsClients, sseClients });
    const sqliteSeq = deps.store.getLatestSeq();

    res.status(200).json({
      ok: true,
      status: 'ok',
      service: 'lokatalenta-event-gateway',
      port: deps.getPort(),
      db: 'sqlite',
      sqliteSeq,
      uptime: stats.uptimeSeconds,
      uptimeSeconds: stats.uptimeSeconds,
      wsClients,
      sseClients,
      eventCount: stats.totalEvents,
    });
  });

  return router;
}
