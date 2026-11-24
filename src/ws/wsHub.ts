import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { GatewaySnapshot, NormalizedEvent, SnapshotDelta } from '../domain/types.js';

interface AliveWebSocket extends WebSocket {
  isAlive?: boolean;
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<AliveWebSocket>();
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(options: {
    httpServer: http.Server;
    getSnapshot: () => GatewaySnapshot;
    heartbeatMs: number;
  }) {
    this.wss = new WebSocketServer({ noServer: true });

    options.httpServer.on('upgrade', (req, socket: Duplex, head) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/ws') {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      } catch {
        socket.destroy();
      }
    });

    this.wss.on('connection', (rawWs) => {
      const ws = rawWs as AliveWebSocket;
      ws.isAlive = true;
      this.clients.add(ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      const cleanup = () => {
        this.clients.delete(ws);
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);

      try {
        const snapshotMsg = JSON.stringify({
          type: 'snapshot',
          payload: options.getSnapshot(),
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(snapshotMsg);
        }
      } catch {
        // ignore closed-before-send socket
      }
    });

    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          this.clients.delete(ws);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, Math.max(50, options.heartbeatMs));
    this.heartbeatTimer.unref();
  }

  clientCount(): number {
    return this.clients.size;
  }

  broadcastEvent(event: NormalizedEvent, snapshotDelta: SnapshotDelta): void {
    if (this.clients.size === 0) return;
    const msg = JSON.stringify({
      type: 'event',
      payload: event,
      snapshotDelta,
    });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  close(): Promise<void> {
    clearInterval(this.heartbeatTimer);
    for (const ws of this.clients) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
