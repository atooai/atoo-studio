export interface SerialBridgeOptions {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
}

export class SerialBridge {
  private port: SerialPort | null = null;
  private ws: WebSocket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private running = false;

  async connect(requestId: string, options: SerialBridgeOptions): Promise<void> {
    // Request serial port (requires user gesture — caller must ensure this runs in a click handler)
    this.port = await navigator.serial.requestPort();
    await this.port.open({
      baudRate: options.baudRate,
      dataBits: options.dataBits as 7 | 8,
      stopBits: options.stopBits as 1 | 2,
      parity: options.parity,
    });

    // Connect WebSocket to server
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws/serial/${requestId}`);
    this.ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error('WebSocket connection failed'));
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000);
    });

    this.running = true;

    // Set up serial → WebSocket (read loop)
    this.reader = this.port.readable!.getReader();
    this.readLoop();

    // Set up WebSocket → serial
    this.writer = this.port.writable!.getWriter();
    this.ws.onmessage = async (e) => {
      if (e.data instanceof ArrayBuffer) {
        // Binary: serial data from server PTY
        try {
          await this.writer!.write(new Uint8Array(e.data));
        } catch (err) {
          console.error('[serial-bridge] Write to serial failed:', err);
          this.disconnect();
        }
      } else {
        // Text: control message from server
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'set_signals' && msg.signals) {
            console.log('[serial-bridge] setSignals:', msg.signals);
            // Map short names to Web Serial API's SerialOutputSignals
            await this.port!.setSignals({
              dataTerminalReady: msg.signals.dtr,
              requestToSend: msg.signals.rts,
            });
            console.log('[serial-bridge] setSignals done');
          } else if (msg.type === 'close') {
            this.disconnect();
          }
        } catch {}
      }
    };

    this.ws.onclose = () => {
      this.running = false;
    };

    // Signal ready to server, including USB device info if available
    const portInfo = this.port.getInfo?.() as { usbVendorId?: number; usbProductId?: number } | undefined;
    this.ws.send(JSON.stringify({
      type: 'ready',
      usbVendorId: portInfo?.usbVendorId ?? null,
      usbProductId: portInfo?.usbProductId ?? null,
    }));
  }

  private async readLoop() {
    try {
      while (this.running) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        if (value && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(value);
        }
      }
    } catch (err) {
      if (this.running) {
        console.error('[serial-bridge] Read from serial failed:', err);
        try {
          this.ws?.send(JSON.stringify({ type: 'error', message: String(err) }));
        } catch {}
      }
    }
  }

  async disconnect() {
    this.running = false;
    try { this.reader?.cancel(); } catch {}
    try { this.writer?.close(); } catch {}
    try { await this.port?.close(); } catch {}
    try { this.ws?.close(); } catch {}
    this.port = null;
    this.ws = null;
    this.reader = null;
    this.writer = null;
  }

  get isConnected(): boolean {
    return this.running && this.ws?.readyState === WebSocket.OPEN;
  }
}
