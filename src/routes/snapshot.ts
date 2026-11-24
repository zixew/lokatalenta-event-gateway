import { Router } from 'express';
import type { SnapshotProjection } from '../domain/snapshot.js';
import type { SseHub } from '../sse/sseHub.js';
import type { WsHub } from '../ws/wsHub.js';

export function createSnapshotRouter(deps: {
  snapshot: SnapshotProjection;
  wsHub: WsHub | null;
  sseHub: SseHub;
}): Router {
  const router = Router();

  router.get('/snapshot', (_req, res) => {
    const payload = deps.snapshot.getSnapshot({
      wsClients: deps.wsHub?.clientCount() ?? 0,
      sseClients: deps.sseHub.clientCount(),
    });
    res.status(200).json(payload);
  });

  return router;
}
