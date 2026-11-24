import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeEventPayload,
  startTestGateway,
} from '../helpers/testHarness.js';

describe('WebSocket /ws hub', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('sends initial snapshot, broadcasts accepted events once, and skips duplicate id', async () => {
    const ctx = await startTestGateway({ gatewayEventSecret: '' });
    cleanups.push(ctx.cleanup);

    const ws = new WebSocket(ctx.wsUrl);
    const messages: Array<{ type: string; payload: unknown; snapshotDelta?: unknown }> = [];

    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', (raw) => {
        messages.push(JSON.parse(raw.toString('utf8')));
        if (messages.length === 1) resolve();
      });
    });

    expect(messages[0].type).toBe('snapshot');
    const snap = messages[0].payload as { agents: unknown[]; divisions: unknown[] };
    expect(snap.agents).toHaveLength(24);
    expect(snap.divisions).toHaveLength(6);

    const evt = makeEventPayload({ id: 'evt-ws-unique-1', agentId: 6 });

    const eventWait = new Promise<void>((resolve) => {
      const handler = () => {
        if (messages.length >= 2) {
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
    });

    const r1 = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evt),
    });
    expect(r1.status).toBe(202);
    await eventWait;

    // Duplicate POST should NOT trigger another WS broadcast
    const r2 = await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evt),
    });
    expect(r2.status).toBe(200);

    await new Promise((r) => setTimeout(r, 80));
    expect(messages).toHaveLength(2);
    expect(messages[1].type).toBe('event');
    expect((messages[1].payload as { id: string }).id).toBe('evt-ws-unique-1');
    expect(messages[1].snapshotDelta).toBeDefined();

    ws.close();
  });

  it('terminates unresponsive clients when heartbeat pong is missed', async () => {
    const ctx = await startTestGateway({
      gatewayEventSecret: '',
      wsHeartbeatMs: 60,
    });
    cleanups.push(ctx.cleanup);

    const ws = new WebSocket(ctx.wsUrl, { autoPong: false } as WebSocket.ClientOptions);
    // Disable pong reply on ws if autoPong option isn't respected by overriding pong
    ws.pong = () => {};

    await new Promise<void>((resolve) => ws.once('open', resolve));
    const closedPromise = new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });

    // Wait up to 2s for heartbeat termination (2 * 60ms)
    await Promise.race([
      closedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Expected dead WS client to be terminated')), 2000),
      ),
    ]);
  });
});
