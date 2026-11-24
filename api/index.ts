import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGatewayServer, type GatewayServer } from '../src/server.js';

let cachedGateway: GatewayServer | null = null;

export function getServerlessGateway(): GatewayServer {
  if (!cachedGateway) {
    cachedGateway = createGatewayServer({
      enableWs: false,
    });
  }
  return cachedGateway;
}

export function resetServerlessGatewayForTests(): void {
  if (cachedGateway) {
    void cachedGateway.close();
    cachedGateway = null;
  }
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const gateway = getServerlessGateway();
  gateway.app(req, res);
}
