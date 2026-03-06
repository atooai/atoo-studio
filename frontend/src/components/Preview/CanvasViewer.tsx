import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useState } from 'react';
import { buildPreviewWsUrl } from '../../utils';

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
  onUrlChange?: (url: string) => void;
  onScreenshot?: (data: string) => void;
  onScrollshot?: (data: string) => void;
  onRecording?: (data: string) => void;
}

export interface CanvasViewerHandle {
  sendScreenshot: (fullPage?: boolean) => void;
  sendScrollshot: () => void;
  sendRecordStart: () => void;
  sendRecordStop: () => void;
  sendNavigate: (url: string) => void;
  sendViewport: (w: number, h: number, dpr?: number, isMobile?: boolean, hasTouch?: boolean) => void;
  sendQuality: (q: number) => void;
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
    active, onUrlChange, onScreenshot, onScrollshot, onRecording,
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

    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Resize canvas to match frame
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0);
    };

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Send current viewport once connected — ensures Puppeteer matches actual canvas size
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
        // Binary message: first byte = type
        const view = new Uint8Array(e.data);
        if (view[0] === 0x01) {
          // Frame: rest is JPEG data
          const blob = new Blob([view.subarray(1)], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = canvasRef.current;
            if (!canvas) return;
            if (canvas.width !== img.width || canvas.height !== img.height) {
              canvas.width = img.width;
              canvas.height = img.height;
            }
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.drawImage(img, 0, 0);
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
  }, [scaleCoords, send]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    send({
      type: 'mouse', event: 'mouseReleased',
      x, y,
      button: cdpButton(e.button),
      clickCount: e.detail || 1,
      modifiers: cdpModifiers(e),
    });
  }, [scaleCoords, send]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    send({
      type: 'mouse', event: 'mouseMoved',
      x, y,
      button: 'none',
      modifiers: cdpModifiers(e),
    });
  }, [scaleCoords, send]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    send({
      type: 'scroll',
      x, y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }, [scaleCoords, send]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Keyboard handlers
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
