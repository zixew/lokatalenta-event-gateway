import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openSseReader,
  signGitHubBody,
  startTestGateway,
  TEST_WEBHOOK_SECRET,
} from '../helpers/testHarness.js';

describe('POST /webhooks/github integration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('rejects missing/wrong/malformed X-Hub-Signature-256 with 401 and signed invalid JSON with 400', async () => {
    const ctx = await startTestGateway();
    cleanups.push(ctx.cleanup);

    const body = JSON.stringify({ zen: 'hi' });

    const missingSig = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping' },
      body,
    });
    expect(missingSig.status).toBe(401);

    const wrongSig = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': signGitHubBody(body, 'wrong-secret'),
      },
      body,
    });
    expect(wrongSig.status).toBe(401);

    const malformedSig = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': 'sha256=not-hex',
      },
      body: '{invalid-json',
    });
    expect(malformedSig.status).toBe(401);

    const signedBadJson = '{invalid-json';
    const badJsonRes = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signGitHubBody(signedBadJson, TEST_WEBHOOK_SECRET),
      },
      body: signedBadJson,
    });
    expect(badJsonRes.status).toBe(400);

    const missingRepoBody = JSON.stringify({ commits: [] });
    const missingRepoRes = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signGitHubBody(missingRepoBody, TEST_WEBHOOK_SECRET),
      },
      body: missingRepoBody,
    });
    expect(missingRepoRes.status).toBe(400);
  });

  it('ingests signed ping, push, pull_request, and issues and fans out to WS + SSE', async () => {
    const ctx = await startTestGateway();
    cleanups.push(ctx.cleanup);

    const ws = new WebSocket(ctx.wsUrl);
    const wsEvents: Array<{ type: string; payload: { id: string; type: string } }> = [];
    await new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed.type === 'snapshot') {
          resolve();
        } else if (parsed.type === 'event') {
          wsEvents.push(parsed);
        }
      });
    });

    const sse = await openSseReader(ctx.sseUrl);
    await sse.nextMessage(); // snapshot

    // 1. Ping
    const pingBody = JSON.stringify({ zen: 'Design for failure.' });
    const pingRes = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': signGitHubBody(pingBody),
      },
      body: pingBody,
    });
    expect(pingRes.status).toBe(200);

    // 2. Push
    const pushBody = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { name: 'lokatalenta', full_name: 'zixew/lokatalenta' },
      pusher: { name: 'Farel Faza Nugraha', email: 'farel.secret@example.com' },
      commits: [
        {
          id: '11223344556677889900aabbccddeeff00112233',
          message: 'feat: wire telemetry',
          author: { name: 'Farel Faza Nugraha', username: 'farel' },
        },
      ],
    });
    const pushRes = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'gh-deliv-push-1',
        'X-Hub-Signature-256': signGitHubBody(pushBody),
      },
      body: pushBody,
    });
    expect(pushRes.status).toBe(202);
    const pushJson = (await pushRes.json()) as { event: Record<string, unknown> };
    expect(JSON.stringify(pushJson.event)).not.toContain('farel.secret@example.com');

    const ssePush = await sse.nextMessage();
    expect(ssePush.event).toBe('event');
    expect((ssePush.data as { payload: { type: string } }).payload.type).toBe(
      'github.commit',
    );

    // 3. Pull Request merged
    const prBody = JSON.stringify({
      action: 'closed',
      repository: {
        name: 'lokatalenta-event-gateway',
        full_name: 'zixew/lokatalenta-event-gateway',
      },
      pull_request: {
        number: 7,
        title: 'Add gateway tests',
        merged: true,
        user: { login: 'rizco' },
      },
    });
    const prRes = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'gh-deliv-pr-7',
        'X-Hub-Signature-256': signGitHubBody(prBody),
      },
      body: prBody,
    });
    expect(prRes.status).toBe(202);
    const ssePr = await sse.nextMessage();
    expect((ssePr.data as { payload: { type: string } }).payload.type).toBe(
      'github.pr',
    );

    // 4. Issues opened
    const issueBody = JSON.stringify({
      action: 'opened',
      repository: { name: 'lokatalenta-office-3d', full_name: 'zixew/lokatalenta-office-3d' },
      issue: {
        number: 15,
        title: 'Check QA floor lighting',
        labels: [{ name: 'qa' }],
        user: { login: 'qonita' },
      },
    });
    const issueRes = await fetch(`${ctx.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': 'gh-deliv-issue-15',
        'X-Hub-Signature-256': signGitHubBody(issueBody),
      },
      body: issueBody,
    });
    expect(issueRes.status).toBe(202);
    const sseIssue = await sse.nextMessage();
    expect((sseIssue.data as { payload: { type: string } }).payload.type).toBe(
      'github.issue',
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(wsEvents.map((e) => e.payload.type)).toEqual([
      'github.commit',
      'github.pr',
      'github.issue',
    ]);

    sse.close();
    ws.close();
  });
});
