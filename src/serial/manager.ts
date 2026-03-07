import { WebSocket } from 'ws';
import { createPtyPair, PtyPair } from './pty-pair.js';
import { store } from '../state/store.js';

export interface SerialRequestParams {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
  description?: string;
}

export interface SerialRequest {
  requestId: string;
  params: SerialRequestParams;
  ptyPair: PtyPair;
  status: 'pending' | 'connected' | 'closed';
  browserWs: WebSocket | null;
  resolveReady: ((slavePath: string) => void) | null;
  rejectReady: ((err: Error) => void) | null;
  modemPollInterval: NodeJS.Timeout | null;
  readPollInterval: NodeJS.Timeout | null;
  lastModemBits: { dtr: boolean; rts: boolean };
}

class SerialManager {
  private requests = new Map<string, SerialRequest>();

  createRequest(requestId: string, params: SerialRequestParams): { slavePath: string; readyPromise: Promise<string> } {
    const ptyPair = createPtyPair();
    console.log(`[serial] Created PTY pair: master=${ptyPair.masterFd}, slave=${ptyPair.slavePath}`);

    let resolveReady: ((path: string) => void) | null = null;
    let rejectReady: ((err: Error) => void) | null = null;

    const readyPromise = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const request: SerialRequest = {
      requestId,
      params,
      ptyPair,
      status: 'pending',
      browserWs: null,
      resolveReady,
      rejectReady,
      modemPollInterval: null,
      readPollInterval: null,
      lastModemBits: { dtr: false, rts: false },
    };

    this.requests.set(requestId, request);
    return { slavePath: ptyPair.slavePath, readyPromise };
  }

  getRequest(requestId: string): SerialRequest | undefined {
    return this.requests.get(requestId);
  }

  connectBrowser(requestId: string, ws: WebSocket): boolean {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return false;

    req.browserWs = ws;
    req.status = 'connected';

    // Start piping PTY master reads → browser (poll every 5ms for low latency)
    req.readPollInterval = setInterval(() => {
      if (req.ptyPair.closed || ws.readyState !== WebSocket.OPEN) {
        this.closeRequest(requestId);
        return;
      }
      const data = req.ptyPair.read();
      if (data) {
        ws.send(data);
      }
    }, 5);

    // Start modem bit polling (every 50ms)
    req.modemPollInterval = setInterval(() => {
      if (req.ptyPair.closed || ws.readyState !== WebSocket.OPEN) return;
      const bits = req.ptyPair.getModemBits();
      if (bits.dtr !== req.lastModemBits.dtr || bits.rts !== req.lastModemBits.rts) {
        req.lastModemBits = { ...bits };
        ws.send(JSON.stringify({ type: 'set_signals', signals: { dtr: bits.dtr, rts: bits.rts } }));
      }
    }, 50);

    // Resolve the ready promise so the MCP tool gets the PTY path
    req.resolveReady?.(req.ptyPair.slavePath);
    req.resolveReady = null;
    req.rejectReady = null;

    console.log(`[serial] Browser connected for request ${requestId}, slave=${req.ptyPair.slavePath}`);
    return true;
  }

  handleBrowserData(requestId: string, data: Buffer): void {
    const req = this.requests.get(requestId);
    if (!req || req.ptyPair.closed) return;
    req.ptyPair.write(data);
  }

  handleBrowserControl(requestId: string, msg: any): void {
    const req = this.requests.get(requestId);
    if (!req) return;

    if (msg.type === 'ready') {
      // Browser has opened the serial port - handled in connectBrowser
    } else if (msg.type === 'error' || msg.type === 'closed') {
      console.log(`[serial] Browser reported ${msg.type} for ${requestId}: ${msg.message || ''}`);
      this.closeRequest(requestId);
    }
  }

  rejectRequest(requestId: string, err: Error): void {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.rejectReady?.(err);
    this.closeRequest(requestId);
  }

  closeRequest(requestId: string): void {
    const req = this.requests.get(requestId);
    if (!req) return;

    console.log(`[serial] Closing request ${requestId}`);

    if (req.readPollInterval) clearInterval(req.readPollInterval);
    if (req.modemPollInterval) clearInterval(req.modemPollInterval);

    if (!req.ptyPair.closed) req.ptyPair.close();

    if (req.browserWs && req.browserWs.readyState === WebSocket.OPEN) {
      try { req.browserWs.send(JSON.stringify({ type: 'close' })); } catch {}
      try { req.browserWs.close(); } catch {}
    }

    // Reject if still pending
    req.rejectReady?.(new Error('Serial request closed'));

    req.status = 'closed';
    this.requests.delete(requestId);

    // Broadcast serial_closed to all browsers
    const msg = JSON.stringify({ type: 'serial_closed', requestId });
    for (const ws of store.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  getActiveRequests(): Array<{ requestId: string; slavePath: string; status: string }> {
    return Array.from(this.requests.values()).map(r => ({
      requestId: r.requestId,
      slavePath: r.ptyPair.slavePath,
      status: r.status,
    }));
  }
}

export const serialManager = new SerialManager();
