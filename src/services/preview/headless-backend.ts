import puppeteer, { Browser, Page, CDPSession } from 'puppeteer';
import { spawn, execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { CDP_PORT_START, CDP_PORT_END } from '../../config.js';
import {
  PreviewBackend,
  PreviewInstanceBase,
  CreatePreviewOpts,
  PendingDialog,
  broadcastJson,
  broadcastBinary,
} from './preview-backend.js';
import { getInjectedScript } from './injected-scripts.js';
import { buildUniversalSetterExpression } from './universal-setter.js';

const CHROME_PATH = '/home/furti/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';
const FFMPEG_PATH = '/usr/bin/ffmpeg';
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'atoo-studio-downloads');

export interface HeadlessInstance extends PreviewInstanceBase {
  browser: Browser;
  page: Page;
  cdpSession: CDPSession;
  browserCdpSession: CDPSession;
  cdpPort: number;
  screencastActive: boolean;
  pendingAuthRequests: Map<string, { requestId: string; timeout: ReturnType<typeof setTimeout> }>;
}

export class HeadlessBackend implements PreviewBackend {
  readonly mode = 'headless' as const;
  private usedPorts = new Set<number>();

  cleanupOrphans() {
    for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
      try {
        const result = execSync(
          `lsof -ti tcp:${port} -s tcp:listen 2>/dev/null || true`,
          { encoding: 'utf-8' },
        ).trim();
        if (result) {
          for (const pid of result.split('\n').filter(Boolean)) {
            console.log(`[preview/headless] Killing orphaned process on CDP port ${port} (PID ${pid})`);
            try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch {}
          }
        }
      } catch {}
    }
  }

  private async allocateCdpPort(): Promise<number> {
    for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
      if (!this.usedPorts.has(port) && await this.isPortFree(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    throw new Error('No available CDP ports');
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(() => resolve(true)); });
      server.listen(port, '127.0.0.1');
    });
  }

  private releaseCdpPort(port: number) {
    this.usedPorts.delete(port);
  }

  // --- Screencast ---

  private async startScreencast(instance: HeadlessInstance) {
    if (instance.screencastActive) return;

    instance.cdpSession.removeAllListeners('Page.screencastFrame');

    const usePng = instance.quality >= 100;

    instance.cdpSession.on('Page.screencastFrame', (frame: any) => {
      instance.cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      instance.lastActivity = Date.now();
      instance.lastFrameTime = Date.now();
      instance.lastStreamRestart = 0; // reset backoff on successful frame

      const imgBuf = Buffer.from(frame.data, 'base64');
      const msg = Buffer.allocUnsafe(1 + imgBuf.length);
      msg[0] = usePng ? 0x02 : 0x01;
      imgBuf.copy(msg, 1);

      broadcastBinary(instance, msg);

      if (instance.recording) {
        instance.recordedFrames.push({ data: imgBuf, timestamp: Date.now() });
      }
    });

    await instance.cdpSession.send('Page.startScreencast', {
      format: usePng ? 'png' : 'jpeg',
      quality: usePng ? undefined : instance.quality,
      maxWidth: instance.viewport.width,
      maxHeight: instance.viewport.height,
      everyNthFrame: 1,
    });

    instance.screencastActive = true;
    instance.lastFrameTime = Date.now();
  }

  private async stopScreencast(instance: HeadlessInstance) {
    if (!instance.screencastActive) return;
    try {
      await instance.cdpSession.send('Page.stopScreencast');
    } catch {}
    instance.cdpSession.removeAllListeners('Page.screencastFrame');
    instance.screencastActive = false;
  }

  // --- CDP interception ---

  private async setupInterception(instance: HeadlessInstance) {
    const { cdpSession, browserCdpSession } = instance;

    // 1. JavaScript dialogs
    cdpSession.on('Page.javascriptDialogOpening', (params: any) => {
      const dialogId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let responded = false;

      instance.pendingDialogs.set(dialogId, {
        resolve: (accept: boolean, promptText?: string) => {
          if (responded) return;
          responded = true;
          instance.pendingDialogs.delete(dialogId);
          cdpSession.send('Page.handleJavaScriptDialog', { accept, promptText }).catch(() => {});
        },
        timeout: setTimeout(() => {
          if (!responded) {
            responded = true;
            instance.pendingDialogs.delete(dialogId);
            cdpSession.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
            broadcastJson(instance, { type: 'dialog_closed', dialogId, timedOut: true });
          }
        }, 30000),
      });

      broadcastJson(instance, {
        type: 'dialog_opened',
        dialogId,
        dialogType: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt,
        url: params.url,
      });
    });

    // 2. File chooser interception
    try {
      await cdpSession.send('Page.setInterceptFileChooserDialog', { enabled: true });
    } catch (err: any) {
      console.warn(`[preview/headless] File chooser interception not supported: ${err.message}`);
    }

    cdpSession.on('Page.fileChooserOpened', (params: any) => {
      broadcastJson(instance, {
        type: 'file_chooser_opened',
        mode: params.mode,
        frameId: params.frameId,
        backendNodeId: params.backendNodeId,
      });
    });

    // 3. Download interception
    const dlDir = path.join(DOWNLOAD_DIR, instance.id.replace('/', '_'));
    instance.downloadDir = dlDir;
    fs.mkdirSync(dlDir, { recursive: true });

    try {
      await browserCdpSession.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: dlDir,
        eventsEnabled: true,
      });
    } catch (err: any) {
      console.warn(`[preview/headless] Download interception not supported: ${err.message}`);
    }

    browserCdpSession.on('Browser.downloadWillBegin', (params: any) => {
      broadcastJson(instance, {
        type: 'download_started',
        guid: params.guid,
        suggestedFilename: params.suggestedFilename,
        url: params.url,
      });
    });

    browserCdpSession.on('Browser.downloadProgress', (params: any) => {
      if (params.state === 'completed') {
        broadcastJson(instance, { type: 'download_complete', guid: params.guid });
      }
    });

    // 4. New tab/popup interception
    browserCdpSession.on('Target.targetCreated', (params: any) => {
      const { targetInfo } = params;
      if (targetInfo.type === 'page' && targetInfo.openerId) {
        broadcastJson(instance, {
          type: 'new_tab',
          url: targetInfo.url,
          targetId: targetInfo.targetId,
        });
      }
    });

    try {
      await browserCdpSession.send('Target.setDiscoverTargets', { discover: true });
    } catch (err: any) {
      console.warn(`[preview/headless] Target discovery not supported: ${err.message}`);
    }
  }

  // --- Shadow Overlay: Script injection & bindings ---

  private async setupInjectedScripts(instance: HeadlessInstance) {
    const { page, cdpSession } = instance;

    // Use Puppeteer's exposeFunction for reliable binding→server communication
    // (raw Runtime.addBinding + Runtime.bindingCalled has CDP session routing issues)
    const expose = async (name: string, handler: (payload: string) => void) => {
      try {
        await page.exposeFunction(name, handler);
      } catch (err: any) {
        console.warn(`[preview/headless] Failed to expose ${name}: ${err.message}`);
      }
    };

    await expose('__atoo_selectOpened', (payload: string) => {
      try {
        const data = JSON.parse(payload);
        broadcastJson(instance, { type: 'select_opened', ...data });
      } catch {}
    });

    await expose('__atoo_pickerOpened', (payload: string) => {
      try {
        const data = JSON.parse(payload);
        // Rename data.type → inputType to avoid overwriting the message 'type' field
        const { type: inputType, ...rest } = data;
        broadcastJson(instance, { type: 'picker_opened', inputType, ...rest });
      } catch {}
    });

    await expose('__atoo_tooltipShow', (payload: string) => {
      try {
        const data = JSON.parse(payload);
        broadcastJson(instance, { type: 'tooltip_show', ...data });
      } catch {}
    });

    await expose('__atoo_tooltipHide', (_payload: string) => {
      broadcastJson(instance, { type: 'tooltip_hide' });
    });

    await expose('__atoo_contextMenu', (payload: string) => {
      try {
        const data = JSON.parse(payload);
        broadcastJson(instance, { type: 'context_menu', ...data });
      } catch {}
    });

    await expose('__atoo_clipboard', (payload: string) => {
      try {
        const data = JSON.parse(payload);
        broadcastJson(instance, { type: 'clipboard', text: data.text });
      } catch {}
    });

    // Inject the capture script — persists across navigations
    try {
      await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
        source: getInjectedScript(),
      });
    } catch (err: any) {
      console.warn(`[preview/headless] Failed to inject capture script: ${err.message}`);
    }
  }

  // --- Auth interception via Fetch domain ---

  private async setupAuthInterception(instance: HeadlessInstance) {
    const { cdpSession } = instance;

    try {
      // Only intercept auth challenges — use a pattern that won't match any URL
      // to avoid pausing normal requests (empty patterns[] = intercept everything)
      await cdpSession.send('Fetch.enable', {
        handleAuthRequests: true,
        patterns: [{ urlPattern: '__atoo_never_match__' }],
      });
    } catch (err: any) {
      console.warn(`[preview/headless] Fetch/auth interception not supported: ${err.message}`);
      return;
    }

    cdpSession.on('Fetch.authRequired', (params: any) => {
      const requestId = params.requestId;
      let responded = false;

      const timeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          instance.pendingAuthRequests.delete(requestId);
          cdpSession.send('Fetch.continueWithAuth', {
            requestId,
            authChallengeResponse: { response: 'CancelAuth' },
          }).catch(() => {});
          broadcastJson(instance, { type: 'auth_cancelled', requestId, timedOut: true });
        }
      }, 60000);

      instance.pendingAuthRequests.set(requestId, { requestId, timeout });

      broadcastJson(instance, {
        type: 'auth_required',
        requestId,
        url: params.request?.url || '',
        realm: params.authChallenge?.realm || '',
        scheme: params.authChallenge?.scheme || '',
      });
    });
  }

  // --- Public API ---

  async create(key: string, opts: CreatePreviewOpts): Promise<HeadlessInstance> {
    const cdpPort = await this.allocateCdpPort();
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
        // Permission auto-grant
        '--use-fake-device-for-media-stream',
        '--auto-accept-camera-and-microphone-capture',
      ];
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

      await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile, hasTouch });

      const cdpSession = await page.createCDPSession();
      const browserCdpSession = await browser.target().createCDPSession();

      const instance: HeadlessInstance = {
        id: key,
        browser,
        page,
        cdpSession,
        browserCdpSession,
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
        lastFrameTime: Date.now(),
        lastStreamRestart: 0,
        pendingDialogs: new Map(),
        pendingAuthRequests: new Map(),
        downloadDir: '',
      };

      await cdpSession.send('Page.enable');

      // URL change tracking
      cdpSession.on('Page.frameNavigated', (params: any) => {
        if (params.frame?.parentId) return;
        const url = params.frame?.url;
        if (url) {
          broadcastJson(instance, { type: 'url_changed', url });
        }
      });

      await this.setupInterception(instance);
      await this.setupInjectedScripts(instance);
      await this.setupAuthInterception(instance);

      // Grant permissions at browser level
      try {
        await browserCdpSession.send('Browser.grantPermissions', {
          permissions: ['geolocation', 'notifications', 'midi', 'audioCapture', 'videoCapture'],
        });
      } catch (err: any) {
        console.warn(`[preview/headless] Permission grant failed: ${err.message}`);
      }

      // Navigate with retries
      const targetUrl = opts.headerHost
        ? `${protocol}://${opts.headerHost}`
        : `${protocol}://localhost:${opts.targetPort}`;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
          break;
        } catch (err: any) {
          console.warn(`[preview/headless] Navigation to ${targetUrl} attempt ${attempt}/5: ${err.message}`);
          if (attempt < 5) await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Also evaluate the injected script immediately in the current page
      // (addScriptToEvaluateOnNewDocument only runs on future navigations)
      try {
        await cdpSession.send('Runtime.evaluate', {
          expression: getInjectedScript(),
        });
      } catch (err: any) {
        console.warn(`[preview/headless] Failed to evaluate capture script: ${err.message}`);
      }

      await this.startScreencast(instance);

      console.log(`[preview/headless] Created instance ${key} → ${targetUrl} (CDP port ${cdpPort})`);
      return instance;
    } catch (err) {
      this.releaseCdpPort(cdpPort);
      throw err;
    }
  }

  async destroy(instance: PreviewInstanceBase): Promise<void> {
    const inst = instance as HeadlessInstance;

    for (const [, dialog] of inst.pendingDialogs) {
      clearTimeout(dialog.timeout);
    }
    inst.pendingDialogs.clear();

    for (const [, auth] of inst.pendingAuthRequests) {
      clearTimeout(auth.timeout);
    }
    inst.pendingAuthRequests.clear();

    await this.stopScreencast(inst);
    try { await inst.browser.close(); } catch {}
    this.releaseCdpPort(inst.cdpPort);

    try { fs.rmSync(inst.downloadDir, { recursive: true, force: true }); } catch {}

    for (const ws of inst.wsClients) {
      ws.close(1000, 'Preview instance destroyed');
    }

    console.log(`[preview/headless] Destroyed instance ${inst.id}`);
  }

  private viewportTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async setViewport(instance: PreviewInstanceBase, viewport: {
    width: number;
    height: number;
    dpr?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }): Promise<void> {
    const inst = instance as HeadlessInstance;

    const newVp = {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr ?? inst.viewport.deviceScaleFactor,
      isMobile: viewport.isMobile ?? inst.viewport.isMobile,
      hasTouch: viewport.hasTouch ?? inst.viewport.hasTouch,
    };

    const cur = inst.viewport;
    if (cur.width === newVp.width && cur.height === newVp.height &&
        cur.deviceScaleFactor === newVp.deviceScaleFactor &&
        cur.isMobile === newVp.isMobile && cur.hasTouch === newVp.hasTouch) {
      return;
    }

    // Debounce rapid viewport changes — only apply after 200ms of no changes
    const existing = this.viewportTimers.get(inst.id);
    if (existing) clearTimeout(existing);

    inst.viewport = newVp; // Update immediately so the next comparison works

    this.viewportTimers.set(inst.id, setTimeout(async () => {
      this.viewportTimers.delete(inst.id);
      try {
        await this.stopScreencast(inst);
        await inst.page.setViewport({
          width: newVp.width,
          height: newVp.height,
          deviceScaleFactor: newVp.deviceScaleFactor,
          isMobile: newVp.isMobile,
          hasTouch: newVp.hasTouch,
        });
        await this.startScreencast(inst);
      } catch (err: any) {
        console.warn(`[preview/headless] Viewport update error: ${err.message}`);
      }
    }, 200));
    inst.lastActivity = Date.now();
  }

  async setQuality(instance: PreviewInstanceBase, quality: number): Promise<void> {
    const inst = instance as HeadlessInstance;
    inst.quality = quality;
    await this.stopScreencast(inst);
    await this.startScreencast(inst);
  }

  async navigate(instance: PreviewInstanceBase, url: string): Promise<void> {
    const inst = instance as HeadlessInstance;
    try {
      await inst.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (err: any) {
      console.warn(`[preview/headless] Navigate warning: ${err.message}`);
    }
    inst.lastActivity = Date.now();
  }

  async reload(instance: PreviewInstanceBase): Promise<void> {
    const inst = instance as HeadlessInstance;
    try {
      await inst.page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (err: any) {
      console.warn(`[preview/headless] Reload warning: ${err.message}`);
    }
    inst.lastActivity = Date.now();
  }

  async dispatchMouseEvent(instance: PreviewInstanceBase, params: any): Promise<void> {
    const inst = instance as HeadlessInstance;
    await inst.cdpSession.send('Input.dispatchMouseEvent', params);
    inst.lastActivity = Date.now();
  }

  async dispatchKeyEvent(instance: PreviewInstanceBase, params: any): Promise<void> {
    const inst = instance as HeadlessInstance;
    await inst.cdpSession.send('Input.dispatchKeyEvent', params);
    inst.lastActivity = Date.now();
  }

  async insertText(instance: PreviewInstanceBase, text: string): Promise<void> {
    const inst = instance as HeadlessInstance;
    await inst.cdpSession.send('Input.insertText', { text });
    inst.lastActivity = Date.now();
  }

  async dispatchScrollEvent(instance: PreviewInstanceBase, params: { x: number; y: number; deltaX: number; deltaY: number }): Promise<void> {
    const inst = instance as HeadlessInstance;
    await inst.cdpSession.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: params.x,
      y: params.y,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
    });
    inst.lastActivity = Date.now();
  }

  async screenshot(instance: PreviewInstanceBase, fullPage?: boolean): Promise<string> {
    const inst = instance as HeadlessInstance;
    const data = await inst.page.screenshot({
      fullPage: !!fullPage,
      type: 'png',
      encoding: 'base64',
    }) as string;
    return data;
  }

  handleDialogResponse(instance: PreviewInstanceBase, dialogId: string, accept: boolean, promptText?: string): void {
    const pending = instance.pendingDialogs.get(dialogId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(accept, promptText);
      broadcastJson(instance, { type: 'dialog_closed', dialogId, accepted: accept });
    }
  }

  async handleFileChooserResponse(instance: PreviewInstanceBase, backendNodeId: number, files: string[]): Promise<void> {
    const inst = instance as HeadlessInstance;
    try {
      await inst.cdpSession.send('DOM.setFileInputFiles', { files, backendNodeId });
    } catch (err: any) {
      console.warn(`[preview/headless] File chooser response error: ${err.message}`);
    }
  }

  getDownloadPath(instance: PreviewInstanceBase, guid: string): string | null {
    const filePath = path.join(instance.downloadDir, guid);
    if (fs.existsSync(filePath)) return filePath;
    return null;
  }

  startRecording(instance: PreviewInstanceBase): void {
    instance.recording = true;
    instance.recordedFrames = [];
    console.log(`[preview/headless] Recording started for ${instance.id}`);
  }

  async stopRecording(instance: PreviewInstanceBase): Promise<string> {
    instance.recording = false;
    const frames = instance.recordedFrames;
    instance.recordedFrames = [];

    if (frames.length === 0) throw new Error('No frames recorded');

    console.log(`[preview/headless] Recording stopped for ${instance.id}, encoding ${frames.length} frames...`);

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
      ffmpeg.stderr.on('data', () => {});

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        const webm = Buffer.concat(chunks);
        resolve(webm.toString('base64'));
      });

      ffmpeg.on('error', reject);

      for (const frame of frames) {
        ffmpeg.stdin.write(frame.data);
      }
      ffmpeg.stdin.end();
    });
  }

  async restartStream(instance: PreviewInstanceBase): Promise<void> {
    const inst = instance as HeadlessInstance;
    await this.stopScreencast(inst);
    await this.startScreencast(inst);
  }

  // --- Shadow Overlay response handlers ---

  async handleSelectResponse(instance: PreviewInstanceBase, selectorPath: string, value: string): Promise<void> {
    const inst = instance as HeadlessInstance;
    try {
      await inst.cdpSession.send('Runtime.evaluate', {
        expression: buildUniversalSetterExpression(selectorPath, value),
      });
    } catch (err: any) {
      console.warn(`[preview/headless] Select response error: ${err.message}`);
    }
    inst.lastActivity = Date.now();
  }

  async handlePickerResponse(instance: PreviewInstanceBase, selectorPath: string, value: string, inputType: string): Promise<void> {
    const inst = instance as HeadlessInstance;
    try {
      await inst.cdpSession.send('Runtime.evaluate', {
        expression: buildUniversalSetterExpression(selectorPath, value),
      });
    } catch (err: any) {
      console.warn(`[preview/headless] Picker response error: ${err.message}`);
    }
    inst.lastActivity = Date.now();
  }

  handleAuthResponse(instance: PreviewInstanceBase, requestId: string, username: string, password: string): void {
    const inst = instance as HeadlessInstance;
    const pending = inst.pendingAuthRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      inst.pendingAuthRequests.delete(requestId);
    }
    inst.cdpSession.send('Fetch.continueWithAuth', {
      requestId,
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username,
        password,
      },
    }).catch((err) => {
      console.warn(`[preview/headless] Auth response error: ${err.message}`);
    });
    inst.lastActivity = Date.now();
  }

  handleAuthCancel(instance: PreviewInstanceBase, requestId: string): void {
    const inst = instance as HeadlessInstance;
    const pending = inst.pendingAuthRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      inst.pendingAuthRequests.delete(requestId);
    }
    inst.cdpSession.send('Fetch.continueWithAuth', {
      requestId,
      authChallengeResponse: { response: 'CancelAuth' },
    }).catch((err) => {
      console.warn(`[preview/headless] Auth cancel error: ${err.message}`);
    });
    inst.lastActivity = Date.now();
  }

  async handleContextMenuAction(instance: PreviewInstanceBase, action: string, params: any): Promise<void> {
    const inst = instance as HeadlessInstance;
    try {
      switch (action) {
        case 'back':
          await inst.cdpSession.send('Page.navigateToHistoryEntry', {
            entryId: (await inst.cdpSession.send('Page.getNavigationHistory') as any).currentIndex - 1,
          });
          break;
        case 'forward':
          await inst.cdpSession.send('Page.navigateToHistoryEntry', {
            entryId: (await inst.cdpSession.send('Page.getNavigationHistory') as any).currentIndex + 1,
          });
          break;
        case 'reload':
          await inst.page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
          break;
        case 'copy':
          // selectedText is already sent to the frontend in context_menu message
          // Frontend handles clipboard.writeText() locally
          break;
        case 'copy_link':
          // linkHref is already in the context_menu message, frontend copies it
          break;
      }
    } catch (err: any) {
      console.warn(`[preview/headless] Context menu action '${action}' error: ${err.message}`);
    }
    inst.lastActivity = Date.now();
  }

  async shutdown(): Promise<void> {
    // Nothing to do — instances are destroyed individually by the manager
  }
}
