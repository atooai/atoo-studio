import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useStore } from '../../state/store';
import { normalizePreviewUrl, resolvePreviewSrc } from '../../utils';
import { DEVICE_PRESETS } from '../../data/device-presets';
import { api } from '../../api';

const MIN_VP = 200;

// Memoized iframe that only re-renders when url/mode/active status change —
// prevents React from re-applying the src attribute on parent re-renders
const PreviewIframe = React.memo(function PreviewIframe({ id, url, mode, active }: { id: string; url: string; mode: string; active: boolean }) {
  const resolved = resolvePreviewSrc(url, mode);
  return (
    <iframe
      key={id}
      className={`preview-iframe ${!active ? 'hidden' : ''}`}
      src={resolved}
    />
  );
});

export function PreviewPanel() {
  const {
    previewVisible, previewTabs, previewActiveIdx, previewMode,
    previewResponsive, previewViewportWidth, previewViewportHeight, previewDevicePreset, previewZoom,
    setPreviewTabs, setPreviewActiveIdx, setPreviewMode,
    setPreviewResponsive, setPreviewViewport, setPreviewDevicePreset, setPreviewZoom,
    setCtxMenu, addChatAttachment, addToast,
    getActiveProject, getActiveSession,
  } = useStore();

  const urlInputRef = useRef<HTMLInputElement>(null);
  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const screenshotLoadingRef = useRef(false);
  const screenshotBtnRef = useRef<HTMLButtonElement>(null);
  const scrollshotBtnRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number; edges: string } | null>(null);

  if (!previewVisible) return null;

  const activeTab = previewTabs[previewActiveIdx];

  const reloadActiveIframe = () => {
    const container = previewResponsive ? viewportRef.current : iframeContainerRef.current;
    const iframes = container?.querySelectorAll('iframe');
    if (iframes && iframes[previewActiveIdx]) {
      const iframe = iframes[previewActiveIdx];
      try {
        iframe.contentWindow?.location.reload();
      } catch {
        iframe.src = iframe.src;
      }
    }
  };

  const getActiveIframe = (): HTMLIFrameElement | null => {
    const container = previewResponsive ? viewportRef.current : iframeContainerRef.current;
    const iframes = container?.querySelectorAll('iframe');
    return iframes?.[previewActiveIdx] || null;
  };

  const addTab = (url = '') => {
    const id = 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const label = url ? url.replace(/^https?:\/\//, '').slice(0, 20) : 'New tab';
    setPreviewTabs([...previewTabs, { id, url, label }]);
    setPreviewActiveIdx(previewTabs.length);
  };

  const closeTab = (idx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const newTabs = previewTabs.filter((_, i) => i !== idx);
    let newIdx = previewActiveIdx;
    if (newIdx >= newTabs.length) newIdx = Math.max(0, newTabs.length - 1);
    if (newTabs.length === 0) { addTab(''); return; }
    setPreviewTabs(newTabs);
    setPreviewActiveIdx(newIdx);
  };

  const loadPreview = () => {
    let url = urlInputRef.current?.value.trim() || '';
    if (!url) return;
    url = normalizePreviewUrl(url);
    if (!activeTab) return;
    if (url === activeTab.url) {
      reloadActiveIframe();
    } else {
      const newTabs = previewTabs.map((t, i) =>
        i === previewActiveIdx ? { ...t, url, label: url.replace(/^https?:\/\//, '').slice(0, 20) } : t
      );
      setPreviewTabs(newTabs);
    }
  };

  const toggleMode = () => setPreviewMode(previewMode === 'browser' ? 'server' : 'browser');

  // --- Resize handles ---
  const handleResizeStart = (edges: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startW: previewViewportWidth, startH: previewViewportHeight, edges };
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const { startX, startY, startW, startH, edges } = dragRef.current;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let newW = startW, newH = startH;
      // Center-anchored: delta doubled since viewport is centered
      if (edges.includes('e')) newW = startW + dx * 2;
      if (edges.includes('w')) newW = startW - dx * 2;
      if (edges.includes('s')) newH = startH + dy * 2;
      if (edges.includes('n')) newH = startH - dy * 2;
      const containerRect = iframeContainerRef.current?.getBoundingClientRect();
      const maxW = containerRect ? containerRect.width - 40 : 4000;
      const maxH = containerRect ? containerRect.height - 60 : 4000;
      newW = Math.max(MIN_VP, Math.min(Math.round(newW), maxW));
      newH = Math.max(MIN_VP, Math.min(Math.round(newH), maxH));
      setPreviewViewport(newW, newH);
    };

    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // --- Device preset change ---
  const handlePresetChange = (id: string) => {
    if (id === 'custom') {
      setPreviewDevicePreset('custom');
      return;
    }
    const preset = DEVICE_PRESETS.find(p => p.id === id);
    if (preset) {
      setPreviewDevicePreset(id);
      // Don't use setPreviewViewport since that forces 'custom'
      useStore.setState({ previewViewportWidth: preset.width, previewViewportHeight: preset.height, previewDevicePreset: id });
    }
  };

  const handleRotate = () => {
    if (previewDevicePreset === 'custom') {
      setPreviewViewport(previewViewportHeight, previewViewportWidth);
      // keep custom
    } else {
      useStore.setState({ previewViewportWidth: previewViewportHeight, previewViewportHeight: previewViewportWidth });
    }
  };

  const handleDimInput = (axis: 'w' | 'h', val: string) => {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < MIN_VP) return;
    if (axis === 'w') setPreviewViewport(n, previewViewportHeight);
    else setPreviewViewport(previewViewportWidth, n);
  };

  // --- Screenshot: visible area via getDisplayMedia (captures actual current state) ---
  const setScreenshotBusy = (busy: boolean) => {
    screenshotLoadingRef.current = busy;
    if (screenshotBtnRef.current) screenshotBtnRef.current.disabled = busy;
    if (scrollshotBtnRef.current) scrollshotBtnRef.current.disabled = busy;
  };

  // Wait for fresh video frames after DOM changes (2 frames to ensure compositor caught up)
  // Wait for a fresh video frame from the capture pipeline after a DOM change.
  // Uses a fixed delay to ensure the compositor has painted and the capture delivered a new frame.
  const waitForPipelineFrame = (delayMs = 300): Promise<void> => {
    return new Promise(r => setTimeout(r, delayMs));
  };

  const captureVisibleArea = async (btnEl: HTMLElement) => {
    if (screenshotLoadingRef.current) return;
    setScreenshotBusy(true);
    try {
      const iframe = getActiveIframe();
      if (!iframe) throw new Error('No active iframe');
      const container = iframeContainerRef.current;
      if (!container) throw new Error('No container');

      // Use Region Capture API (Chrome 104+) to crop the capture to just the container.
      // This avoids coordinate issues from DevTools, capture toolbar, etc.
      const hasCropTarget = 'CropTarget' in window;
      let cropTarget: any = null;
      if (hasCropTarget) {
        cropTarget = await (window as any).CropTarget.fromElement(container);
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' } as any,
        preferCurrentTab: true,
      } as any);

      const track = stream.getVideoTracks()[0];

      // Crop the stream to just the container element
      if (cropTarget) {
        await (track as any).cropTo(cropTarget);
      }

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await waitForPipelineFrame();

      // With Region Capture: video = container's visible area
      // Without: video = full tab (fallback, less reliable with DevTools)
      const cr0 = container.getBoundingClientRect();
      const pxRatioX = cropTarget
        ? video.videoWidth / cr0.width
        : (window.devicePixelRatio || 1);
      const pxRatioY = cropTarget
        ? video.videoHeight / cr0.height
        : (window.devicePixelRatio || 1);

      // Save state
      const viewport = viewportRef.current;
      const savedZoom = previewZoom;
      const savedScrollLeft = container.scrollLeft;
      const savedScrollTop = container.scrollTop;

      // Reset zoom to 100% for native resolution
      if (previewResponsive && viewport && savedZoom !== 100) {
        viewport.style.transform = 'none';
        await waitForPipelineFrame();
      }

      // Target dimensions
      const nativeW = previewResponsive ? previewViewportWidth : iframe.clientWidth;
      const nativeH = previewResponsive ? previewViewportHeight : iframe.clientHeight;

      // Output canvas at exact native resolution
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = nativeW;
      outputCanvas.height = nativeH;
      const outCtx = outputCanvas.getContext('2d')!;

      // Helper: capture current video frame, crop to visible iframe, place on output
      const captureAndPlace = () => {
        const ir = iframe.getBoundingClientRect();
        const cr = container.getBoundingClientRect();

        const clipL = Math.max(ir.left, cr.left);
        const clipT = Math.max(ir.top, cr.top);
        const clipR = Math.min(ir.right, cr.right);
        const clipB = Math.min(ir.bottom, cr.bottom);
        if (clipR <= clipL || clipB <= clipT) return;

        // Source coordinates in video pixels
        // With Region Capture: video origin = container top-left → coords relative to container
        // Without: video origin = viewport top-left → coords are absolute CSS positions
        const srcBaseX = cropTarget ? (clipL - cr.left) : clipL;
        const srcBaseY = cropTarget ? (clipT - cr.top) : clipT;
        const sx = srcBaseX * pxRatioX;
        const sy = srcBaseY * pxRatioY;
        const sw = (clipR - clipL) * pxRatioX;
        const sh = (clipB - clipT) * pxRatioY;

        // Destination in native iframe pixels
        const dx = clipL - ir.left;
        const dy = clipT - ir.top;
        const dw = clipR - clipL;
        const dh = clipB - clipT;

        outCtx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
      };

      if (previewResponsive && viewport) {
        // Scroll to origin first
        container.scrollLeft = 0;
        container.scrollTop = 0;

        // Use container's client dimensions (excludes scrollbar) for step size
        const stepW = Math.max(1, container.clientWidth - 20); // 20px overlap
        const stepH = Math.max(1, container.clientHeight - 20);

        // Calculate max scroll range
        const maxScrollX = container.scrollWidth - container.clientWidth;
        const maxScrollY = container.scrollHeight - container.clientHeight;

        // Build scroll positions: 0, stepW, 2*stepW, ... clamped to maxScroll
        const xPositions: number[] = [0];
        for (let s = stepW; s <= maxScrollX; s += stepW) {
          xPositions.push(Math.min(s, maxScrollX));
          if (s >= maxScrollX) break;
        }
        if (xPositions[xPositions.length - 1] < maxScrollX) xPositions.push(maxScrollX);

        const yPositions: number[] = [0];
        for (let s = stepH; s <= maxScrollY; s += stepH) {
          yPositions.push(Math.min(s, maxScrollY));
          if (s >= maxScrollY) break;
        }
        if (yPositions[yPositions.length - 1] < maxScrollY) yPositions.push(maxScrollY);

        console.log(`[screenshot] Region Capture: ${hasCropTarget}, tiling: ${xPositions.length}x${yPositions.length}, step=${stepW}x${stepH}, video=${video.videoWidth}x${video.videoHeight}`);

        for (let yi = 0; yi < yPositions.length; yi++) {
          for (let xi = 0; xi < xPositions.length; xi++) {
            container.scrollLeft = xPositions[xi];
            container.scrollTop = yPositions[yi];
            await waitForPipelineFrame();
            captureAndPlace();
          }
        }
      } else {
        captureAndPlace();
      }

      track.stop();

      // Restore zoom and scroll
      if (previewResponsive && viewport && savedZoom !== 100) {
        viewport.style.transform = `scale(${savedZoom / 100})`;
      }
      container.scrollLeft = savedScrollLeft;
      container.scrollTop = savedScrollTop;

      const base64 = outputCanvas.toDataURL('image/png').split(',')[1];
      showScreenshotActions(base64, btnEl);
    } catch (err: any) {
      if (viewportRef.current && previewZoom !== 100) {
        viewportRef.current.style.transform = `scale(${previewZoom / 100})`;
      }
      const proj = getActiveProject();
      addToast(proj?.name || '', `Screenshot failed: ${err.message}`, 'attention');
    } finally {
      setScreenshotBusy(false);
    }
  };

  // --- Screenshot: scrollshot via Puppeteer backend ---
  const captureScrollshot = async (btnEl: HTMLElement) => {
    if (!activeTab?.url || screenshotLoadingRef.current) return;
    setScreenshotBusy(true);
    try {
      const url = resolvePreviewSrc(activeTab.url, previewMode);
      const width = previewResponsive ? previewViewportWidth : 1280;
      const height = previewResponsive ? previewViewportHeight : 720;
      const resp = await api('POST', '/api/screenshot', { url, width, height, fullPage: true });
      showScreenshotActions(resp.image, btnEl);
    } catch (err: any) {
      const proj = getActiveProject();
      addToast(proj?.name || '', `Scrollshot failed: ${err.message}`, 'attention');
    } finally {
      setScreenshotBusy(false);
    }
  };

  // --- Screenshot action menu ---
  const showScreenshotActions = (base64: string, btnEl: HTMLElement) => {
    const rect = btnEl.getBoundingClientRect();
    const proj = getActiveProject();
    const session = getActiveSession();

    const items: any[] = [
      {
        label: 'Download', icon: '↓',
        action: () => {
          const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `screenshot-${Date.now()}.png`; a.click();
          URL.revokeObjectURL(url);
        },
      },
      {
        label: 'Save to project', icon: '💾',
        action: async () => {
          if (!proj) return;
          const savePath = `${proj.worktreePath || proj.path}/screenshots/screenshot-${Date.now()}.png`;
          try {
            await api('POST', '/api/files/binary', { path: savePath, data: base64 });
            addToast(proj.name, 'Screenshot saved to project', 'info');
          } catch (err: any) {
            addToast(proj.name, `Save failed: ${err.message}`, 'attention');
          }
        },
      },
    ];

    if (session && session.status !== 'ended') {
      items.push({
        label: 'Attach to chat', icon: '📎',
        action: () => {
          addChatAttachment({
            id: 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            name: `screenshot-${Date.now()}.png`,
            size: Math.ceil(base64.length * 0.75),
            type: 'image/png',
            data: base64,
            text: null,
            kind: 'image',
          });
          addToast(proj?.name || '', 'Screenshot attached to chat', 'info');
        },
      });
    }

    setCtxMenu({ x: rect.left, y: rect.top - items.length * 32 - 8, items });
  };

  // --- Render iframes (memoized to prevent src re-application) ---
  const renderIframes = () =>
    previewTabs.map((tab, i) =>
      tab.url ? (
        <PreviewIframe key={tab.id} id={tab.id} url={tab.url} mode={previewMode} active={i === previewActiveIdx} />
      ) : null
    );

  return (
    <div className="preview-panel" id="preview-panel">
      <div className={`preview-frame-container ${previewResponsive ? 'responsive' : ''}`} ref={iframeContainerRef}>
        {activeTab && !activeTab.url && (
          <div className="preview-placeholder">Enter URL below to navigate</div>
        )}
        {previewResponsive ? (
          <div
            className="preview-responsive-viewport"
            ref={viewportRef}
            style={{
              width: previewViewportWidth,
              height: previewViewportHeight,
              transform: previewZoom !== 100 ? `scale(${previewZoom / 100})` : undefined,
              transformOrigin: 'center center',
            }}
          >
            {renderIframes()}
            {dragging && <div className="preview-drag-overlay" />}
            {/* Resize handles */}
            <div className="preview-resize-handle preview-resize-handle-n" onMouseDown={handleResizeStart('n')} />
            <div className="preview-resize-handle preview-resize-handle-s" onMouseDown={handleResizeStart('s')} />
            <div className="preview-resize-handle preview-resize-handle-e" onMouseDown={handleResizeStart('e')} />
            <div className="preview-resize-handle preview-resize-handle-w" onMouseDown={handleResizeStart('w')} />
            <div className="preview-resize-handle preview-resize-handle-nw" onMouseDown={handleResizeStart('nw')} />
            <div className="preview-resize-handle preview-resize-handle-ne" onMouseDown={handleResizeStart('ne')} />
            <div className="preview-resize-handle preview-resize-handle-sw" onMouseDown={handleResizeStart('sw')} />
            <div className="preview-resize-handle preview-resize-handle-se" onMouseDown={handleResizeStart('se')} />
            <div className="preview-viewport-dims">{previewViewportWidth} x {previewViewportHeight} {previewZoom !== 100 && `(${previewZoom}%)`}</div>
          </div>
        ) : (
          renderIframes()
        )}
      </div>
      <div className="preview-bottom-bar">
        {/* Responsive toolbar row */}
        <div className="preview-responsive-toolbar">
          <button
            className={`preview-responsive-toggle ${previewResponsive ? 'active' : ''}`}
            onClick={() => setPreviewResponsive(!previewResponsive)}
            title="Toggle responsive mode"
          >⬒</button>
          {previewResponsive && (
            <>
              <select
                className="preview-device-select"
                value={previewDevicePreset}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                <option value="custom">Custom</option>
                <optgroup label="Phone">
                  {DEVICE_PRESETS.filter(p => p.category === 'phone').map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </optgroup>
                <optgroup label="Tablet">
                  {DEVICE_PRESETS.filter(p => p.category === 'tablet').map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </optgroup>
                <optgroup label="Desktop">
                  {DEVICE_PRESETS.filter(p => p.category === 'laptop' || p.category === 'desktop').map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </optgroup>
              </select>
              <input
                className="preview-dim-input"
                type="number"
                value={previewViewportWidth}
                min={MIN_VP}
                onChange={(e) => handleDimInput('w', e.target.value)}
              />
              <span className="preview-dim-separator">x</span>
              <input
                className="preview-dim-input"
                type="number"
                value={previewViewportHeight}
                min={MIN_VP}
                onChange={(e) => handleDimInput('h', e.target.value)}
              />
              <button className="preview-rotate-btn" onClick={handleRotate} title="Rotate (swap dimensions)">⟳</button>
              <span className="preview-dim-separator">|</span>
              <select
                className="preview-zoom-select"
                value={previewZoom}
                onChange={(e) => setPreviewZoom(Number(e.target.value))}
                title="Zoom level"
              >
                <option value={25}>25%</option>
                <option value={50}>50%</option>
                <option value={75}>75%</option>
                <option value={100}>100%</option>
                <option value={125}>125%</option>
                <option value={150}>150%</option>
              </select>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button
            ref={screenshotBtnRef}
            className="preview-screenshot-btn"
            onClick={(e) => captureVisibleArea(e.currentTarget)}
            disabled={!activeTab?.url}
            title="Screenshot visible area"
          >📷</button>
          <button
            ref={scrollshotBtnRef}
            className="preview-screenshot-btn"
            onClick={(e) => captureScrollshot(e.currentTarget)}
            disabled={!activeTab?.url}
            title="Scrollshot (full page)"
          >📜</button>
        </div>
        <div className="preview-url-bar">
          <button
            className="preview-mode-btn"
            onClick={toggleMode}
            title={previewMode === 'browser' ? 'Browser mode' : 'Server mode'}
          >
            {previewMode === 'browser' ? 'B' : 'S'}
          </button>
          <input
            type="text"
            className="preview-url-input"
            ref={urlInputRef}
            defaultValue={activeTab?.url || ''}
            onKeyDown={(e) => { if (e.key === 'Enter') loadPreview(); }}
          />
          <button className="preview-refresh-btn" onClick={() => {
            const inputUrl = urlInputRef.current?.value.trim() || '';
            const normalized = inputUrl ? normalizePreviewUrl(inputUrl) : '';
            if (normalized && normalized !== activeTab?.url) {
              loadPreview();
            } else {
              reloadActiveIframe();
            }
          }}>↻</button>
          <button className="preview-refresh-btn" onClick={() => { const url = activeTab?.url; if (url) window.open(url, '_blank'); }} title="Open in new tab">↗</button>
        </div>
        <div className="preview-tab-row">
          {previewTabs.map((t, i) => (
            <div key={t.id} className={`preview-tab ${i === previewActiveIdx ? 'active' : ''}`} onClick={() => setPreviewActiveIdx(i)}>
              <span className="preview-tab-label">{t.label}</span>
              <span className="preview-tab-close" onClick={(e) => closeTab(i, e)}>×</span>
            </div>
          ))}
          <button className="preview-tab-add" onClick={() => addTab()} title="New preview tab">+</button>
        </div>
      </div>
    </div>
  );
}
