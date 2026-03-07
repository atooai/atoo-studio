import { WebSocket } from 'ws';
import { createPtyPair, PtyPair } from './pty-pair.js';
import { createCuseDevice, isCuseAvailable, CuseDevice } from './cuse-device.js';
import { store } from '../state/store.js';

export type SerialDevice = PtyPair | CuseDevice;

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
  device: SerialDevice;
  devicePath: string;
  controlSignalsSupported: boolean;
  status: 'pending' | 'connected' | 'closed';
  browserWs: WebSocket | null;
  resolveReady: ((result: { devicePath: string; controlSignalsSupported: boolean }) => void) | null;
  rejectReady: ((err: Error) => void) | null;
  modemPollInterval: NodeJS.Timeout | null;
  readPollInterval: NodeJS.Timeout | null;
  lastModemBits: { dtr: boolean; rts: boolean };
}

class SerialManager {
  private requests = new Map<string, SerialRequest>();
  private cuseAvailable: boolean | null = null;

  private checkCuseAvailable(): boolean {
    if (this.cuseAvailable === null) {
      this.cuseAvailable = isCuseAvailable();
      if (this.cuseAvailable) {
        console.log('[serial] CUSE available — using virtual serial device with control signal support');
      } else {
        console.log('[serial] CUSE not available — falling back to PTY (no control signal support)');
      }
    }
    return this.cuseAvailable;
  }

  async createRequest(requestId: string, params: SerialRequestParams): Promise<{ devicePath: string; controlSignalsSupported: boolean; readyPromise: Promise<{ devicePath: string; controlSignalsSupported: boolean }> }> {
    let device: SerialDevice;
    let devicePath: string;
    let controlSignalsSupported: boolean;

    if (this.checkCuseAvailable()) {
      try {
        const cuse = await createCuseDevice();
        device = cuse;
        devicePath = cuse.devicePath;
        controlSignalsSupported = true;
        console.log(`[serial] Created CUSE device: ${devicePath}`);
      } catch (err: any) {
        console.log(`[serial] CUSE failed (${err.message}), falling back to PTY`);
        this.cuseAvailable = false;
        const pty = createPtyPair();
        device = pty;
        devicePath = pty.slavePath;
        controlSignalsSupported = false;
        console.log(`[serial] Created PTY pair: master=${pty.masterFd}, slave=${pty.slavePath}`);
      }
    } else {
      const pty = createPtyPair();
      device = pty;
      devicePath = pty.slavePath;
      controlSignalsSupported = false;
      console.log(`[serial] Created PTY pair: master=${pty.masterFd}, slave=${pty.slavePath}`);
    }

    let resolveReady: SerialRequest['resolveReady'] = null;
    let rejectReady: SerialRequest['rejectReady'] = null;

    const readyPromise = new Promise<{ devicePath: string; controlSignalsSupported: boolean }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const request: SerialRequest = {
      requestId,
      params,
      device,
      devicePath,
      controlSignalsSupported,
      status: 'pending',
      browserWs: null,
      resolveReady,
      rejectReady,
      modemPollInterval: null,
      readPollInterval: null,
      lastModemBits: { dtr: false, rts: false },
    };

    this.requests.set(requestId, request);
    return { devicePath, controlSignalsSupported, readyPromise };
  }

  getRequest(requestId: string): SerialRequest | undefined {
    return this.requests.get(requestId);
  }

  connectBrowser(requestId: string, ws: WebSocket): boolean {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return false;

    req.browserWs = ws;
    req.status = 'connected';

    // Start piping device reads → browser (poll every 5ms for low latency)
    req.readPollInterval = setInterval(() => {
      if (req.device.closed || ws.readyState !== WebSocket.OPEN) {
        this.closeRequest(requestId);
        return;
      }
      const data = req.device.read();
      if (data) {
        ws.send(data);
      }
    }, 5);

    // Start modem bit polling (every 50ms)
    req.modemPollInterval = setInterval(() => {
      if (req.device.closed || ws.readyState !== WebSocket.OPEN) return;
      const bits = req.device.getModemBits();
      if (bits.dtr !== req.lastModemBits.dtr || bits.rts !== req.lastModemBits.rts) {
        req.lastModemBits = { ...bits };
        ws.send(JSON.stringify({ type: 'set_signals', signals: { dtr: bits.dtr, rts: bits.rts } }));
      }
    }, 50);

    // Resolve the ready promise
    req.resolveReady?.({ devicePath: req.devicePath, controlSignalsSupported: req.controlSignalsSupported });
    req.resolveReady = null;
    req.rejectReady = null;

    console.log(`[serial] Browser connected for request ${requestId}, device=${req.devicePath}, controlSignals=${req.controlSignalsSupported}`);
    return true;
  }

  handleBrowserData(requestId: string, data: Buffer): void {
    const req = this.requests.get(requestId);
    if (!req || req.device.closed) return;
    req.device.write(data);
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

    if (!req.device.closed) req.device.close();

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

  getActiveRequests(): Array<{ requestId: string; devicePath: string; status: string; controlSignalsSupported: boolean }> {
    return Array.from(this.requests.values()).map(r => ({
      requestId: r.requestId,
      devicePath: r.devicePath,
      status: r.status,
      controlSignalsSupported: r.controlSignalsSupported,
    }));
  }
}

export const serialManager = new SerialManager();
