import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { store } from '../state/store.js';

// Handles /v1/sessions/ws/{sessionId}/subscribe — browser WebSocket connection (JSON)

const SUBSCRIBE_PATH_RE = /^\/v1\/sessions\/ws\/([^/?]+)\/subscribe/;

export function isSubscribeUpgrade(url: string): boolean {
  return SUBSCRIBE_PATH_RE.test(url);
}

export function handleSubscribeUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const match = req.url?.match(SUBSCRIBE_PATH_RE);
  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  console.log(`[subscribe-ws] Browser connecting for session ${sessionId}`);

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Register subscriber
    if (!store.subscribeClients.has(sessionId)) {
      store.subscribeClients.set(sessionId, new Set());
    }
    store.subscribeClients.get(sessionId)!.add(ws);
    console.log(`[subscribe-ws] Browser connected for session ${sessionId}`);

    // Send existing events for replay
    const session = store.sessions.get(sessionId);
    if (session) {
      for (const event of session.events) {
        ws.send(JSON.stringify(event));
      }
    }

    // Handle messages from browser (control responses + control requests)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'control_response') {
          console.log(`[subscribe-ws] Control response from browser for session ${sessionId}`);
          store.forwardToIngress(sessionId, msg);
        } else if (msg.type === 'control_request') {
          console.log(`[subscribe-ws] Control request from browser: ${msg.request?.subtype} for session ${sessionId}`);
          store.forwardToIngress(sessionId, msg);
        } else {
          console.log(`[subscribe-ws] Message from browser: ${msg.type}`);
        }
      } catch (err) {
        console.error(`[subscribe-ws] Failed to parse browser message`);
      }
    });

    ws.on('close', () => {
      console.log(`[subscribe-ws] Browser disconnected for session ${sessionId}`);
      store.subscribeClients.get(sessionId)?.delete(ws);
    });

    ws.on('error', (err) => {
      console.error(`[subscribe-ws] Error for session ${sessionId}:`, err.message);
    });
  });
}
