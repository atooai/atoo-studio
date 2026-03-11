import { WebSocket } from 'ws';

export interface PendingDialog {
  resolve: (accept: boolean, promptText?: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PreviewViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export interface PreviewInstanceBase {
  id: string;
  targetPort: number;
  /** CDP port — only available in headless mode */
  cdpPort?: number;
  /** CDP unix socket path — only available in Docker mode */
  cdpSocketPath?: string;
  headerHost?: string;
  protocol: 'http' | 'https';
  viewport: PreviewViewport;
  quality: number;
  wsClients: Set<WebSocket>;
  lastActivity: number;
  recording: boolean;
  recordedFrames: { data: Buffer; timestamp: number }[];
  lastFrameTime: number;
  pendingDialogs: Map<string, PendingDialog>;
  pendingAuthRequests: Map<string, { requestId: string; timeout: ReturnType<typeof setTimeout> }>;
  downloadDir: string;
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

export interface PreviewBackend {
  readonly mode: 'headless' | 'docker';

  create(key: string, opts: CreatePreviewOpts): Promise<PreviewInstanceBase>;
  destroy(instance: PreviewInstanceBase): Promise<void>;

  setViewport(instance: PreviewInstanceBase, viewport: {
    width: number;
    height: number;
    dpr?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }): Promise<void>;

  setQuality(instance: PreviewInstanceBase, quality: number): Promise<void>;
  navigate(instance: PreviewInstanceBase, url: string): Promise<void>;
  reload(instance: PreviewInstanceBase): Promise<void>;

  dispatchMouseEvent(instance: PreviewInstanceBase, params: any): Promise<void>;
  dispatchKeyEvent(instance: PreviewInstanceBase, params: any): Promise<void>;
  insertText(instance: PreviewInstanceBase, text: string): Promise<void>;
  dispatchScrollEvent(instance: PreviewInstanceBase, params: { x: number; y: number; deltaX: number; deltaY: number }): Promise<void>;

  screenshot(instance: PreviewInstanceBase, fullPage?: boolean): Promise<string>;

  handleDialogResponse(instance: PreviewInstanceBase, dialogId: string, accept: boolean, promptText?: string): void;
  handleFileChooserResponse(instance: PreviewInstanceBase, backendNodeId: number, files: string[]): Promise<void>;

  getDownloadPath(instance: PreviewInstanceBase, guid: string): string | null;

  // Shadow overlay response handlers
  handleSelectResponse(instance: PreviewInstanceBase, selectorPath: string, value: string): Promise<void>;
  handlePickerResponse(instance: PreviewInstanceBase, selectorPath: string, value: string, inputType: string): Promise<void>;
  handleAuthResponse(instance: PreviewInstanceBase, requestId: string, username: string, password: string): void;
  handleAuthCancel(instance: PreviewInstanceBase, requestId: string): void;
  handleContextMenuAction(instance: PreviewInstanceBase, action: string, params: any): Promise<void>;

  startRecording(instance: PreviewInstanceBase): void;
  stopRecording(instance: PreviewInstanceBase): Promise<string>;

  /** Restart screencast/stream if stalled */
  restartStream(instance: PreviewInstanceBase): Promise<void>;

  /** Cleanup on startup (e.g. orphaned processes/containers) */
  cleanupOrphans(): void;

  shutdown(): Promise<void>;
}

/** Broadcast a JSON message to all connected WS clients */
export function broadcastJson(instance: PreviewInstanceBase, data: object) {
  const msg = JSON.stringify(data);
  for (const ws of instance.wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

/** Broadcast a binary frame to all connected WS clients */
export function broadcastBinary(instance: PreviewInstanceBase, data: Buffer) {
  for (const ws of instance.wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}
