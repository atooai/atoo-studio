import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useState } from 'react';
import { buildPreviewWsUrl } from '../../utils';
import { ArealOverlay, ArealRect } from './ArealOverlay';

export interface CanvasViewerProps {
  tabId: string;
  projectId: string;
  targetPort: number;
  headerHost?: string;
  protocol: 'http' | 'https';
  width: number;
  height: number;
  dpr: number;
  isMobile: boolean;
  hasTouch: boolean;
  quality: number;
  zoom: number;
  responsive: boolean;
  active: boolean;
  arealMode?: boolean;
  arealRect?: ArealRect | null;
  onArealRectChange?: (rect: ArealRect | null) => void;
  onUrlChange?: (url: string) => void;
  onScreenshot?: (data: string) => void;
  onScrollshot?: (data: string) => void;
  onRecording?: (data: string) => void;
  onDialogOpened?: (dialog: { dialogId: string; dialogType: string; message: string; defaultPrompt?: string; url: string }) => void;
  onDialogClosed?: (dialogId: string) => void;
  onFileChooserOpened?: (info: { mode: string; frameId: string; backendNodeId: number }) => void;
  onDownloadStarted?: (info: { guid: string; suggestedFilename: string; url: string }) => void;
  onDownloadComplete?: (guid: string) => void;
  onNewTab?: (info: { url: string; targetId: string }) => void;
  // Shadow overlay callbacks
  onSelectOpened?: (info: { rect: { x: number; y: number; width: number; height: number }; options: { value: string; text: string; selected: boolean; disabled: boolean; group: string | null }[]; selectedIndex: number; multiple: boolean; selectorPath: string }) => void;
  onPickerOpened?: (info: { type: string; value: string; min: string | null; max: string | null; step: string | null; rect: { x: number; y: number; width: number; height: number }; selectorPath: string }) => void;
  onTooltipShow?: (info: { text: string; rect: { x: number; y: number; width: number; height: number } }) => void;
  onTooltipHide?: () => void;
  onAuthRequired?: (info: { requestId: string; url: string; realm: string; scheme: string }) => void;
  onContextMenu?: (info: { x: number; y: number; selectedText: string; linkHref: string | null; linkText: string | null; imgSrc: string | null }) => void;
}

export interface CanvasViewerHandle {
  sendScreenshot: (fullPage?: boolean) => void;
  sendScrollshot: () => void;
  sendRecordStart: () => void;
  sendRecordStop: () => void;
  sendNavigate: (url: string) => void;
  sendViewport: (w: number, h: number, dpr?: number, isMobile?: boolean, hasTouch?: boolean) => void;
  sendQuality: (q: number) => void;
  sendReload: () => void;
  sendDialogResponse: (dialogId: string, accept: boolean, promptText?: string) => void;
  sendSelectResponse: (selectorPath: string, value: string) => void;
  sendPickerResponse: (selectorPath: string, value: string, inputType: string) => void;
  sendAuthResponse: (requestId: string, username: string, password: string) => void;
  sendAuthCancel: (requestId: string) => void;
  sendContextMenuAction: (action: string, params?: any) => void;
  cropScreenshot: (x: number, y: number, w: number, h: number) => string | null;
  getCanvas: () => HTMLCanvasElement | null;
}

// Map browser button index to CDP button string
function cdpButton(btn: number): string {
  switch (btn) {
    case 0: return 'left';
    case 1: return 'middle';
    case 2: return 'right';
    default: return 'none';
  }
}

// Build CDP modifiers bitmask from event
function cdpModifiers(e: React.MouseEvent | React.KeyboardEvent | React.WheelEvent): number {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}

// Keys that should be intercepted and sent as key events (not text input)
const CONTROL_KEYS = new Set([
  'Tab', 'Escape', 'Enter', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export const CanvasViewer = forwardRef<CanvasViewerHandle, CanvasViewerProps>(function CanvasViewer(props, ref) {
  const {
    tabId, projectId, targetPort, headerHost, protocol,
    width, height, dpr, isMobile, hasTouch, quality, zoom, responsive,
    active, arealMode, arealRect, onArealRectChange,
    onUrlChange, onScreenshot, onScrollshot, onRecording,
    onDialogOpened, onDialogClosed, onFileChooserOpened,
    onDownloadStarted, onDownloadComplete, onNewTab,
    onSelectOpened, onPickerOpened, onTooltipShow, onTooltipHide,
    onAuthRequired, onContextMenu: onContextMenuEvent,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);

  const send = useCallback((msg: any) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // Expose control methods
  useImperativeHandle(ref, () => ({
    sendScreenshot: (fullPage?: boolean) => send({ type: 'screenshot', fullPage }),
    sendScrollshot: () => send({ type: 'scrollshot' }),
    sendRecordStart: () => send({ type: 'record_start' }),
    sendRecordStop: () => send({ type: 'record_stop' }),
    sendNavigate: (url: string) => send({ type: 'navigate', url }),
    sendViewport: (w: number, h: number, d?: number, m?: boolean, t?: boolean) =>
      send({ type: 'viewport', width: w, height: h, dpr: d, isMobile: m, hasTouch: t }),
    sendQuality: (q: number) => send({ type: 'quality', quality: q }),
    sendReload: () => send({ type: 'reload' }),
    sendDialogResponse: (dialogId: string, accept: boolean, promptText?: string) =>
      send({ type: 'dialog_response', dialogId, accept, promptText }),
    sendSelectResponse: (selectorPath: string, value: string) =>
      send({ type: 'select_response', selectorPath, value }),
    sendPickerResponse: (selectorPath: string, value: string, inputType: string) =>
      send({ type: 'picker_response', selectorPath, value, inputType }),
    sendAuthResponse: (requestId: string, username: string, password: string) =>
      send({ type: 'auth_response', requestId, username, password }),
    sendAuthCancel: (requestId: string) =>
      send({ type: 'auth_cancel', requestId }),
    sendContextMenuAction: (action: string, params?: any) =>
      send({ type: 'context_menu_action', action, ...params }),
    getCanvas: () => canvasRef.current,
    cropScreenshot: (x: number, y: number, w: number, h: number): string | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      const ctx = offscreen.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      // Return base64 PNG (without the data:image/png;base64, prefix)
      const dataUrl = offscreen.toDataURL('image/png');
      return dataUrl.replace(/^data:image\/png;base64,/, '');
    },
  }), [send]);

  // WebSocket connection
  useEffect(() => {
    if (!active || !targetPort) return;

    const initW = responsive ? width : (containerSize?.w || undefined);
    const initH = responsive ? height : (containerSize?.h || undefined);
    const wsUrl = buildPreviewWsUrl(projectId, tabId, {
      targetPort,
      host: headerHost,
      protocol,
      quality,
      width: initW,
      height: initH,
      dpr: responsive ? dpr : undefined,
      isMobile: responsive ? isMobile : undefined,
      hasTouch: responsive ? hasTouch : undefined,
    });

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    // Reuse a single Image object for frame decoding
    if (!imgRef.current) {
      imgRef.current = new Image();
    }
    const img = imgRef.current;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      const el = wrapperRef.current;
      if (responsive) {
        ws.send(JSON.stringify({ type: 'viewport', width, height, dpr, isMobile, hasTouch }));
      } else if (el) {
        const rect = el.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w > 0 && h > 0) {
          ws.send(JSON.stringify({ type: 'viewport', width: w, height: h, dpr: 1, isMobile: false, hasTouch: false }));
        }
      }
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const view = new Uint8Array(e.data);
        if (view[0] === 0x01 || view[0] === 0x02) {
          const mime = view[0] === 0x02 ? 'image/png' : 'image/jpeg';
          const blob = new Blob([view.subarray(1)], { type: mime });
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = canvasRef.current;
            if (canvas) {
              if (canvas.width !== img.width || canvas.height !== img.height) {
                canvas.width = img.width;
                canvas.height = img.height;
              }
              const ctx = canvas.getContext('2d');
              if (ctx) ctx.drawImage(img, 0, 0);
            }
          };
          img.src = url;
        }
      } else {
        // JSON message
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'screenshot' && onScreenshot) onScreenshot(msg.data);
          else if (msg.type === 'scrollshot' && onScrollshot) onScrollshot(msg.data);
          else if (msg.type === 'recording' && onRecording) onRecording(msg.data);
          else if (msg.type === 'url_changed' && onUrlChange) onUrlChange(msg.url);
          else if (msg.type === 'dialog_opened' && onDialogOpened) onDialogOpened(msg);
          else if (msg.type === 'dialog_closed' && onDialogClosed) onDialogClosed(msg.dialogId);
          else if (msg.type === 'file_chooser_opened' && onFileChooserOpened) onFileChooserOpened(msg);
          else if (msg.type === 'download_started' && onDownloadStarted) onDownloadStarted(msg);
          else if (msg.type === 'download_complete' && onDownloadComplete) onDownloadComplete(msg.guid);
          else if (msg.type === 'new_tab' && onNewTab) onNewTab(msg);
          // Shadow overlay messages
          else if (msg.type === 'select_opened' && onSelectOpened) onSelectOpened(msg);
          else if (msg.type === 'picker_opened' && onPickerOpened) onPickerOpened(msg);
          else if (msg.type === 'tooltip_show' && onTooltipShow) onTooltipShow(msg);
          else if (msg.type === 'tooltip_hide' && onTooltipHide) onTooltipHide();
          else if (msg.type === 'auth_required' && onAuthRequired) onAuthRequired(msg);
          else if (msg.type === 'context_menu' && onContextMenuEvent) onContextMenuEvent(msg);
          else if (msg.type === 'clipboard' && msg.text) {
            navigator.clipboard.writeText(msg.text).catch(() => {});
          }
        } catch {}
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
    // Only reconnect on identity/connection changes, not viewport changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId, tabId, targetPort, headerHost, protocol]);

  // ResizeObserver to track actual container size (for non-responsive mode and auto-sizing)
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        const h = Math.round(entry.contentRect.height);
        if (w > 0 && h > 0) {
          setContainerSize((prev) => (prev && prev.w === w && prev.h === h) ? prev : { w, h });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Send viewport updates when dimensions change (debounced to avoid spamming during resize)
  useEffect(() => {
    if (!active || !wsRef.current || wsRef.current.readyState !== 1) return;
    let msg: any;
    if (responsive) {
      msg = { type: 'viewport', width, height, dpr, isMobile, hasTouch };
    } else if (containerSize) {
      msg = { type: 'viewport', width: containerSize.w, height: containerSize.h, dpr: 1, isMobile: false, hasTouch: false };
    }
    if (!msg) return;
    const timer = setTimeout(() => send(msg), 150);
    return () => clearTimeout(timer);
  }, [active, responsive, width, height, dpr, isMobile, hasTouch, containerSize, send]);

  // Periodic viewport sync fallback every 5s (catches missed resize events)
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      const ws = wsRef.current;
      const el = wrapperRef.current;
      if (!ws || ws.readyState !== 1 || !el) return;
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w > 0 && h > 0) {
        if (responsive) {
          ws.send(JSON.stringify({ type: 'viewport', width, height, dpr, isMobile, hasTouch }));
        } else {
          ws.send(JSON.stringify({ type: 'viewport', width: w, height: h, dpr: 1, isMobile: false, hasTouch: false }));
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [active, responsive, width, height, dpr, isMobile, hasTouch]);

  // Send quality updates
  useEffect(() => {
    if (!active || !wsRef.current || wsRef.current.readyState !== 1) return;
    send({ type: 'quality', quality });
  }, [active, quality, send]);

  // Coordinate scaling
  const scaleCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY),
    };
  }, []);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (arealMode) return;
    e.preventDefault();
    // Focus hidden input for keyboard capture
    hiddenInputRef.current?.focus();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    send({
      type: 'mouse', event: 'mousePressed',
      x, y,
      button: cdpButton(e.button),
      clickCount: e.detail || 1,
      modifiers: cdpModifiers(e),
    });
  }, [arealMode, scaleCoords, send]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (arealMode) return;
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    send({
      type: 'mouse', event: 'mouseReleased',
      x, y,
      button: cdpButton(e.button),
      clickCount: e.detail || 1,
      modifiers: cdpModifiers(e),
    });
  }, [arealMode, scaleCoords, send]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (arealMode) return;
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    send({
      type: 'mouse', event: 'mouseMoved',
      x, y,
      button: 'none',
      modifiers: cdpModifiers(e),
    });
  }, [arealMode, scaleCoords, send]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (arealMode) return;
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    send({
      type: 'scroll',
      x, y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }, [arealMode, scaleCoords, send]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Keyboard handlers
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Let Ctrl+V / Cmd+V through to trigger native paste → handlePaste
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') return;

    if (e.key.length > 1 || e.ctrlKey || e.altKey || e.metaKey || CONTROL_KEYS.has(e.key)) {
      e.preventDefault();
      send({
        type: 'key', event: 'keyDown',
        key: e.key,
        code: e.code,
        text: e.key.length === 1 ? e.key : undefined,
        modifiers: cdpModifiers(e),
        windowsVirtualKeyCode: e.keyCode,
      });
      // Also send char event for Enter
      if (e.key === 'Enter') {
        send({
          type: 'key', event: 'char',
          key: e.key,
          code: e.code,
          text: '\r',
          modifiers: cdpModifiers(e),
        });
      }
    }
  }, [send]);

  // Hidden input for text input (handles printable characters, IME, paste)
  const handleInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const text = input.value;
    if (text) {
      send({ type: 'text', text });
      input.value = '';
    }
  }, [send]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    if (text) {
      send({ type: 'text', text });
    }
  }, [send]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key.length > 1 || e.ctrlKey || e.altKey || e.metaKey || CONTROL_KEYS.has(e.key)) {
      e.preventDefault();
      send({
        type: 'key', event: 'keyUp',
        key: e.key,
        code: e.code,
        modifiers: cdpModifiers(e),
        windowsVirtualKeyCode: e.keyCode,
      });
    }
  }, [send]);

  if (!active) return null;

  // Canvas display dimensions
  const displayW = responsive ? width : '100%';
  const displayH = responsive ? height : '100%';

  return (
    <div
      ref={wrapperRef}
      className="canvas-viewer-wrapper"
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      tabIndex={-1}
      style={{ width: typeof displayW === 'number' ? displayW : undefined, height: typeof displayH === 'number' ? displayH : undefined }}
    >
      <canvas
        ref={canvasRef}
        className="canvas-viewer"
        style={{
          width: typeof displayW === 'number' ? `${displayW}px` : displayW,
          height: typeof displayH === 'number' ? `${displayH}px` : displayH,
        }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      />
      {arealMode && (
        <ArealOverlay
          canvasRef={canvasRef}
          rect={arealRect || null}
          onRectChange={onArealRectChange || (() => {})}
        />
      )}
      <input
        ref={hiddenInputRef}
        className="canvas-viewer-hidden-input"
        type="text"
        autoComplete="off"
        onInput={handleInput}
        onPaste={handlePaste}
      />
    </div>
  );
});
