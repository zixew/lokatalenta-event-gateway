import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayServer } from '../../src/server.js';
import {
  makeEventPayload,
  signGatewayBody,
  startTestGateway,
  TEST_EVENT_SECRET,
  type TestGatewayContext,
} from '../helpers/testHarness.js';

describe('Gateway HTTP endpoints', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('serves /health and /snapshot with 24 agents and 6 divisions', async () => {
    const ctx = await startTestGateway();
    cleanups.push(ctx.cleanup);

    const healthRes = await fetch(`${ctx.baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.service).toBe('lokatalenta-event-gateway');
    expect(typeof health.uptime).toBe('number');
    expect(health.wsClients).toBe(0);
    expect(health.sseClients).toBe(0);
    expect(health.eventCount).toBe(0);

    const snapRes = await fetch(`${ctx.baseUrl}/snapshot`);
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      agents: Array<Record<string, unknown>>;
      divisions: Array<Record<string, unknown>>;
      recentEvents: unknown[];
      stats: Record<string, unknown>;
    };
    expect(snap.agents).toHaveLength(24);
    expect(snap.divisions).toHaveLength(6);
    expect(snap.recentEvents).toEqual([]);
    expect(snap.stats.totalEvents).toBe(0);
  });

  it('enforces HMAC/Bearer auth before JSON parsing when GATEWAY_EVENT_SECRET is set', async () => {
    const ctx = await startTestGateway();
    cleanups.push(ctx.cleanup);

    // Missing auth on malformed JSON -> 401 before JSON parse
    const noAuthRes = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json',
    });
    expect(noAuthRes.status).toBe(401);

    // Wrong signature -> 401
    const badSigRes = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-lokatalenta-signature': `sha256=${'0'.repeat(64)}`,
      },
      body: JSON.stringify(makeEventPayload()),
    });
    expect(badSigRes.status).toBe(401);

    // Valid raw hex signature -> 202
    const ev1 = JSON.stringify(makeEventPayload({ id: 'evt-raw-sig-1' }));
    const rawSigRes = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-lokatalenta-signature': signGatewayBody(ev1, TEST_EVENT_SECRET, false),
      },
      body: ev1,
    });
    expect(rawSigRes.status).toBe(202);

    // Valid Bearer token -> 202
    const ev2 = JSON.stringify(makeEventPayload({ id: 'evt-bearer-2' }));
    const bearerRes = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_EVENT_SECRET}`,
      },
      body: ev2,
    });
    expect(bearerRes.status).toBe(202);
  });

  it('validates payloads, deduplicates duplicate id, scrubs PII, and filters GET /events', async () => {
    const ctx: TestGatewayContext = await startTestGateway({
      gatewayEventSecret: '',
    });
    cleanups.push(ctx.cleanup);

    const badJsonRes = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken": ',
    });
    expect(badJsonRes.status).toBe(400);

    const badSchemaRes = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeEventPayload({ agentId: 99 })),
    });
    expect(badSchemaRes.status).toBe(400);

    const piiEvent = makeEventPayload({
      id: 'evt-idemp-pii',
      source: 'lms-psikotes',
      type: 'lms.activity',
      divisionId: 'lounge',
      agentId: 13,
      summary: 'Candidate user@example.com NIK 3174011234560001 phone +6281234567890',
      metadata: {
        email: 'user@example.com',
        password: 'secret',
        courseId: 'course-1',
      },
    });

    const first = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(piiEvent),
    });
    expect(first.status).toBe(202);
    const firstJson = (await first.json()) as { ok: boolean; event: Record<string, unknown> };
    expect(Object.keys(firstJson.event)).toHaveLength(13);
    const serialized = JSON.stringify(firstJson.event);
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('3174011234560001');
    expect(serialized).not.toContain('+6281234567890');
    expect(serialized).not.toContain('"password"');

    const second = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(piiEvent),
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { duplicate?: boolean };
    expect(secondJson.duplicate).toBe(true);

    const listRes = await fetch(
      `${ctx.baseUrl}/events?source=lms-psikotes&divisionId=lounge&agentId=13&limit=10`,
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { events: Array<{ id: string }> };
    expect(listJson.events.filter((e) => e.id === 'evt-idemp-pii')).toHaveLength(1);

    const badQueryRes = await fetch(`${ctx.baseUrl}/events?limit=abc`);
    expect(badQueryRes.status).toBe(400);
  });

  it('hydrates persisted events and snapshot stats from SQLite on restart', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gw-restart-'));
    const dbPath = path.join(tmpDir, 'persist.db');

    const gw1 = createGatewayServer({
      port: 0,
      host: '127.0.0.1',
      dbPath,
      gatewayEventSecret: '',
    });
    await gw1.start();

    const evt = makeEventPayload({
      id: 'evt-persist-1',
      agentId: 7,
      divisionId: 'qa',
      targetZone: 'boardroom',
      targetFloor: 2,
    });
    const postRes = await fetch(`${gw1.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evt),
    });
    expect(postRes.status).toBe(202);
    await gw1.close();

    const gw2 = createGatewayServer({
      port: 0,
      host: '127.0.0.1',
      dbPath,
      gatewayEventSecret: '',
    });
    await gw2.start();
    cleanups.push(async () => {
      await gw2.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const snapRes = await fetch(`${gw2.baseUrl}/snapshot`);
    const snap = (await snapRes.json()) as {
      agents: Array<{ id: number; lastEventId: string | null; currentZone: string }>;
      recentEvents: Array<{ id: string }>;
      stats: { totalEvents: number };
    };
    expect(snap.stats.totalEvents).toBe(1);
    expect(snap.recentEvents.map((e) => e.id)).toContain('evt-persist-1');
    const agent7 = snap.agents.find((a) => a.id === 7);
    expect(agent7?.lastEventId).toBe('evt-persist-1');
    expect(agent7?.currentZone).toBe('boardroom');
  });

  it('allows ecosystem CORS origins (4100..4114) and preflight headers', async () => {
    const ctx = await startTestGateway({ gatewayEventSecret: '' });
    cleanups.push(ctx.cleanup);

    const res = await fetch(`${ctx.baseUrl}/events`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:4100',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers':
          'Content-Type, Authorization, x-lokatalenta-signature, Last-Event-ID, Cache-Control',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4100',
    );
  });
});
