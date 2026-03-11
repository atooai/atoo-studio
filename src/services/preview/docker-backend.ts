import { spawn, execSync, ChildProcess } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WebSocket } from 'ws';
import {
  DOCKER_PREVIEW_IMAGE,
  DOCKER_PREVIEW_SOCKET_DIR,
  DOCKER_RUNTIME,
} from '../../config.js';
import {
  PreviewBackend,
  PreviewInstanceBase,
  CreatePreviewOpts,
  broadcastJson,
  broadcastBinary,
} from './preview-backend.js';

const DOWNLOAD_DIR = path.join(os.tmpdir(), 'atoo-studio-downloads');
const CONTAINER_HEALTH_TIMEOUT = 15000;
const CONTAINER_HEALTH_INTERVAL = 500;
const CONTAINER_SOCKET_DIR = '/sockets';
const IS_LINUX = os.platform() === 'linux';

export interface DockerInstance extends PreviewInstanceBase {
  containerId: string;
  containerName: string;
  containerWs: WebSocket | null;
  socketPath: string;
  /** Pending screenshot requests waiting for container response */
  pendingScreenshots: Map<string, { resolve: (data: string) => void; reject: (err: Error) => void }>;
}

export class DockerBackend implements PreviewBackend {
  readonly mode = 'docker' as const;

  /**
   * Check if Docker/Podman is available AND the preview image exists.
   */
  static async isAvailable(): Promise<boolean> {
    try {
      execSync(`${DOCKER_RUNTIME} image inspect ${DOCKER_PREVIEW_IMAGE} >/dev/null 2>&1`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  cleanupOrphans() {
    // Remove stale containers
    try {
      const ids = execSync(
        `${DOCKER_RUNTIME} ps -a --filter label=atoo-studio=preview -q 2>/dev/null || true`,
        { encoding: 'utf-8' },
      ).trim();
      if (ids) {
        for (const id of ids.split('\n').filter(Boolean)) {
          console.log(`[preview/docker] Removing orphaned container ${id}`);
          try { execSync(`${DOCKER_RUNTIME} rm -f ${id}`, { stdio: 'ignore' }); } catch {}
        }
      }
    } catch {}

    // Clean up stale socket files
    try {
      if (fs.existsSync(DOCKER_PREVIEW_SOCKET_DIR)) {
        for (const entry of fs.readdirSync(DOCKER_PREVIEW_SOCKET_DIR)) {
          const sockPath = path.join(DOCKER_PREVIEW_SOCKET_DIR, entry);
          try { fs.unlinkSync(sockPath); } catch {}
        }
      }
    } catch {}

    // Ensure socket directory exists
    fs.mkdirSync(DOCKER_PREVIEW_SOCKET_DIR, { recursive: true });
  }

  private socketPathForKey(key: string): string {
    // Sanitize key for use as filename (projectId/tabId → projectId-tabId)
    const safeName = key.replace(/[^a-zA-Z0-9_-]/g, '-');
    return path.join(DOCKER_PREVIEW_SOCKET_DIR, `${safeName}.sock`);
  }

  private buildTargetUrl(opts: CreatePreviewOpts): string {
    const protocol = opts.protocol || 'http';
    if (IS_LINUX) {
      return opts.headerHost
        ? `${protocol}://${opts.headerHost}`
        : `${protocol}://localhost:${opts.targetPort}`;
    } else {
      return opts.headerHost
        ? `${protocol}://${opts.headerHost}`
        : `${protocol}://host.docker.internal:${opts.targetPort}`;
    }
  }

  async create(key: string, opts: CreatePreviewOpts): Promise<DockerInstance> {
    const width = opts.width || 1920;
    const height = opts.height || 1080;
    const quality = opts.quality || 80;
    const protocol = opts.protocol || 'http';
    const containerName = `atoo-studio-preview-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const targetUrl = this.buildTargetUrl(opts);

    const dlDir = path.join(DOWNLOAD_DIR, key.replace('/', '_'));
    fs.mkdirSync(dlDir, { recursive: true });

    // Prepare socket path on host — each container gets its own socket dir
    const hostSocketPath = this.socketPathForKey(key);
    const hostSocketDir = path.dirname(hostSocketPath);
    fs.mkdirSync(hostSocketDir, { recursive: true });
    // Remove stale socket if exists
    try { fs.unlinkSync(hostSocketPath); } catch {}

    // Build docker run args
    const args = [
      'run', '-d',
      '--name', containerName,
      '--label', 'atoo-studio=preview',
      '-e', `TARGET_URL=${targetUrl}`,
      '-e', `WIDTH=${width}`,
      '-e', `HEIGHT=${height}`,
      '-e', `QUALITY=${quality}`,
      '-e', `SOCKET_PATH=${CONTAINER_SOCKET_DIR}/${path.basename(hostSocketPath)}`,
      '-v', `${dlDir}:${dlDir}`,
      '-e', `DOWNLOAD_DIR=${dlDir}`,
      // Mount the socket directory — container writes socket, host reads it
      '-v', `${hostSocketDir}:/sockets`,
    ];

    if (IS_LINUX) {
      args.push('--network=host');
    } else {
      args.push('--add-host=host.docker.internal:host-gateway');
    }

    // Host resolver rules for custom host headers
    if (opts.headerHost) {
      const defaultPort = protocol === 'https' ? 443 : 80;
      if (IS_LINUX) {
        args.push('-e', `HOST_RESOLVER_RULES=MAP ${opts.headerHost}:${defaultPort} 127.0.0.1:${opts.targetPort}, MAP ${opts.headerHost} 127.0.0.1`);
      } else {
        args.push('-e', `HOST_RESOLVER_RULES=MAP ${opts.headerHost}:${defaultPort} host.docker.internal:${opts.targetPort}, MAP ${opts.headerHost} host.docker.internal`);
      }
    }

    args.push(DOCKER_PREVIEW_IMAGE);

    // Launch container
    const containerId = execSync(`${DOCKER_RUNTIME} ${args.join(' ')}`, { encoding: 'utf-8' }).trim();
    console.log(`[preview/docker] Started container ${containerName} (${containerId.slice(0, 12)}) socket=${hostSocketPath}`);

    const instance: DockerInstance = {
      id: key,
      containerId,
      containerName,
      containerWs: null,
      socketPath: hostSocketPath,
      targetPort: opts.targetPort,
      headerHost: opts.headerHost,
      protocol,
      viewport: {
        width,
        height,
        deviceScaleFactor: opts.dpr || 1,
        isMobile: opts.isMobile || false,
        hasTouch: opts.hasTouch || false,
      },
      quality,
      wsClients: new Set(),
      lastActivity: Date.now(),
      recording: false,
      recordedFrames: [],
      lastFrameTime: Date.now(),
      pendingDialogs: new Map(),
      pendingAuthRequests: new Map(),
      downloadDir: dlDir,
      pendingScreenshots: new Map(),
      cdpSocketPath: hostSocketPath.replace('.sock', '-cdp.sock'),
    };

    // Wait for socket file to appear, then connect
    await this.waitForSocket(hostSocketPath);
    await this.connectContainerWs(instance);

    console.log(`[preview/docker] Instance ${key} ready → ${targetUrl}`);
    return instance;
  }

  private async waitForSocket(socketPath: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < CONTAINER_HEALTH_TIMEOUT) {
      if (fs.existsSync(socketPath)) {
        // Socket file exists — try a health check over it
        try {
          await new Promise<void>((resolve, reject) => {
            const req = http.get({ socketPath, path: '/health' }, (res) => {
              if (res.statusCode === 200) resolve();
              else reject(new Error(`Health check returned ${res.statusCode}`));
              res.resume();
            });
            req.on('error', reject);
            req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
          });
          return;
        } catch {
          // Socket exists but server not ready yet
        }
      }
      await new Promise(r => setTimeout(r, CONTAINER_HEALTH_INTERVAL));
    }
    throw new Error(`Container health check timed out after ${CONTAINER_HEALTH_TIMEOUT}ms`);
  }

  private async connectContainerWs(instance: DockerInstance): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${instance.socketPath}`);

      ws.on('open', () => {
        instance.containerWs = ws;
        resolve();
      });

      ws.on('error', (err) => {
        if (!instance.containerWs) reject(err);
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = data as Buffer;
          broadcastBinary(instance, buf);
          instance.lastActivity = Date.now();
          instance.lastFrameTime = Date.now();

          if (instance.recording && buf.length > 1) {
            instance.recordedFrames.push({ data: buf.subarray(1), timestamp: Date.now() });
          }
        } else {
          try {
            const msg = JSON.parse(data.toString());
            this.handleContainerMessage(instance, msg);
          } catch {}
        }
      });

      ws.on('close', () => {
        instance.containerWs = null;
      });
    });
  }

  private handleContainerMessage(instance: DockerInstance, msg: any) {
    switch (msg.type) {
      case 'dialog_opened': {
        broadcastJson(instance, msg);
        const dialogId = msg.dialogId;
        let responded = false;
        instance.pendingDialogs.set(dialogId, {
          resolve: (accept: boolean, promptText?: string) => {
            if (responded) return;
            responded = true;
            instance.pendingDialogs.delete(dialogId);
            this.sendToContainer(instance, { type: 'dialog_response', dialogId, accept, promptText });
          },
          timeout: setTimeout(() => {
            if (!responded) {
              responded = true;
              instance.pendingDialogs.delete(dialogId);
              this.sendToContainer(instance, { type: 'dialog_response', dialogId, accept: true });
              broadcastJson(instance, { type: 'dialog_closed', dialogId, timedOut: true });
            }
          }, 30000),
        });
        break;
      }

      case 'file_chooser_opened':
      case 'download_started':
      case 'download_complete':
      case 'new_tab':
      case 'url_changed':
      case 'clipboard':
        broadcastJson(instance, msg);
        break;

      case 'screenshot_response': {
        const pending = instance.pendingScreenshots.get(msg.requestId);
        if (pending) {
          instance.pendingScreenshots.delete(msg.requestId);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.data);
        }
        break;
      }
    }
  }

  private sendToContainer(instance: DockerInstance, msg: object) {
    if (instance.containerWs && instance.containerWs.readyState === 1) {
      instance.containerWs.send(JSON.stringify(msg));
    }
  }

  async destroy(instance: PreviewInstanceBase): Promise<void> {
    const inst = instance as DockerInstance;

    for (const [, dialog] of inst.pendingDialogs) {
      clearTimeout(dialog.timeout);
    }
    inst.pendingDialogs.clear();

    for (const [, pending] of inst.pendingScreenshots) {
      pending.reject(new Error('Instance destroyed'));
    }
    inst.pendingScreenshots.clear();

    if (inst.containerWs) {
      inst.containerWs.close();
      inst.containerWs = null;
    }

    // Stop and remove container
    try {
      execSync(`${DOCKER_RUNTIME} stop -t 2 ${inst.containerName} 2>/dev/null && ${DOCKER_RUNTIME} rm ${inst.containerName} 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      try { execSync(`${DOCKER_RUNTIME} rm -f ${inst.containerName}`, { stdio: 'ignore' }); } catch {}
    }

    // Clean up socket file
    try { fs.unlinkSync(inst.socketPath); } catch {}
    // Clean up CDP proxy socket
    if (inst.cdpSocketPath) {
      try { fs.unlinkSync(inst.cdpSocketPath); } catch {}
    }

    // Clean up download directory
    try { fs.rmSync(inst.downloadDir, { recursive: true, force: true }); } catch {}

    for (const ws of inst.wsClients) {
      ws.close(1000, 'Preview instance destroyed');
    }

    console.log(`[preview/docker] Destroyed instance ${inst.id}`);
  }

  async setViewport(instance: PreviewInstanceBase, viewport: {
    width: number;
    height: number;
    dpr?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }): Promise<void> {
    const inst = instance as DockerInstance;
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

    inst.viewport = newVp;
    this.sendToContainer(inst, { type: 'viewport', ...newVp });
    inst.lastActivity = Date.now();
  }

  async setQuality(instance: PreviewInstanceBase, quality: number): Promise<void> {
    const inst = instance as DockerInstance;
    inst.quality = quality;
    this.sendToContainer(inst, { type: 'quality', quality });
  }

  async navigate(instance: PreviewInstanceBase, url: string): Promise<void> {
    const inst = instance as DockerInstance;
    this.sendToContainer(inst, { type: 'navigate', url });
    inst.lastActivity = Date.now();
  }

  async reload(instance: PreviewInstanceBase): Promise<void> {
    const inst = instance as DockerInstance;
    this.sendToContainer(inst, { type: 'reload' });
    inst.lastActivity = Date.now();
  }

  async dispatchMouseEvent(instance: PreviewInstanceBase, params: any): Promise<void> {
    const inst = instance as DockerInstance;
    // params.type is the CDP event type (mouseMoved, mousePressed, etc.) — rename to 'event' to avoid collision
    const { type: event, ...rest } = params;
    this.sendToContainer(inst, { type: 'mouse', event, ...rest });
    inst.lastActivity = Date.now();
  }

  async dispatchKeyEvent(instance: PreviewInstanceBase, params: any): Promise<void> {
    const inst = instance as DockerInstance;
    const { type: event, ...rest } = params;
    this.sendToContainer(inst, { type: 'key', event, ...rest });
    inst.lastActivity = Date.now();
  }

  async insertText(instance: PreviewInstanceBase, text: string): Promise<void> {
    const inst = instance as DockerInstance;
    this.sendToContainer(inst, { type: 'text', text });
    inst.lastActivity = Date.now();
  }

  async dispatchScrollEvent(instance: PreviewInstanceBase, params: { x: number; y: number; deltaX: number; deltaY: number }): Promise<void> {
    const inst = instance as DockerInstance;
    this.sendToContainer(inst, { type: 'scroll', ...params });
    inst.lastActivity = Date.now();
  }

  async screenshot(instance: PreviewInstanceBase, fullPage?: boolean): Promise<string> {
    const inst = instance as DockerInstance;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise<string>((resolve, reject) => {
      inst.pendingScreenshots.set(requestId, { resolve, reject });
      this.sendToContainer(inst, { type: 'screenshot', requestId, fullPage: !!fullPage });

      setTimeout(() => {
        const pending = inst.pendingScreenshots.get(requestId);
        if (pending) {
          inst.pendingScreenshots.delete(requestId);
          pending.reject(new Error('Screenshot request timed out'));
        }
      }, 10000);
    });
  }

  handleDialogResponse(instance: PreviewInstanceBase, dialogId: string, accept: boolean, promptText?: string): void {
    const inst = instance as DockerInstance;
    const pending = inst.pendingDialogs.get(dialogId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(accept, promptText);
      broadcastJson(inst, { type: 'dialog_closed', dialogId, accepted: accept });
    }
  }

  async handleFileChooserResponse(instance: PreviewInstanceBase, backendNodeId: number, files: string[]): Promise<void> {
    const inst = instance as DockerInstance;

    // Copy files into container on macOS (no host networking)
    if (!IS_LINUX) {
      for (const file of files) {
        try {
          execSync(`${DOCKER_RUNTIME} cp "${file}" ${inst.containerName}:"${file}"`, { stdio: 'ignore' });
        } catch (err: any) {
          console.warn(`[preview/docker] Failed to copy file to container: ${err.message}`);
        }
      }
    }

    this.sendToContainer(inst, { type: 'file_chooser_response', backendNodeId, files });
  }

  getDownloadPath(instance: PreviewInstanceBase, guid: string): string | null {
    const filePath = path.join(instance.downloadDir, guid);
    if (fs.existsSync(filePath)) return filePath;
    return null;
  }

  startRecording(instance: PreviewInstanceBase): void {
    instance.recording = true;
    instance.recordedFrames = [];
    console.log(`[preview/docker] Recording started for ${instance.id}`);
  }

  async stopRecording(instance: PreviewInstanceBase): Promise<string> {
    instance.recording = false;
    const frames = instance.recordedFrames;
    instance.recordedFrames = [];

    if (frames.length === 0) throw new Error('No frames recorded');

    console.log(`[preview/docker] Recording stopped for ${instance.id}, encoding ${frames.length} frames...`);

    return new Promise<string>((resolve, reject) => {
      const ffmpeg = spawn('/usr/bin/ffmpeg', [
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
    const inst = instance as DockerInstance;
    if (!inst.containerWs || inst.containerWs.readyState !== 1) {
      try {
        await this.connectContainerWs(inst);
      } catch (err: any) {
        console.warn(`[preview/docker] Failed to reconnect to container: ${err.message}`);
      }
    }
  }

  // Shadow overlay stubs (not supported in Docker mode — native controls are visible via Xvfb)
  async handleSelectResponse(_instance: PreviewInstanceBase, _selectorPath: string, _value: string): Promise<void> {}
  async handlePickerResponse(_instance: PreviewInstanceBase, _selectorPath: string, _value: string, _inputType: string): Promise<void> {}
  handleAuthResponse(_instance: PreviewInstanceBase, _requestId: string, _username: string, _password: string): void {}
  handleAuthCancel(_instance: PreviewInstanceBase, _requestId: string): void {}
  async handleContextMenuAction(_instance: PreviewInstanceBase, _action: string, _params: any): Promise<void> {}

  async shutdown(): Promise<void> {
    // Nothing — instances are destroyed individually by the manager
  }
}
