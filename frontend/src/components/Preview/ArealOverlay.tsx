import React, { useRef, useCallback, useEffect, useState } from 'react';

export interface ArealRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ArealOverlayProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  rect: ArealRect | null;
  onRectChange: (rect: ArealRect | null) => void;
}

type HitZone = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | 'draw';

const HANDLE_MARGIN = 8; // px visual hit margin for edge/corner detection

function hitTest(
  clientX: number,
  clientY: number,
  overlayEl: HTMLElement,
  canvas: HTMLCanvasElement,
  rect: ArealRect | null,
): HitZone {
  if (!rect) return 'draw';

  const bounds = overlayEl.getBoundingClientRect();
  const scaleX = bounds.width / canvas.width;
  const scaleY = bounds.height / canvas.height;

  // Selection bounds in client coords
  const sx = bounds.left + rect.x * scaleX;
  const sy = bounds.top + rect.y * scaleY;
  const sw = rect.w * scaleX;
  const sh = rect.h * scaleY;

  const dx = clientX - sx;
  const dy = clientY - sy;

  const onLeft = dx >= -HANDLE_MARGIN && dx <= HANDLE_MARGIN;
  const onRight = dx >= sw - HANDLE_MARGIN && dx <= sw + HANDLE_MARGIN;
  const onTop = dy >= -HANDLE_MARGIN && dy <= HANDLE_MARGIN;
  const onBottom = dy >= sh - HANDLE_MARGIN && dy <= sh + HANDLE_MARGIN;
  const insideX = dx > HANDLE_MARGIN && dx < sw - HANDLE_MARGIN;
  const insideY = dy > HANDLE_MARGIN && dy < sh - HANDLE_MARGIN;

  if (onTop && onLeft) return 'nw';
  if (onTop && onRight) return 'ne';
  if (onBottom && onLeft) return 'sw';
  if (onBottom && onRight) return 'se';
  if (onTop && insideX) return 'n';
  if (onBottom && insideX) return 's';
  if (onLeft && insideY) return 'w';
  if (onRight && insideY) return 'e';
  if (insideX && insideY) return 'move';
  return 'draw';
}

function getCursor(zone: HitZone): string {
  switch (zone) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'move': return 'move';
    default: return 'crosshair';
  }
}

function clampRect(r: ArealRect, maxW: number, maxH: number): ArealRect {
  let { x, y, w, h } = r;
  // Normalize negative dimensions
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  // Clamp to canvas
  x = Math.max(0, Math.min(x, maxW));
  y = Math.max(0, Math.min(y, maxH));
  w = Math.min(w, maxW - x);
  h = Math.min(h, maxH - y);
  // Round to pixel grid
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function ArealOverlay({ canvasRef, rect, onRectChange }: ArealOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState('crosshair');
  const dragRef = useRef<{
    zone: HitZone;
    startX: number;
    startY: number;
    startRect: ArealRect;
    aspect: number;
  } | null>(null);

  // Convert client coords to canvas coords (pixel-grid snapped)
  const toCanvas = useCallback((clientX: number, clientY: number): { cx: number; cy: number } => {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return { cx: 0, cy: 0 };
    const bounds = overlay.getBoundingClientRect();
    return {
      cx: Math.round((clientX - bounds.left) * canvas.width / bounds.width),
      cy: Math.round((clientY - bounds.top) * canvas.height / bounds.height),
    };
  }, [canvasRef]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

    const zone = hitTest(e.clientX, e.clientY, overlay, canvas, rect);
    const { cx, cy } = toCanvas(e.clientX, e.clientY);

    if (zone === 'draw') {
      // Start drawing a new rect
      const newRect: ArealRect = { x: cx, y: cy, w: 0, h: 0 };
      onRectChange(newRect);
      dragRef.current = { zone: 'se', startX: cx, startY: cy, startRect: newRect, aspect: 0 };
    } else {
      // Start modifying existing rect
      dragRef.current = {
        zone,
        startX: cx,
        startY: cy,
        startRect: { ...rect! },
        aspect: rect!.h > 0 ? rect!.w / rect!.h : 1,
      };
    }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const { zone, startX, startY, startRect, aspect } = dragRef.current;
      const { cx: mx, cy: my } = toCanvas(ev.clientX, ev.clientY);
      const dx = mx - startX;
      const dy = my - startY;
      const maxW = canvas.width;
      const maxH = canvas.height;

      let newRect: ArealRect;

      if (zone === 'move') {
        newRect = clampRect({
          x: startRect.x + dx,
          y: startRect.y + dy,
          w: startRect.w,
          h: startRect.h,
        }, maxW, maxH);
        // Re-clamp position so the rect doesn't extend beyond canvas
        newRect.x = Math.max(0, Math.min(newRect.x, maxW - newRect.w));
        newRect.y = Math.max(0, Math.min(newRect.y, maxH - newRect.h));
      } else {
        // Resize
        let { x, y, w, h } = startRect;
        if (zone.includes('e')) w = startRect.w + dx;
        if (zone.includes('w')) { x = startRect.x + dx; w = startRect.w - dx; }
        if (zone.includes('s')) h = startRect.h + dy;
        if (zone.includes('n')) { y = startRect.y + dy; h = startRect.h - dy; }

        // Shift-constrain aspect ratio
        if (ev.shiftKey && aspect > 0) {
          if (Math.abs(dx) > Math.abs(dy)) {
            h = Math.round(Math.abs(w) / aspect) * Math.sign(h || 1);
          } else {
            w = Math.round(Math.abs(h) * aspect) * Math.sign(w || 1);
          }
        }

        newRect = clampRect({ x, y, w, h }, maxW, maxH);
      }

      onRectChange(newRect);
    };

    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [canvasRef, rect, onRectChange, toCanvas]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) return; // Don't update cursor during drag
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const zone = hitTest(e.clientX, e.clientY, overlay, canvas, rect);
    setCursor(getCursor(zone));
  }, [canvasRef, rect]);

  // Selection positioning via CSS percentages (works with zoom transforms)
  const canvas = canvasRef.current;
  const cw = canvas?.width || 1;
  const ch = canvas?.height || 1;

  return (
    <div
      ref={overlayRef}
      className="areal-overlay"
      style={{ cursor }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    >
      {rect && rect.w > 0 && rect.h > 0 && (
        <>
          <div
            className="areal-selection"
            style={{
              left: `${(rect.x / cw) * 100}%`,
              top: `${(rect.y / ch) * 100}%`,
              width: `${(rect.w / cw) * 100}%`,
              height: `${(rect.h / ch) * 100}%`,
            }}
          >
            {/* 8 handles: 4 corners + 4 edge midpoints */}
            <div className="areal-handle" style={{ left: 0, top: 0 }} />
            <div className="areal-handle" style={{ left: '50%', top: 0 }} />
            <div className="areal-handle" style={{ left: '100%', top: 0 }} />
            <div className="areal-handle" style={{ left: 0, top: '50%' }} />
            <div className="areal-handle" style={{ left: '100%', top: '50%' }} />
            <div className="areal-handle" style={{ left: 0, top: '100%' }} />
            <div className="areal-handle" style={{ left: '50%', top: '100%' }} />
            <div className="areal-handle" style={{ left: '100%', top: '100%' }} />
          </div>
          <div
            className="areal-dims-label"
            style={{
              left: `${((rect.x + rect.w / 2) / cw) * 100}%`,
              top: `${((rect.y + rect.h) / ch) * 100}%`,
            }}
          >
            {rect.w} &times; {rect.h}
          </div>
        </>
      )}
    </div>
  );
}
