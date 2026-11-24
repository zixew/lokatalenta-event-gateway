import express, { Router } from 'express';
import type { GatewayConfig } from '../config.js';
import { normalizeAndValidateEvent } from '../domain/normalize.js';
import type { SnapshotProjection } from '../domain/snapshot.js';
import type { SseHub } from '../sse/sseHub.js';
import type { SqliteEventStore } from '../store/sqliteStore.js';
import { verifyBearerToken, verifyHmacSignature } from '../webhooks/signature.js';
import type { WsHub } from '../ws/wsHub.js';

function parseBoundedIntQuery(
  raw: unknown,
  name: string,
  min: number,
  max: number,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return { ok: false, error: `Query parameter "${name}" must be an integer` };
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    return {
      ok: false,
      error: `Query parameter "${name}" must be between ${min} and ${max}`,
    };
  }
  return { ok: true, value };
}

function parseOptionalStringQuery(
  raw: unknown,
  name: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `Query parameter "${name}" must be a string` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
}

export function createEventsRouter(deps: {
  config: GatewayConfig;
  store: SqliteEventStore;
  snapshot: SnapshotProjection;
  wsHub: WsHub | null;
  sseHub: SseHub;
}): Router {
  const router = Router();

  router.get('/events', (req, res) => {
    const limitRes = parseBoundedIntQuery(req.query.limit, 'limit', 1, 500);
    if (!limitRes.ok) {
      res.status(400).json({ ok: false, error: limitRes.error });
      return;
    }

    const agentIdRes = parseBoundedIntQuery(req.query.agentId, 'agentId', 0, 23);
    if (!agentIdRes.ok) {
      res.status(400).json({ ok: false, error: agentIdRes.error });
      return;
    }

    const sinceSeqRes = parseBoundedIntQuery(
      req.query.sinceSeq,
      'sinceSeq',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (!sinceSeqRes.ok) {
      res.status(400).json({ ok: false, error: sinceSeqRes.error });
      return;
    }

    let sinceSeq = sinceSeqRes.value;
    let sinceTimestamp: string | undefined;

    if (sinceSeq === undefined && req.query.since !== undefined) {
      if (typeof req.query.since !== 'string') {
        res.status(400).json({ ok: false, error: 'Query parameter "since" must be a string' });
        return;
      }
      const rawSince = req.query.since.trim();
      if (rawSince.length > 0) {
        if (/^\d+$/.test(rawSince)) {
          sinceSeq = Number(rawSince);
        } else if (
          /\d{4}-\d{2}-\d{2}/.test(rawSince) &&
          !Number.isNaN(Date.parse(rawSince))
        ) {
          sinceTimestamp = new Date(rawSince).toISOString();
        } else {
          const resolvedSeq = deps.store.resolveSeqForLastEventId(rawSince);
          if (resolvedSeq !== null) {
            sinceSeq = resolvedSeq;
          } else if (
            /^(evt|gh|lms|bl|spr|doc)-[a-zA-Z0-9_-]{1,120}$/i.test(rawSince) ||
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSince)
          ) {
            res.status(200).json({ ok: true, events: [], total: 0 });
            return;
          } else {
            res.status(400).json({
              ok: false,
              error: 'Query parameter "since" must be a numeric seq, ISO timestamp, or known event id',
            });
            return;
          }
        }
      }
    }

    const sourceRes = parseOptionalStringQuery(req.query.source, 'source');
    if (!sourceRes.ok) {
      res.status(400).json({ ok: false, error: sourceRes.error });
      return;
    }

    const divisionIdRes = parseOptionalStringQuery(
      req.query.divisionId,
      'divisionId',
    );
    if (!divisionIdRes.ok) {
      res.status(400).json({ ok: false, error: divisionIdRes.error });
      return;
    }

    const typeRes = parseOptionalStringQuery(req.query.type, 'type');
    if (!typeRes.ok) {
      res.status(400).json({ ok: false, error: typeRes.error });
      return;
    }

    const rows = deps.store.queryEvents({
      limit: limitRes.value,
      agentId: agentIdRes.value,
      sinceSeq,
      sinceTimestamp,
      source: sourceRes.value,
      divisionId: divisionIdRes.value,
      type: typeRes.value,
    });

    res.status(200).json({
      ok: true,
      events: rows.map((r) => r.event),
      total: rows.length,
    });
  });

  router.post(
    '/events',
    express.raw({ type: '*/*', limit: '1mb' }),
    (req, res) => {
      const rawBuf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.alloc(0);

      // 1. Auth BEFORE JSON.parse when GATEWAY_EVENT_SECRET is configured
      if (deps.config.gatewayEventSecret.length > 0) {
        const sigValid = verifyHmacSignature(
          rawBuf,
          req.header('x-lokatalenta-signature'),
          deps.config.gatewayEventSecret,
          { requireSha256Prefix: false },
        );
        const bearerValid = verifyBearerToken(
          req.header('authorization'),
          deps.config.gatewayEventSecret,
        );

        if (!sigValid && !bearerValid) {
          res.status(401).json({ ok: false, error: 'Unauthorized' });
          return;
        }
      }

      // 2. Parse JSON
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

      // 3. Normalize, scrub PII, and validate against Ajv2020 event-schema.json
      const normalized = normalizeAndValidateEvent(parsed);
      if (!normalized.ok) {
        res.status(400).json({
          ok: false,
          error: 'Validation failed',
          details: normalized.details,
        });
        return;
      }

      // 4. Atomic SQLite idempotent insert before WS/SSE broadcast
      const { seq, event, duplicate } = deps.store.insertIdempotent(
        normalized.event,
      );

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
