import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GatewayConfig } from '../../src/config.js';
import { createGatewayServer, type GatewayServer } from '../../src/server.js';

export const TEST_EVENT_SECRET = 'lokatalenta-test-event-secret';
export const TEST_WEBHOOK_SECRET = 'lokatalenta-test-webhook-secret';

export interface TestGatewayContext {
  gateway: GatewayServer;
  baseUrl: string;
  wsUrl: string;
  sseUrl: string;
  dbPath: string;
  tmpDir: string;
  cleanup: () => Promise<void>;
}

export async function startTestGateway(
  overrides: Partial<GatewayConfig> = {},
): Promise<TestGatewayContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gw-test-'));
  const dbPath = overrides.dbPath ?? path.join(tmpDir, 'events.db');

  const gateway = createGatewayServer({
    port: 0,
    host: '127.0.0.1',
    dbPath,
    gatewayEventSecret:
      overrides.gatewayEventSecret !== undefined
        ? overrides.gatewayEventSecret
        : TEST_EVENT_SECRET,
    githubWebhookSecret:
      overrides.githubWebhookSecret !== undefined
        ? overrides.githubWebhookSecret
        : TEST_WEBHOOK_SECRET,
    wsHeartbeatMs: overrides.wsHeartbeatMs ?? 5000,
    sseKeepaliveMs: overrides.sseKeepaliveMs ?? 5000,
    ...overrides,
  });

  await gateway.start();

  return {
    gateway,
    baseUrl: gateway.baseUrl,
    wsUrl: gateway.wsUrl,
    sseUrl: gateway.sseUrl,
    dbPath,
    tmpDir,
    cleanup: async () => {
      await gateway.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

export function signGatewayBody(
  rawBody: string | Buffer,
  secret = TEST_EVENT_SECRET,
  withPrefix = true,
): string {
  const hex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return withPrefix ? `sha256=${hex}` : hex;
}

export function signGitHubBody(
  rawBody: string | Buffer,
  secret = TEST_WEBHOOK_SECRET,
): string {
  const hex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return `sha256=${hex}`;
}

export function makeEventPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `evt-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    source: 'backlog',
    type: 'backlog.updated',
    divisionId: 'engineering',
    agentId: 5,
    entityId: 'BL-101',
    title: 'Updated backlog item BL-101',
    summary: 'Farel Faza Nugraha moved BL-101 to ready for sprint.',
    targetZone: 'workspace',
    targetFloor: 2,
    severity: 'info',
    metadata: { storyPoints: 3 },
    ...overrides,
  };
}

export interface ParsedSseMessage {
  id?: string;
  event: string;
  data: unknown;
  rawData: string;
}

export async function openSseReader(
  sseUrl: string,
  headers: Record<string, string> = {},
): Promise<{
  nextMessage: (timeoutMs?: number) => Promise<ParsedSseMessage>;
  close: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(sseUrl, {
    headers: {
      Accept: 'text/event-stream',
      ...headers,
    },
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE failed with status ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: ParsedSseMessage[] = [];

  async function pumpOnce(): Promise<boolean> {
    const { value, done } = await reader.read();
    if (done) return false;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      if (!block.trim()) continue;
      let eventName = 'message';
      let id: string | undefined;
      const dataLines: string[] = [];

      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim();
        } else if (line.startsWith('id:')) {
          id = line.slice('id:'.length).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart());
        }
      }
      if (dataLines.length === 0) continue;
      const rawData = dataLines.join('\n');
      let parsed: unknown = rawData;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        // leave raw
      }
      queue.push({
        ...(id !== undefined ? { id } : {}),
        event: eventName,
        data: parsed,
        rawData,
      });
    }
    return true;
  }

  return {
    nextMessage: async (timeoutMs = 5000): Promise<ParsedSseMessage> => {
      const deadline = Date.now() + timeoutMs;
      while (queue.length === 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error('Timed out waiting for SSE message');
        }
        const ok = await Promise.race([
          pumpOnce(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Timed out waiting for SSE chunk')),
              remaining,
            ),
          ),
        ]);
        if (!ok && queue.length === 0) {
          throw new Error('SSE stream ended unexpectedly');
        }
      }
      return queue.shift()!;
    },
    close: () => {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    },
  };
}
