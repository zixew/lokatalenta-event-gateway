# LokaTalenta Event Gateway

Real-time telemetry hub (`PORT=4101`) interconnecting `lms-psikotes`, `lokatalenta-backlog`, `lokatalenta-sprint-planner`, `lokatalenta-docs`, GitHub webhooks, and `lokatalenta-office-3d`.

## Endpoints

- `POST /events` — Ingest normalized ecosystem events (`x-lokatalenta-signature` HMAC-SHA256 or `Authorization: Bearer` when `GATEWAY_EVENT_SECRET` is configured)
- `POST /webhooks/github` — Verify `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` and map `ping`, `push`, `pull_request`, `issues` events
- `WS /ws` — Real-time initial `snapshot` + live `event` fan-out with `snapshotDelta` (Node server mode)
- `GET /events/stream` — Server-Sent Events (SSE) stream + `Last-Event-ID` replay
- `GET /snapshot` — Current 6-division / 24-agent state snapshot + recent events + stats
- `GET /events` — Queryable SQLite WAL event log (`source`, `divisionId`, `agentId`, `type`, `limit`, `sinceSeq`, `since` where `since` accepts numeric `seq`, ISO-8601 timestamp, or known `event.id`)
- `GET /health` — Service healthcheck

## Vercel Serverless Support

- `vercel.json` + `api/index.ts` expose a lazy-initialized Express serverless handler (with `contracts/**` bundled and `WS /ws` disabled cleanly).
- When `VERCEL=1` and `DB_PATH` is unset, SQLite defaults to `/tmp/gateway.db` (safe on read-only serverless filesystems).
- CORS allows `https://*.vercel.app`, `localhost:*`, `127.0.0.1:*`, and any origins in `CORS_ORIGINS` / `CORS_ORIGIN`.

## Repository Layout

- `api/` — Vercel serverless entrypoint (`api/index.ts`)
- `contracts/` — Canonical shared contracts (`divisions.json`, `agents.json`, `event-schema.json`, `ecosystem-ports.json`)
- `src/` — Event Gateway server (`config.ts`, `domain/`, `store/`, `webhooks/`, `ws/`, `sse/`, `routes/`, `server.ts`, `index.ts`)
- `tests/` — Vitest unit & integration test suite using ephemeral `port: 0`

## Commands

```bash
npm install
npm run typecheck
npm run build
npm test
npm run dev    # Port 4101 (or PORT env)
npm start      # Runs dist/index.js
```
