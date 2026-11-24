import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import handler, {
  getServerlessGateway,
  resetServerlessGatewayForTests,
} from '../../api/index.js';
import { loadConfig } from '../../src/config.js';
import { isAllowedCorsOrigin } from '../../src/server.js';
import { makeEventPayload, openSseReader } from '../helpers/testHarness.js';

describe('Vercel serverless compatibility (api/index.ts, /tmp DB, CORS, ?since)', () => {
  const originalEnv = { ...process.env };
  const extraServers: http.Server[] = [];

  afterEach(async () => {
    resetServerlessGatewayForTests();
    while (extraServers.length > 0) {
      const srv = extraServers.pop()!;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    }
    process.env = { ...originalEnv };
  });

  it('defaults DB_PATH to /tmp/gateway.db when VERCEL=1 and DB_PATH is unset', () => {
    process.env.VERCEL = '1';
    delete process.env.DB_PATH;
    const cfg = loadConfig();
    expect(cfg.dbPath).toBe('/tmp/gateway.db');

    process.env.DB_PATH = '/tmp/custom-gw.db';
    const overridden = loadConfig();
    expect(overridden.dbPath).toBe('/tmp/custom-gw.db');
  });

  it('matches *.vercel.app, localhost:*, 127.0.0.1:*, and CORS_ORIGINS while rejecting untrusted origins', () => {
    expect(isAllowedCorsOrigin('https://lokatalenta-office-3d.vercel.app', '')).toBe(true);
    expect(isAllowedCorsOrigin('https://lokatalenta-docs-git-main.vercel.app', '')).toBe(true);
    expect(isAllowedCorsOrigin('http://localhost:4105', '')).toBe(true);
    expect(isAllowedCorsOrigin('http://127.0.0.1:4100', '')).toBe(true);
    expect(isAllowedCorsOrigin('https://custom.lokatalenta.id', 'https://custom.lokatalenta.id')).toBe(true);
    expect(isAllowedCorsOrigin('https://evil.example.com', '')).toBe(false);
    expect(isAllowedCorsOrigin('https://vercel.app.evil.com', '')).toBe(false);
  });

  it('serves stateless HTTP & SSE via api/index.ts handler without WS and supports GET /events?since=...', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-vercel-'));
    const dbPath = path.join(tmpDir, 'vercel-gw.db');

    process.env.VERCEL = '1';
    process.env.DB_PATH = dbPath;
    process.env.GATEWAY_EVENT_SECRET = '';
    process.env.GITHUB_WEBHOOK_SECRET = 'test-gh-secret';

    // Ensure wsHub is disabled in serverless mode
    const gw = getServerlessGateway();
    expect(gw.wsHub).toBeNull();

    // Serve api/index.ts default handler over an ephemeral HTTP server
    const server = http.createServer(handler);
    extraServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; wsClients: number };
      expect(health.ok).toBe(true);
      expect(health.wsClients).toBe(0);

      // Verify CORS header for *.vercel.app
      const corsRes = await fetch(`${baseUrl}/snapshot`, {
        headers: { Origin: 'https://lokatalenta-office-3d.vercel.app' },
      });
      expect(corsRes.status).toBe(200);
      expect(corsRes.headers.get('access-control-allow-origin')).toBe(
        'https://lokatalenta-office-3d.vercel.app',
      );

      // Post 3 events with distinct timestamps
      const t1 = '2026-11-24T10:00:00.000Z';
      const t2 = '2026-11-24T10:00:05.000Z';
      const t3 = '2026-11-24T10:00:10.000Z';

      for (const [id, ts] of [
        ['evt-v-1', t1],
        ['evt-v-2', t2],
        ['evt-v-3', t3],
      ]) {
        const res = await fetch(`${baseUrl}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(makeEventPayload({ id, timestamp: ts })),
        });
        expect(res.status).toBe(202);
      }

      // ?since=<numeric seq>
      const bySeqRes = await fetch(`${baseUrl}/events?since=1`);
      expect(bySeqRes.status).toBe(200);
      const bySeq = (await bySeqRes.json()) as { events: Array<{ id: string }> };
      expect(bySeq.events.map((e) => e.id)).toEqual(['evt-v-2', 'evt-v-3']);

      // ?since=<event.id>
      const byIdRes = await fetch(`${baseUrl}/events?since=evt-v-2`);
      expect(byIdRes.status).toBe(200);
      const byId = (await byIdRes.json()) as { events: Array<{ id: string }> };
      expect(byId.events.map((e) => e.id)).toEqual(['evt-v-3']);

      // ?since=<ISO timestamp>
      const byIsoRes = await fetch(
        `${baseUrl}/events?since=${encodeURIComponent(t1)}`,
      );
      expect(byIsoRes.status).toBe(200);
      const byIso = (await byIsoRes.json()) as { events: Array<{ id: string }> };
      expect(byIso.events.map((e) => e.id)).toEqual(['evt-v-2', 'evt-v-3']);

      // SSE /events/stream works via serverless handler too
      const sse = await openSseReader(`${baseUrl}/events/stream`, {
        'Last-Event-ID': 'evt-v-1',
      });
      const snap = await sse.nextMessage();
      expect(snap.event).toBe('snapshot');
      const replay1 = await sse.nextMessage();
      const replay2 = await sse.nextMessage();
      expect([replay1.id, replay2.id]).toEqual(['evt-v-2', 'evt-v-3']);
      sse.close();
    } finally {
      resetServerlessGatewayForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
