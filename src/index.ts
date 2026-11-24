import { createGatewayServer } from './server.js';

const gateway = createGatewayServer();

gateway
  .start()
  .then((port) => {
    console.log(
      `[lokatalenta-event-gateway] listening on http://${gateway.config.host}:${port} (db: ${gateway.config.dbPath})`,
    );
  })
  .catch((err) => {
    console.error('[lokatalenta-event-gateway] failed to start:', err);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lokatalenta-event-gateway] received ${signal}, shutting down...`);
  try {
    await gateway.close();
    process.exit(0);
  } catch (err) {
    console.error('[lokatalenta-event-gateway] shutdown error:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
