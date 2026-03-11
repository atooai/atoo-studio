/**
 * Container server for Docker-based preview.
 * Runs inside a Docker container with Xvfb + headed Chrome + ffmpeg.
 *
 * Environment variables:
 *   TARGET_URL - URL to load in Chrome
 *   WIDTH - viewport width (default 1920)
 *   HEIGHT - viewport height (default 1080)
 *   QUALITY - JPEG quality 1-100 (default 80)
 *   SOCKET_PATH - Unix socket path (default /sockets/preview.sock)
 *   DOWNLOAD_DIR - directory for downloads
 *   HOST_RESOLVER_RULES - Chrome --host-resolver-rules flag value
 *   DISPLAY - X11 display (default :99)
 */

import http, { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, execSync, ChildProcess } from 'child_process';
import { connect } from 'net';
import fs from 'fs';

const TARGET_URL = process.env.TARGET_URL || 'about:blank';
let WIDTH = parseInt(process.env.WIDTH || '1920', 10);
let HEIGHT = parseInt(process.env.HEIGHT || '1080', 10);
let QUALITY = parseInt(process.env.QUALITY || '80', 10);
const SOCKET_PATH = process.env.SOCKET_PATH || '/sockets/preview.sock';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/tmp/downloads';
const HOST_RESOLVER_RULES = process.env.HOST_RESOLVER_RULES || '';
// Use a random display number to avoid conflicts with --network=host
const DISPLAY = process.env.DISPLAY || `:${50 + Math.floor(Math.random() * 200)}`;
// Ensure child processes (xdotool, xrandr, ffmpeg) inherit the display
process.env.DISPLAY = DISPLAY;

let xvfbProc: ChildProcess | null = null;
let chromeProc: ChildProcess | null = null;
let ffmpegProc: ChildProcess | null = null;
let cdpWs: WebSocket | null = null;
let browserCdpWs: WebSocket | null = null;
let cdpId = 1;
let browserCdpId = 1;
const cdpCallbacks = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>();
const browserCdpCallbacks = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>();
const wsClients = new Set<WebSocket>();

// --- CDP helpers ---

function cdpSend(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== 1) {
      reject(new Error('CDP not connected'));
      return;
    }
    const id = cdpId++;
    cdpCallbacks.set(id, { resolve, reject });
    cdpWs.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (cdpCallbacks.has(id)) {
        cdpCallbacks.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 10000);
  });
}

// Fire-and-forget CDP send — no waiting for response, no timeout tracking
function cdpFire(method: string, params: any = {}) {
  if (!cdpWs || cdpWs.readyState !== 1) return;
  const id = cdpId++;
  cdpWs.send(JSON.stringify({ id, method, params }));
}

function browserCdpSend(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!browserCdpWs || browserCdpWs.readyState !== 1) {
      reject(new Error('Browser CDP not connected'));
      return;
    }
    const id = browserCdpId++;
    browserCdpCallbacks.set(id, { resolve, reject });
    browserCdpWs.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (browserCdpCallbacks.has(id)) {
        browserCdpCallbacks.delete(id);
        reject(new Error(`Browser CDP timeout: ${method}`));
      }
    }, 10000);
  });
}

function broadcastJson(data: object) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function broadcastBinary(data: Buffer) {
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// --- Xvfb ---
// Use a large fixed framebuffer so we never need to restart Xvfb on resize.
// ffmpeg captures only the WIDTHxHEIGHT region; Chrome window is resized to match.
const XVFB_MAX_W = 3840;
const XVFB_MAX_H = 2160;

function startXvfb(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (xvfbProc) {
      try { xvfbProc.kill(); } catch {}
    }
    xvfbProc = spawn('Xvfb', [
      DISPLAY,
      '-screen', '0', `${XVFB_MAX_W}x${XVFB_MAX_H}x24`,
      '-ac',
      '-nolisten', 'tcp',
      '-nolisten', 'local',  // avoid abstract socket conflicts with --network=host
    ]);
    xvfbProc.on('error', reject);
    // Give Xvfb time to start
    setTimeout(resolve, 500);
  });
}

// --- Chrome ---

function startChrome(): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '--remote-debugging-port=9222',
      '--no-sandbox',
      '--test-type',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--ignore-certificate-errors',
      '--user-data-dir=/tmp/chrome-data',
      '--disable-extensions',
      '--disable-default-apps',
      '--no-first-run',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--window-position=0,0`,
      `--app=${TARGET_URL}`,
    ];
    if (HOST_RESOLVER_RULES) {
      args.push(`--host-resolver-rules=${HOST_RESOLVER_RULES}`);
    }

    chromeProc = spawn('google-chrome-stable', args, {
      env: { ...process.env, DISPLAY },
    });
    chromeProc.on('error', reject);
    // Wait for Chrome to start and CDP to be available
    const startTime = Date.now();
    const checkCdp = () => {
      const sock = connect(9222, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        if (Date.now() - startTime > 10000) {
          reject(new Error('Chrome CDP not available after 10s'));
        } else {
          setTimeout(checkCdp, 200);
        }
      });
    };
    setTimeout(checkCdp, 1000);
  });
}

// --- CDP connection ---

async function connectCdp(): Promise<void> {
  // Find the page target (retry — Chrome may not have created it yet)
  let pageTarget: any = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const targetsResp = await fetch('http://127.0.0.1:9222/json');
    const targets = await targetsResp.json() as any[];
    pageTarget = targets.find((t: any) => t.type === 'page');
    if (pageTarget) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!pageTarget) throw new Error('No page target found after 10s');
  const pageWsUrl = pageTarget.webSocketDebuggerUrl;

  // Also get browser WS URL for browser-level domains (downloads, targets)
  const versionResp = await fetch('http://127.0.0.1:9222/json/version');
  const versionInfo = await versionResp.json() as any;
  const browserWsUrl = versionInfo.webSocketDebuggerUrl;

  // Connect to page target for Page/DOM/Input domains
  await connectWs(pageWsUrl, (msg) => {
    if (msg.method) handleCdpEvent(msg.method, msg.params);
  });

  // Connect to browser target for Browser/Target domains
  browserCdpWs = new WebSocket(browserWsUrl);
  await new Promise<void>((resolve, reject) => {
    browserCdpWs!.on('open', resolve);
    browserCdpWs!.on('error', reject);
  });
  browserCdpWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id && browserCdpCallbacks.has(msg.id)) {
        const cb = browserCdpCallbacks.get(msg.id)!;
        browserCdpCallbacks.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message));
        else cb.resolve(msg.result);
      } else if (msg.method) {
        handleCdpEvent(msg.method, msg.params);
      }
    } catch {}
  });

  await setupCdpInterception();
}

function connectWs(url: string, onMessage: (msg: any) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    cdpWs = new WebSocket(url);

    cdpWs.on('open', resolve);

    cdpWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && cdpCallbacks.has(msg.id)) {
          const cb = cdpCallbacks.get(msg.id)!;
          cdpCallbacks.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message));
          else cb.resolve(msg.result);
        } else {
          onMessage(msg);
        }
      } catch {}
    });

    cdpWs.on('error', reject);
  });
}

async function setupCdpInterception() {
  // Page-level domains (via page target)
  await cdpSend('Page.enable');

  try {
    await cdpSend('Page.setInterceptFileChooserDialog', { enabled: true });
  } catch {}

  // Browser-level domains (via browser target)
  try {
    await browserCdpSend('Target.setDiscoverTargets', { discover: true });
  } catch {}

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  try {
    await browserCdpSend('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true,
    });
  } catch {}

  // Hide the cursor in all page content (captured by ffmpeg, frontend shows its own)
  try {
    await cdpSend('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        const s = document.createElement('style');
        s.textContent = '*, *::before, *::after { cursor: none !important; }';
        (document.head || document.documentElement).appendChild(s);
      `,
    });
    // Apply to current page too
    await cdpSend('Runtime.evaluate', {
      expression: `
        const s = document.createElement('style');
        s.textContent = '*, *::before, *::after { cursor: none !important; }';
        (document.head || document.documentElement).appendChild(s);
      `,
    });
  } catch {}
}

function handleCdpEvent(method: string, params: any) {
  switch (method) {
    case 'Page.javascriptDialogOpening': {
      const dialogId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Store dialog for auto-dismiss timeout
      const timeout = setTimeout(() => {
        cdpSend('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        broadcastJson({ type: 'dialog_closed', dialogId, timedOut: true });
      }, 30000);
      pendingDialogs.set(dialogId, timeout);

      broadcastJson({
        type: 'dialog_opened',
        dialogId,
        dialogType: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt,
        url: params.url,
      });
      break;
    }

    case 'Page.fileChooserOpened':
      broadcastJson({
        type: 'file_chooser_opened',
        mode: params.mode,
        frameId: params.frameId,
        backendNodeId: params.backendNodeId,
      });
      break;

    case 'Browser.downloadWillBegin':
      broadcastJson({
        type: 'download_started',
        guid: params.guid,
        suggestedFilename: params.suggestedFilename,
        url: params.url,
      });
      break;

    case 'Browser.downloadProgress':
      if (params.state === 'completed') {
        broadcastJson({ type: 'download_complete', guid: params.guid });
      }
      break;

    case 'Target.targetCreated': {
      const { targetInfo } = params;
      if (targetInfo.type === 'page' && targetInfo.openerId) {
        broadcastJson({
          type: 'new_tab',
          url: targetInfo.url,
          targetId: targetInfo.targetId,
        });
      }
      break;
    }

    case 'Page.frameNavigated':
      if (!params.frame?.parentId && params.frame?.url) {
        broadcastJson({ type: 'url_changed', url: params.frame.url });
      }
      break;
  }
}

const pendingDialogs = new Map<string, ReturnType<typeof setTimeout>>();

// --- ffmpeg MJPEG capture with frame deduplication ---

let prevFrameSize = 0;
let prevFrameSample = 0;

function startFfmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.kill('SIGKILL'); } catch {}
  }

  const qv = QUALITY >= 100 ? 2 : Math.max(2, Math.min(31, Math.round(31 - (QUALITY / 100) * 29)));

  ffmpegProc = spawn('ffmpeg', [
    '-probesize', '32',
    '-analyzeduration', '0',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-f', 'x11grab',
    '-framerate', '30',
    '-video_size', `${WIDTH}x${HEIGHT}`,
    '-i', DISPLAY,
    '-f', 'mjpeg',
    '-q:v', String(qv),
    '-flush_packets', '1',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  let buffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);

  ffmpegProc.stdout!.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const soiIdx = buffer.indexOf(SOI);
      if (soiIdx === -1) break;
      const eoiIdx = buffer.indexOf(EOI, soiIdx + 2);
      if (eoiIdx === -1) break;

      const frame = buffer.subarray(soiIdx, eoiIdx + 2);
      buffer = buffer.subarray(eoiIdx + 2);

      // Quick dedup: compare size + a few sample bytes
      const sample = frame.length > 100 ? frame[100] ^ frame[frame.length - 100] : 0;
      if (frame.length === prevFrameSize && sample === prevFrameSample) continue;
      prevFrameSize = frame.length;
      prevFrameSample = sample;

      const msg = Buffer.allocUnsafe(1 + frame.length);
      msg[0] = 0x01;
      frame.copy(msg, 1);
      broadcastBinary(msg);
    }

    if (buffer.length > 10 * 1024 * 1024) {
      buffer = Buffer.alloc(0);
    }
  });

  ffmpegProc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[container] ffmpeg exited with code ${code}`);
    }
  });
}

// --- xdotool async helpers (for native popup support) ---

function xdoSpawn(...args: (string | number)[]) {
  spawn('xdotool', args.map(String), { stdio: 'ignore' }).unref();
}

function cdpButtonToX11(button: string): number {
  switch (button) {
    case 'left': return 1;
    case 'middle': return 2;
    case 'right': return 3;
    default: return 1;
  }
}

let pendingMove: { x: number; y: number } | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;

function flushMove() {
  if (pendingMove) {
    xdoSpawn('mousemove', '--screen', '0', pendingMove.x, pendingMove.y);
    pendingMove = null;
  }
  moveTimer = null;
}

function flushMoveSync(x: number, y: number) {
  if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
  pendingMove = null;
  xdoSpawn('mousemove', '--screen', '0', x, y);
}

// --- Message handling ---

async function handleClientMessage(msg: any) {
  switch (msg.type) {
    case 'mouse': {
      // Use xdotool for mouse events — works on native popups (select, date picker)
      // CDP Input only reaches the page, not separate X11 popup windows
      const mx = Math.round(msg.x || 0);
      const my = Math.round(msg.y || 0);
      switch (msg.event) {
        case 'mouseMoved':
          // Coalesce moves — only dispatch the latest
          pendingMove = { x: mx, y: my };
          if (!moveTimer) {
            moveTimer = setTimeout(flushMove, 8);
          }
          break;
        case 'mousePressed':
          flushMoveSync(mx, my);
          xdoSpawn('mousedown', cdpButtonToX11(msg.button));
          break;
        case 'mouseReleased':
          flushMoveSync(mx, my);
          xdoSpawn('mouseup', cdpButtonToX11(msg.button));
          break;
      }
      break;
    }

    case 'key':
      cdpFire('Input.dispatchKeyEvent', {
        type: msg.event,
        key: msg.key,
        code: msg.code,
        text: msg.text,
        modifiers: msg.modifiers || 0,
        windowsVirtualKeyCode: msg.windowsVirtualKeyCode,
        nativeVirtualKeyCode: msg.nativeVirtualKeyCode,
      });
      // After Ctrl+C/Cmd+C keyDown, read the page selection and send to host clipboard
      if (msg.event === 'keyDown' && msg.key === 'c' && (msg.modifiers & (2 | 4))) {
        // Small delay for Chrome to process the copy
        setTimeout(async () => {
          try {
            const result = await cdpSend('Runtime.evaluate', {
              expression: 'window.getSelection().toString()',
              returnByValue: true,
            });
            const text = result?.result?.value;
            if (text) {
              broadcastJson({ type: 'clipboard', text });
            }
          } catch {}
        }, 50);
      }
      break;

    case 'text':
      if (msg.text) {
        cdpFire('Input.insertText', { text: msg.text });
      }
      break;

    case 'scroll':
      cdpFire('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: msg.x || 0,
        y: msg.y || 0,
        deltaX: msg.deltaX || 0,
        deltaY: msg.deltaY || 0,
      });
      break;

    case 'viewport': {
      const newWidth = msg.width || WIDTH;
      const newHeight = msg.height || HEIGHT;
      if (newWidth !== WIDTH || newHeight !== HEIGHT) {
        WIDTH = newWidth;
        HEIGHT = newHeight;

        if (ffmpegProc) { try { ffmpegProc.kill('SIGKILL'); } catch {} }

        try {
          execSync(`xdotool search --onlyvisible --class chrome windowmove 0 0 windowsize ${WIDTH} ${HEIGHT}`, { stdio: 'ignore' });
        } catch {}

        await new Promise(r => setTimeout(r, 200));
        prevFrameSize = 0; prevFrameSample = -1; // force next frame to be sent
        startFfmpeg();
      }
      break;
    }

    case 'quality': {
      const newQuality = msg.quality || 80;
      if (newQuality !== QUALITY) {
        QUALITY = newQuality;
        if (ffmpegProc) { try { ffmpegProc.kill('SIGKILL'); } catch {} }
        prevFrameSize = 0; prevFrameSample = -1;
        startFfmpeg();
      }
      break;
    }

    case 'navigate':
      if (msg.url) {
        try { await cdpSend('Page.navigate', { url: msg.url }); } catch {}
      }
      break;

    case 'reload':
      try { await cdpSend('Page.reload'); } catch {}
      break;

    case 'screenshot': {
      try {
        const result = await cdpSend('Page.captureScreenshot', {
          format: 'png',
          ...(msg.fullPage ? { captureBeyondViewport: true } : {}),
        });
        broadcastJson({ type: 'screenshot_response', requestId: msg.requestId, data: result.data });
      } catch (err: any) {
        broadcastJson({ type: 'screenshot_response', requestId: msg.requestId, error: err.message });
      }
      break;
    }

    case 'dialog_response': {
      const timeout = pendingDialogs.get(msg.dialogId);
      if (timeout) {
        clearTimeout(timeout);
        pendingDialogs.delete(msg.dialogId);
      }
      try {
        await cdpSend('Page.handleJavaScriptDialog', {
          accept: msg.accept,
          promptText: msg.promptText,
        });
      } catch {}
      broadcastJson({ type: 'dialog_closed', dialogId: msg.dialogId, accepted: msg.accept });
      break;
    }

    case 'file_chooser_response':
      try {
        await cdpSend('DOM.setFileInputFiles', {
          files: msg.files || [],
          backendNodeId: msg.backendNodeId,
        });
      } catch (err: any) {
        console.warn(`[container] File chooser error: ${err.message}`);
      }
      break;
  }
}

// --- HTTP + WebSocket server ---

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Don't await — input events are fire-and-forget, others handle their own async
      handleClientMessage(msg).catch(() => {});
    } catch (err: any) {
      console.error(`[container] Message error: ${err.message}`);
    }
  });
  ws.on('close', () => { wsClients.delete(ws); });
});

// --- Startup ---

async function main() {
  console.log(`[container] Starting: ${TARGET_URL} ${WIDTH}x${HEIGHT} quality=${QUALITY}`);

  await startXvfb();
  // Hide the X11 cursor globally (including native popups)
  spawn('unclutter', ['--timeout', '0', '--hide-on-touch'], { stdio: 'ignore' }).unref();
  console.log('[container] Xvfb started');

  await startChrome();
  console.log('[container] Chrome started');

  await connectCdp();
  console.log('[container] CDP connected');

  startFfmpeg();
  console.log('[container] ffmpeg started');

  // Remove stale socket file if it exists (e.g. container restart)
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  httpServer.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o777); } catch {}
    console.log(`[container] WS server listening on ${SOCKET_PATH}`);
  });

  // CDP proxy — HTTP+WS reverse proxy from unix socket to Chrome's CDP port
  const cdpSocketPath = SOCKET_PATH.replace('.sock', '-cdp.sock');
  try { fs.unlinkSync(cdpSocketPath); } catch {}
  const cdpProxyServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Proxy HTTP requests to Chrome's CDP HTTP endpoint
    const proxyReq = http.request({
      host: '127.0.0.1', port: 9222,
      path: req.url, method: req.method, headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(proxyReq);
  });
  // Handle WS upgrades for CDP WebSocket connections
  cdpProxyServer.on('upgrade', (req, socket, head) => {
    const target = connect(9222, '127.0.0.1');
    // Replay the HTTP upgrade request to Chrome
    const rawReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n';
    target.write(rawReq);
    if (head.length > 0) target.write(head);
    target.pipe(socket as any);
    (socket as any).pipe(target);
    target.on('error', () => (socket as any).destroy());
    (socket as any).on('error', () => target.destroy());
  });
  cdpProxyServer.listen(cdpSocketPath, () => {
    try { fs.chmodSync(cdpSocketPath, 0o777); } catch {}
    console.log(`[container] CDP proxy listening on ${cdpSocketPath}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[container] SIGTERM received, shutting down...');
  if (ffmpegProc) try { ffmpegProc.kill(); } catch {}
  if (chromeProc) try { chromeProc.kill(); } catch {}
  if (xvfbProc) try { xvfbProc.kill(); } catch {}
  if (cdpWs) cdpWs.close();
  if (browserCdpWs) browserCdpWs.close();
  httpServer.close();
  process.exit(0);
});

main().catch((err) => {
  console.error(`[container] Fatal error: ${err.message}`);
  process.exit(1);
});
