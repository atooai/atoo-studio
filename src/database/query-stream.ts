import type { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { connectionManager } from './connection-manager.js';

const WS_PATH_RE = /^\/ws\/database-query\/([^/?]+)/;
const BATCH_SIZE = 100;
const KEEPALIVE_INTERVAL_MS = 30_000;

export function isDatabaseWsUpgrade(url: string): boolean {
  return WS_PATH_RE.test(url);
}

export function handleDatabaseWsUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const match = (req.url ?? '').match(WS_PATH_RE);
  if (!match) {
    socket.destroy();
    return;
  }

  const connectionId = decodeURIComponent(match[1]);

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
    setupQuerySocket(ws, connectionId);
  });
}

function send(ws: WebSocket, data: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function setupQuerySocket(ws: WebSocket, connectionId: string): void {
  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, KEEPALIVE_INTERVAL_MS);

  ws.on('close', () => {
    clearInterval(keepAlive);
  });

  ws.on('message', async (raw) => {
    let msg: { type?: string; query?: string; limit?: number };

    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type !== 'query' || typeof msg.query !== 'string') {
      send(ws, { type: 'error', message: 'Expected message of type "query" with a "query" string field' });
      return;
    }

    const limit = typeof msg.limit === 'number' && msg.limit > 0 ? msg.limit : undefined;

    try {
      const startTime = performance.now();
      const result = await connectionManager.query(connectionId, msg.query, limit);
      const executionTimeMs = Math.round(performance.now() - startTime);

      // Send column names first
      send(ws, { type: 'columns', columns: result.columns });

      // Send rows in batches
      const rows = result.rows;
      let batchNumber = 0;

      for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
        const batch = rows.slice(offset, offset + BATCH_SIZE);
        send(ws, { type: 'rows', rows: batch, batch: batchNumber });
        batchNumber++;
      }

      // Send completion message
      send(ws, {
        type: 'complete',
        row_count: result.row_count,
        execution_time_ms: executionTimeMs,
        truncated: result.truncated ?? false,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      send(ws, { type: 'error', message });
    }
  });
}
