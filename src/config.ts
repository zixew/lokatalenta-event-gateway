import { loadContracts } from './domain/contracts.js';

export interface GatewayConfig {
  port: number;
  host: string;
  dbPath: string;
  gatewayEventSecret: string;
  githubWebhookSecret: string;
  corsOrigin: string;
  recentEventsLimit: number;
  wsHeartbeatMs: number;
  sseKeepaliveMs: number;
  enableWs: boolean;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  options: { allowZero?: boolean; max?: number; name: string },
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid integer for ${options.name}: ${raw}`);
  }
  const value = Number(raw.trim());
  const min = options.allowZero ? 0 : 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${options.name} out of range (${min}..${max}): ${value}`);
  }
  return value;
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  if (process.env.NODE_ENV !== 'test') {
    try {
      const loader = (process as { loadEnvFile?: () => void }).loadEnvFile;
      loader?.();
    } catch {
      // Optional .env file may not exist
    }
  }

  const contracts = loadContracts();
  const avoidedPorts = new Set(contracts.ecosystemPorts.avoidedHostPorts);

  const port =
    overrides.port !== undefined
      ? overrides.port
      : parsePositiveInt(process.env.PORT, 4101, {
          allowZero: true,
          max: 65535,
          name: 'PORT',
        });

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${String(port)}`);
  }

  if (port !== 0 && avoidedPorts.has(port)) {
    throw new Error(
      `Configured PORT ${port} is in ecosystem avoidedHostPorts (${[...avoidedPorts].join(', ')})`,
    );
  }

  const explicitDbPath = process.env.DB_PATH?.trim();
  const defaultDbPath =
    process.env.VERCEL === '1' ? '/tmp/gateway.db' : './data/gateway-events.db';

  const mergedCorsOrigin = [
    process.env.CORS_ORIGINS ?? '',
    process.env.CORS_ORIGIN ?? '',
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');

  return {
    port,
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    dbPath: overrides.dbPath ?? (explicitDbPath || defaultDbPath),
    gatewayEventSecret:
      overrides.gatewayEventSecret ?? (process.env.GATEWAY_EVENT_SECRET ?? '').trim(),
    githubWebhookSecret:
      overrides.githubWebhookSecret ??
      (process.env.GITHUB_WEBHOOK_SECRET ?? '').trim(),
    corsOrigin: overrides.corsOrigin ?? mergedCorsOrigin,
    recentEventsLimit:
      overrides.recentEventsLimit ??
      parsePositiveInt(process.env.RECENT_EVENTS_LIMIT, 50, {
        max: 500,
        name: 'RECENT_EVENTS_LIMIT',
      }),
    wsHeartbeatMs:
      overrides.wsHeartbeatMs ??
      parsePositiveInt(process.env.WS_HEARTBEAT_MS, 30_000, {
        max: 600_000,
        name: 'WS_HEARTBEAT_MS',
      }),
    sseKeepaliveMs:
      overrides.sseKeepaliveMs ??
      parsePositiveInt(process.env.SSE_KEEPALIVE_MS, 20_000, {
        max: 600_000,
        name: 'SSE_KEEPALIVE_MS',
      }),
    enableWs: overrides.enableWs ?? true,
  };
}
