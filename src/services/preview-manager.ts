import puppeteer, { Browser, Page, CDPSession } from 'puppeteer';
import { spawn } from 'child_process';
import { CDP_PORT_START, CDP_PORT_END } from '../config.js';
import { WebSocket } from 'ws';

const CHROME_PATH = '/home/furti/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';
const FFMPEG_PATH = '/usr/bin/ffmpeg';
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL = 60 * 1000; // 60 seconds

export interface PreviewInstance {
  id: string;
  browser: Browser;
  page: Page;
  cdpSession: CDPSession;
  cdpPort: number;
  targetPort: number;
  headerHost?: string;
  protocol: 'http' | 'https';
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
  };
  quality: number;
  screencastActive: boolean;
  wsClients: Set<WebSocket>;
  lastActivity: number;
  recording: boolean;
  recordedFrames: { data: Buffer; timestamp: number }[];
}

export interface CreatePreviewOpts {
  targetPort: number;
  headerHost?: string;
  protocol?: 'http' | 'https';
  width?: number;
  height?: number;
  dpr?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  quality?: number;
}

class PreviewManager {
  private instances = new Map<string, PreviewInstance>();
  private usedPorts = new Set<number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupInactive(), CLEANUP_INTERVAL);
  }

  private allocateCdpPort(): number {
    for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    throw new Error('No available CDP ports');
  }

  private releaseCdpPort(port: number) {
    this.usedPorts.delete(port);
  }

  private makeKey(projectId: string, tabId: string): string {
    return `${projectId}/${tabId}`;
  }

  get(projectId: string, tabId: string): PreviewInstance | undefined {
    return this.instances.get(this.makeKey(projectId, tabId));
  }

  async create(projectId: string, tabId: string, opts: CreatePreviewOpts): Promise<PreviewInstance> {
    const key = this.makeKey(projectId, tabId);

    // Destroy existing if any
    if (this.instances.has(key)) {
      await this.destroy(projectId, tabId);
    }

    const cdpPort = this.allocateCdpPort();
    const width = opts.width || 1920;
    const height = opts.height || 1080;
    const dpr = opts.dpr || 1;
    const isMobile = opts.isMobile || false;
    const hasTouch = opts.hasTouch || false;
    const quality = opts.quality || 80;
    const protocol = opts.protocol || 'http';

    try {
      const chromeArgs = [
        `--remote-debugging-port=${cdpPort}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--ignore-certificate-errors',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ];
      // Map custom hostname to localhost so Chrome can resolve it and all sub-resource links
      // Also map default port (80/443) to the target port so links without explicit port work
      if (opts.headerHost) {
        const defaultPort = protocol === 'https' ? 443 : 80;
        chromeArgs.push(`--host-resolver-rules=MAP ${opts.headerHost}:${defaultPort} 127.0.0.1:${opts.targetPort}, MAP ${opts.headerHost} 127.0.0.1`);
      }

      const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: chromeArgs,
      });

      const page = await browser.newPage();

      await page.setViewport({
        width,
        height,
        deviceScaleFactor: dpr,
        isMobile,
        hasTouch,
      });

      const cdpSession = await page.createCDPSession();

      const instance: PreviewInstance = {
        id: key,
        browser,
        page,
        cdpSession,
        cdpPort,
        targetPort: opts.targetPort,
        headerHost: opts.headerHost,
        protocol,
        viewport: { width, height, deviceScaleFactor: dpr, isMobile, hasTouch },
        quality,
        screencastActive: false,
        wsClients: new Set(),
        lastActivity: Date.now(),
        recording: false,
        recordedFrames: [],
      };

      this.instances.set(key, instance);

      // Listen for URL changes
      cdpSession.on('Page.frameNavigated', (params: any) => {
        if (params.frame?.parentId) return; // Only top-level
        const url = params.frame?.url;
        if (url) {
          const msg = JSON.stringify({ type: 'url_changed', url });
          for (const ws of instance.wsClients) {
            if (ws.readyState === 1) ws.send(msg);
          }
        }
      });

      await cdpSession.send('Page.enable');

      // Navigate to target (retry up to 5 times if the service isn't ready yet)
      // Use custom hostname without port if specified (port mapping handled by --host-resolver-rules)
      const targetUrl = opts.headerHost
        ? `${protocol}://${opts.headerHost}`
        : `${protocol}://localhost:${opts.targetPort}`;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
          break;
        } catch (err: any) {
          console.warn(`[preview] Navigation to ${targetUrl} attempt ${attempt}/5: ${err.message}`);
          if (attempt < 5) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }

      // Start screencast
      await this.startScreencast(instance);

      console.log(`[preview] Created instance ${key} → ${targetUrl} (CDP port ${cdpPort})`);
      return instance;
    } catch (err) {
      this.releaseCdpPort(cdpPort);
      throw err;
    }
  }

  private async startScreencast(instance: PreviewInstance) {
    if (instance.screencastActive) return;

    instance.cdpSession.on('Page.screencastFrame', (frame: any) => {
      instance.cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      instance.lastActivity = Date.now();

      // Send as binary: 0x01 prefix + raw JPEG bytes
      const jpegBuf = Buffer.from(frame.data, 'base64');
      const msg = Buffer.allocUnsafe(1 + jpegBuf.length);
      msg[0] = 0x01; // frame type
      jpegBuf.copy(msg, 1);

      for (const ws of instance.wsClients) {
        if (ws.readyState === 1) {
          ws.send(msg);
        }
      }

      // Buffer for recording
      if (instance.recording) {
        instance.recordedFrames.push({ data: jpegBuf, timestamp: Date.now() });
      }
    });

    await instance.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: instance.quality,
      maxWidth: instance.viewport.width,
      maxHeight: instance.viewport.height,
      everyNthFrame: 1,
    });

    instance.screencastActive = true;
  }

  private async stopScreencast(instance: PreviewInstance) {
    if (!instance.screencastActive) return;
    try {
      await instance.cdpSession.send('Page.stopScreencast');
    } catch {}
    instance.cdpSession.removeAllListeners('Page.screencastFrame');
    instance.screencastActive = false;
  }

  async destroy(projectId: string, tabId: string) {
    const key = this.makeKey(projectId, tabId);
    const instance = this.instances.get(key);
    if (!instance) return;

    await this.stopScreencast(instance);
    try {
      await instance.browser.close();
    } catch {}
    this.releaseCdpPort(instance.cdpPort);
    this.instances.delete(key);

    // Close all WS clients
    for (const ws of instance.wsClients) {
      ws.close(1000, 'Preview instance destroyed');
    }

    console.log(`[preview] Destroyed instance ${key}`);
  }

  async destroyAllForProject(projectId: string) {
    const prefix = `${projectId}/`;
    const keys = Array.from(this.instances.keys()).filter(k => k.startsWith(prefix));
    for (const key of keys) {
      const [pid, tid] = key.split('/');
      await this.destroy(pid, tid);
    }
  }

  async setViewport(projectId: string, tabId: string, viewport: {
    width: number;
    height: number;
    dpr?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;

    const newVp = {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr ?? instance.viewport.deviceScaleFactor,
      isMobile: viewport.isMobile ?? instance.viewport.isMobile,
      hasTouch: viewport.hasTouch ?? instance.viewport.hasTouch,
    };

    // Skip if nothing changed (avoids screencast restart flicker from periodic sync)
    const cur = instance.viewport;
    if (cur.width === newVp.width && cur.height === newVp.height &&
        cur.deviceScaleFactor === newVp.deviceScaleFactor &&
        cur.isMobile === newVp.isMobile && cur.hasTouch === newVp.hasTouch) {
      return;
    }

    await this.stopScreencast(instance);

    instance.viewport = newVp;

    await instance.page.setViewport({
      width: instance.viewport.width,
      height: instance.viewport.height,
      deviceScaleFactor: instance.viewport.deviceScaleFactor,
      isMobile: instance.viewport.isMobile,
      hasTouch: instance.viewport.hasTouch,
    });

    await this.startScreencast(instance);
    instance.lastActivity = Date.now();
  }

  async setQuality(projectId: string, tabId: string, quality: number) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;

    instance.quality = quality;
    await this.stopScreencast(instance);
    await this.startScreencast(instance);
  }

  async navigate(projectId: string, tabId: string, url: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    try {
      await instance.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (err: any) {
      console.warn(`[preview] Navigate warning: ${err.message}`);
    }
    instance.lastActivity = Date.now();
  }

  async dispatchMouseEvent(projectId: string, tabId: string, params: any) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await instance.cdpSession.send('Input.dispatchMouseEvent', params);
    instance.lastActivity = Date.now();
  }

  async dispatchKeyEvent(projectId: string, tabId: string, params: any) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await instance.cdpSession.send('Input.dispatchKeyEvent', params);
    instance.lastActivity = Date.now();
  }

  async insertText(projectId: string, tabId: string, text: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await instance.cdpSession.send('Input.insertText', { text });
    instance.lastActivity = Date.now();
  }

  async dispatchScrollEvent(projectId: string, tabId: string, params: { x: number; y: number; deltaX: number; deltaY: number }) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await instance.cdpSession.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: params.x,
      y: params.y,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
    });
    instance.lastActivity = Date.now();
  }

  async screenshot(projectId: string, tabId: string, fullPage?: boolean): Promise<string> {
    const instance = this.get(projectId, tabId);
    if (!instance) throw new Error('Preview instance not found');
    const data = await instance.page.screenshot({
      fullPage: !!fullPage,
      type: 'png',
      encoding: 'base64',
    }) as string;
    return data;
  }

  startRecording(projectId: string, tabId: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    instance.recording = true;
    instance.recordedFrames = [];
    console.log(`[preview] Recording started for ${this.makeKey(projectId, tabId)}`);
  }

  async stopRecording(projectId: string, tabId: string): Promise<string> {
    const instance = this.get(projectId, tabId);
    if (!instance) throw new Error('Preview instance not found');

    instance.recording = false;
    const frames = instance.recordedFrames;
    instance.recordedFrames = [];

    if (frames.length === 0) {
      throw new Error('No frames recorded');
    }

    console.log(`[preview] Recording stopped for ${this.makeKey(projectId, tabId)}, encoding ${frames.length} frames...`);

    return new Promise<string>((resolve, reject) => {
      const ffmpeg = spawn(FFMPEG_PATH, [
        '-f', 'image2pipe',
        '-framerate', '15',
        '-i', 'pipe:0',
        '-c:v', 'libvpx-vp9',
        '-b:v', '1M',
        '-f', 'webm',
        'pipe:1',
      ]);

      const chunks: Buffer[] = [];
      ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      ffmpeg.stderr.on('data', () => {}); // Suppress stderr

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        const webm = Buffer.concat(chunks);
        resolve(webm.toString('base64'));
      });

      ffmpeg.on('error', reject);

      // Write frames
      for (const frame of frames) {
        ffmpeg.stdin.write(frame.data);
      }
      ffmpeg.stdin.end();
    });
  }

  private cleanupInactive() {
    const now = Date.now();
    for (const [key, instance] of this.instances) {
      if (instance.wsClients.size === 0 && now - instance.lastActivity > INACTIVITY_TIMEOUT) {
        const [projectId, tabId] = key.split('/');
        console.log(`[preview] Cleaning up inactive instance ${key}`);
        this.destroy(projectId, tabId);
      }
    }
  }

  async shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [key] of this.instances) {
      const [projectId, tabId] = key.split('/');
      await this.destroy(projectId, tabId);
    }
  }
}

export const previewManager = new PreviewManager();
