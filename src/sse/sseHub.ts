import type { Request, Response } from 'express';
import type { GatewaySnapshot, NormalizedEvent, SnapshotDelta } from '../domain/types.js';
import type { SqliteEventStore } from '../store/sqliteStore.js';

interface SseClient {
  res: Response;
  keepaliveTimer: NodeJS.Timeout;
}

function writeSseFrame(
  res: Response,
  options: { id?: string; event: string; data: unknown },
): boolean {
  if (res.writableEnded || res.destroyed) return false;
  const lines: string[] = [];
  if (options.id !== undefined) {
    lines.push(`id: ${options.id}`);
  }
  lines.push(`event: ${options.event}`);
  lines.push(`data: ${JSON.stringify(options.data)}`);
  return res.write(`${lines.join('\n')}\n\n`);
}

export class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly keepaliveMs: number;
  private readonly store: SqliteEventStore;
  private readonly getSnapshot: () => GatewaySnapshot;

  constructor(options: {
    store: SqliteEventStore;
    getSnapshot: () => GatewaySnapshot;
    keepaliveMs: number;
  }) {
    this.store = options.store;
    this.getSnapshot = options.getSnapshot;
    this.keepaliveMs = Math.max(50, options.keepaliveMs);
  }

  clientCount(): number {
    return this.clients.size;
  }

  handleConnection = (req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const keepaliveTimer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(': keepalive\n\n');
      }
    }, this.keepaliveMs);
    keepaliveTimer.unref();

    const client: SseClient = { res, keepaliveTimer };
    this.clients.add(client);

    const cleanup = () => {
      clearInterval(keepaliveTimer);
      this.clients.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);

    // Send initial snapshot
    writeSseFrame(res, {
      event: 'snapshot',
      data: this.getSnapshot(),
    });

    // Replay missed events if Last-Event-ID / ?lastEventId / ?since is provided
    const headerLastId = req.header('last-event-id');
    const queryLastId =
      typeof req.query.lastEventId === 'string'
        ? req.query.lastEventId
        : typeof req.query.since === 'string'
          ? req.query.since
          : undefined;
    const rawLastId = headerLastId ?? queryLastId;

    if (rawLastId && rawLastId.trim().length > 0) {
      const sinceSeq = this.store.resolveSeqForLastEventId(rawLastId);
      if (sinceSeq !== null) {
        const missedRows = this.store.getEventsSince(sinceSeq, 200);
        for (const row of missedRows) {
          writeSseFrame(res, {
            id: row.event.id,
            event: 'event',
            data: {
              type: 'event',
              payload: row.event,
            },
          });
        }
      }
    }
  };

  broadcastEvent(event: NormalizedEvent, snapshotDelta: SnapshotDelta): void {
    for (const client of this.clients) {
      if (client.res.writableEnded || client.res.destroyed) {
        clearInterval(client.keepaliveTimer);
        this.clients.delete(client);
        continue;
      }
      writeSseFrame(client.res, {
        id: event.id,
        event: 'event',
        data: {
          type: 'event',
          payload: event,
          snapshotDelta,
        },
      });
    }
  }

  close(): void {
    for (const client of this.clients) {
      clearInterval(client.keepaliveTimer);
      try {
        if (!client.res.writableEnded) {
          client.res.end();
        }
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}
