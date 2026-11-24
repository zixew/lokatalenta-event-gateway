import { afterEach, describe, expect, it } from 'vitest';
import {
  makeEventPayload,
  openSseReader,
  startTestGateway,
} from '../helpers/testHarness.js';

describe('SSE /events/stream and Last-Event-ID replay', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('streams initial snapshot, live events, and replays missed events via Last-Event-ID', async () => {
    const ctx = await startTestGateway({ gatewayEventSecret: '' });
    cleanups.push(ctx.cleanup);

    const sse1 = await openSseReader(ctx.sseUrl);
    const snapMsg = await sse1.nextMessage();
    expect(snapMsg.event).toBe('snapshot');

    // Emit event 1 while connected
    const e1 = makeEventPayload({ id: 'evt-sse-1', title: 'First SSE event' });
    await fetch(`${ctx.baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(e1),
    });

    const msg1 = await sse1.nextMessage();
    expect(msg1.event).toBe('event');
    expect(msg1.id).toBe('evt-sse-1');
    sse1.close();

    // Emit burst of 3 events while disconnected
    for (const id of ['evt-sse-2', 'evt-sse-3', 'evt-sse-4']) {
      const res = await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeEventPayload({ id })),
      });
      expect(res.status).toBe(202);
    }

    // Reconnect using Last-Event-ID = evt-sse-1 (by event id)
    const sse2 = await openSseReader(ctx.sseUrl, {
      'Last-Event-ID': 'evt-sse-1',
    });
    const snap2 = await sse2.nextMessage();
    expect(snap2.event).toBe('snapshot');

    const replayedIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await sse2.nextMessage();
      expect(m.event).toBe('event');
      replayedIds.push(m.id ?? '');
    }
    expect(replayedIds).toEqual(['evt-sse-2', 'evt-sse-3', 'evt-sse-4']);
    sse2.close();

    // Also verify numeric seq fallback for Last-Event-ID
    const sse3 = await openSseReader(ctx.sseUrl, {
      'Last-Event-ID': '2',
    });
    await sse3.nextMessage(); // snapshot
    const m3 = await sse3.nextMessage();
    const m4 = await sse3.nextMessage();
    expect([m3.id, m4.id]).toEqual(['evt-sse-3', 'evt-sse-4']);
    sse3.close();
  });
});
