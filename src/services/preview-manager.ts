import { WebSocket } from 'ws';
import { PreviewBackend, PreviewInstanceBase, CreatePreviewOpts } from './preview/preview-backend.js';
import { HeadlessBackend } from './preview/headless-backend.js';
import { DockerBackend } from './preview/docker-backend.js';

const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL = 10 * 1000; // 10 seconds (also serves as stream watchdog)

// Re-export types for backward compatibility
export type { PreviewInstanceBase as PreviewInstance, CreatePreviewOpts } from './preview/preview-backend.js';

class PreviewManager {
  private instances = new Map<string, PreviewInstanceBase>();
  private backend!: PreviewBackend;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupInactive(), CLEANUP_INTERVAL);
    // Backend selection is deferred to init() since it's async
    this.init();
  }

  private async init() {
    // Force headless CDP mode (shadow overlay interception requires it)
    this.backend = new HeadlessBackend();
    console.log('[preview] Using headless backend (forced)');
    this.backend.cleanupOrphans();
    this.initialized = true;
  }

  private async ensureInitialized() {
    // Spin until init() completes (typically < 100ms)
    while (!this.initialized) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  get backendMode(): string {
    return this.backend?.mode || 'initializing';
  }

  private makeKey(projectId: string, tabId: string): string {
    return `${projectId}/${tabId}`;
  }

  get(projectId: string, tabId: string): PreviewInstanceBase | undefined {
    return this.instances.get(this.makeKey(projectId, tabId));
  }

  // --- Public API (delegates to backend) ---

  async create(projectId: string, tabId: string, opts: CreatePreviewOpts): Promise<PreviewInstanceBase> {
    await this.ensureInitialized();
    const key = this.makeKey(projectId, tabId);

    // Destroy existing instance if any
    if (this.instances.has(key)) {
      await this.destroy(projectId, tabId);
    }

    const instance = await this.backend.create(key, opts);
    this.instances.set(key, instance);
    return instance;
  }

  async destroy(projectId: string, tabId: string) {
    const key = this.makeKey(projectId, tabId);
    const instance = this.instances.get(key);
    if (!instance) return;

    this.instances.delete(key);
    await this.backend.destroy(instance);
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
    await this.backend.setViewport(instance, viewport);
  }

  async setQuality(projectId: string, tabId: string, quality: number) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.setQuality(instance, quality);
  }

  async navigate(projectId: string, tabId: string, url: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.navigate(instance, url);
  }

  async reload(projectId: string, tabId: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.reload(instance);
  }

  async dispatchMouseEvent(projectId: string, tabId: string, params: any) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.dispatchMouseEvent(instance, params);
  }

  async dispatchKeyEvent(projectId: string, tabId: string, params: any) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.dispatchKeyEvent(instance, params);
  }

  async insertText(projectId: string, tabId: string, text: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.insertText(instance, text);
  }

  async dispatchScrollEvent(projectId: string, tabId: string, params: { x: number; y: number; deltaX: number; deltaY: number }) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.dispatchScrollEvent(instance, params);
  }

  handleDialogResponse(projectId: string, tabId: string, dialogId: string, accept: boolean, promptText?: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    this.backend.handleDialogResponse(instance, dialogId, accept, promptText);
  }

  async handleFileChooserResponse(projectId: string, tabId: string, backendNodeId: number, files: string[]) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.handleFileChooserResponse(instance, backendNodeId, files);
  }

  getDownloadPath(projectId: string, tabId: string, guid: string): string | null {
    const instance = this.get(projectId, tabId);
    if (!instance) return null;
    return this.backend.getDownloadPath(instance, guid);
  }

  // --- Shadow overlay response handlers ---

  async handleSelectResponse(projectId: string, tabId: string, selectorPath: string, value: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.handleSelectResponse(instance, selectorPath, value);
  }

  async handlePickerResponse(projectId: string, tabId: string, selectorPath: string, value: string, inputType: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.handlePickerResponse(instance, selectorPath, value, inputType);
  }

  handleAuthResponse(projectId: string, tabId: string, requestId: string, username: string, password: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    this.backend.handleAuthResponse(instance, requestId, username, password);
  }

  handleAuthCancel(projectId: string, tabId: string, requestId: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    this.backend.handleAuthCancel(instance, requestId);
  }

  async handleContextMenuAction(projectId: string, tabId: string, action: string, params: any) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    await this.backend.handleContextMenuAction(instance, action, params);
  }

  async screenshot(projectId: string, tabId: string, fullPage?: boolean): Promise<string> {
    const instance = this.get(projectId, tabId);
    if (!instance) throw new Error('Preview instance not found');
    return this.backend.screenshot(instance, fullPage);
  }

  startRecording(projectId: string, tabId: string) {
    const instance = this.get(projectId, tabId);
    if (!instance) return;
    this.backend.startRecording(instance);
  }

  async stopRecording(projectId: string, tabId: string): Promise<string> {
    const instance = this.get(projectId, tabId);
    if (!instance) throw new Error('Preview instance not found');
    return this.backend.stopRecording(instance);
  }

  // --- Cleanup ---

  private cleanupInactive() {
    const now = Date.now();
    for (const [key, instance] of this.instances) {
      if (instance.wsClients.size === 0 && now - instance.lastActivity > INACTIVITY_TIMEOUT) {
        const [projectId, tabId] = key.split('/');
        console.log(`[preview] Cleaning up inactive instance ${key}`);
        this.destroy(projectId, tabId);
        continue;
      }
      // Watchdog: restart stream if no frames received for 5s and there are active clients
      if (instance.wsClients.size > 0 && now - instance.lastFrameTime > 5000) {
        console.log(`[preview] Stream stalled for ${key}, restarting...`);
        this.backend.restartStream(instance).catch(() => {});
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
    if (this.backend) {
      await this.backend.shutdown();
    }
  }
}

export const previewManager = new PreviewManager();
