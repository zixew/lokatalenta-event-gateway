import express, { Router } from 'express';
import type { GatewayConfig } from '../config.js';
import { isPlainObject } from '../domain/normalize.js';
import type { SnapshotProjection } from '../domain/snapshot.js';
import type { SseHub } from '../sse/sseHub.js';
import type { SqliteEventStore } from '../store/sqliteStore.js';
import { mapGitHubWebhookToEvent } from '../webhooks/githubMapper.js';
import { verifyHmacSignature } from '../webhooks/signature.js';
import type { WsHub } from '../ws/wsHub.js';

export function createGitHubWebhookRouter(deps: {
  config: GatewayConfig;
  store: SqliteEventStore;
  snapshot: SnapshotProjection;
  wsHub: WsHub | null;
  sseHub: SseHub;
}): Router {
  const router = Router();

  router.post(
    '/webhooks/github',
    express.raw({ type: '*/*', limit: '2mb' }),
    (req, res) => {
      const rawBuf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.alloc(0);

      // 1. Required secret & X-Hub-Signature-256 verification BEFORE JSON.parse
      if (!deps.config.githubWebhookSecret) {
        res.status(401).json({
          ok: false,
          error: 'Unauthorized: GITHUB_WEBHOOK_SECRET is not configured',
        });
        return;
      }

      const sigHeader = req.header('x-hub-signature-256');
      const sigOk = verifyHmacSignature(
        rawBuf,
        sigHeader,
        deps.config.githubWebhookSecret,
        { requireSha256Prefix: true },
      );

      if (!sigOk) {
        res.status(401).json({
          ok: false,
          error: 'Invalid or missing X-Hub-Signature-256',
        });
        return;
      }

      // 2. Parse JSON & check plain object
      if (rawBuf.length === 0) {
        res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBuf.toString('utf8'));
      } catch {
        res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
        return;
      }

      if (!isPlainObject(parsed)) {
        res.status(400).json({
          ok: false,
          error: 'GitHub webhook payload must be a JSON object',
        });
        return;
      }

      const githubEvent = req.header('x-github-event');
      if (!githubEvent || githubEvent.trim().length === 0) {
        res.status(400).json({
          ok: false,
          error: 'Missing X-GitHub-Event header',
        });
        return;
      }

      const deliveryId = req.header('x-github-delivery') ?? undefined;
      const mapped = mapGitHubWebhookToEvent({
        githubEvent,
        deliveryId,
        payload: parsed,
        rawBody: rawBuf,
      });

      if (mapped.kind === 'ping') {
        res.status(200).json({
          ok: true,
          event: 'ping',
          zen: mapped.zen,
        });
        return;
      }

      if (mapped.kind === 'ignored') {
        res.status(202).json({
          ok: true,
          ignored: true,
          githubEvent: mapped.githubEvent,
        });
        return;
      }

      if (mapped.kind === 'error') {
        res.status(400).json({
          ok: false,
          error: mapped.message,
        });
        return;
      }

      const { seq, event, duplicate } = deps.store.insertIdempotent(mapped.event);
      if (duplicate) {
        res.status(200).json({
          ok: true,
          duplicate: true,
          event,
        });
        return;
      }

      const clientCounts = {
        wsClients: deps.wsHub?.clientCount() ?? 0,
        sseClients: deps.sseHub.clientCount(),
      };
      const snapshotDelta = deps.snapshot.applyEvent(event, seq, clientCounts);
      deps.wsHub?.broadcastEvent(event, snapshotDelta);
      deps.sseHub.broadcastEvent(event, snapshotDelta);

      res.status(202).json({
        ok: true,
        event,
      });
    },
  );

  return router;
}
