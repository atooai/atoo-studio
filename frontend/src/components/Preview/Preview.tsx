import React, { useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { DEVICE_PRESETS } from '../../data/device-presets';
import { api } from '../../api';
import { CanvasViewer, CanvasViewerHandle } from './CanvasViewer';
import { ConnectionBar } from './ConnectionBar';
import { DevToolsPanel } from './DevToolsPanel';

const MIN_VP = 200;

export function PreviewPanel() {
  const {
    previewVisible, previewTabs, previewActiveIdx,
    previewResponsive, previewViewportWidth, previewViewportHeight, previewDevicePreset, previewZoom,
    previewDpr, previewIsMobile, previewHasTouch,
    setPreviewTabs, setPreviewActiveIdx,
    setPreviewResponsive, setPreviewViewport, setPreviewDevicePreset, setPreviewZoom,
    setCtxMenu, addChatAttachment, addToast,
    getActiveProject, getActiveSession,
    activeProjectId,
  } = useStore();

  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasViewerRef = useRef<CanvasViewerHandle>(null);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [devtoolsVisible, setDevtoolsVisible] = useState(false);
  const screenshotBtnRef = useRef<HTMLButtonElement>(null);
  const scrollshotBtnRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number; edges: string } | null>(null);

  if (!previewVisible) return null;

  const activeTab = previewTabs[previewActiveIdx];
  const isConnected = !!(activeTab?.targetPort);

  const addTab = () => {
    const id = 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    setPreviewTabs([...previewTabs, { id, label: 'New tab' }]);
    setPreviewActiveIdx(previewTabs.length);
  };

  const closeTab = (idx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const newTabs = previewTabs.filter((_, i) => i !== idx);
    let newIdx = previewActiveIdx;
    if (newIdx >= newTabs.length) newIdx = Math.max(0, newTabs.length - 1);
    if (newTabs.length === 0) { addTab(); return; }
    setPreviewTabs(newTabs);
    setPreviewActiveIdx(newIdx);
  };

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
      useStore.setState({ previewDevicePreset: 'custom' });
      return;
    }
    setPreviewDevicePreset(id);
  };

  const handleRotate = () => {
    if (previewDevicePreset === 'custom') {
      setPreviewViewport(previewViewportHeight, previewViewportWidth);
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
          const savePath = `${proj.path}/screenshots/screenshot-${Date.now()}.png`;
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

  // Handle recording
  const handleRecordToggle = () => {
    if (!isConnected) return;
    if (recording) {
      canvasViewerRef.current?.sendRecordStop();
      setRecording(false);
    } else {
      canvasViewerRef.current?.sendRecordStart();
      setRecording(true);
    }
  };

  // Recording download handler
  const handleRecordingData = (data: string) => {
    const blob = new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `recording-${Date.now()}.webm`; a.click();
    URL.revokeObjectURL(url);
    const proj = getActiveProject();
    addToast(proj?.name || '', 'Recording saved', 'info');
  };

  // --- Render canvas viewer ---
  const renderCanvasViewer = () => {
    if (!activeTab?.targetPort || !activeProjectId) return null;
    return (
      <CanvasViewer
        ref={canvasViewerRef}
        tabId={activeTab.id}
        projectId={activeProjectId}
        targetPort={activeTab.targetPort}
        headerHost={activeTab.headerHost}
        protocol={activeTab.protocol || 'http'}
        width={previewViewportWidth}
        height={previewViewportHeight}
        dpr={previewDpr}
        isMobile={previewIsMobile}
        hasTouch={previewHasTouch}
        quality={activeTab.quality || 80}
        zoom={previewZoom}
        responsive={previewResponsive}
        active={true}
        onScreenshot={(data) => {
          if (screenshotBtnRef.current) showScreenshotActions(data, screenshotBtnRef.current);
        }}
        onScrollshot={(data) => {
          if (scrollshotBtnRef.current) showScreenshotActions(data, scrollshotBtnRef.current);
        }}
        onRecording={handleRecordingData}
      />
    );
  };

  return (
    <div className="preview-panel" id="preview-panel">
      <div className="preview-main-area">
        <div className={`preview-frame-container ${previewResponsive ? 'responsive' : ''}`} ref={iframeContainerRef}>
          {!isConnected && (
            <div className="preview-placeholder">Enter port below to connect</div>
          )}
          {isConnected && previewResponsive ? (
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
              {renderCanvasViewer()}
              {dragging && <div className="preview-drag-overlay" />}
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
          ) : isConnected ? (
            renderCanvasViewer()
          ) : null}
        </div>
        {isConnected && activeProjectId && (
          <DevToolsPanel
            projectId={activeProjectId}
            tabId={activeTab!.id}
            visible={devtoolsVisible}
            onToggle={() => setDevtoolsVisible(!devtoolsVisible)}
          />
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
          {isConnected && (
            <button
              className={`preview-screenshot-btn ${recording ? 'recording' : ''}`}
              onClick={handleRecordToggle}
              title={recording ? 'Stop recording' : 'Start recording'}
            >{recording ? '⏹' : '🎬'}</button>
          )}
          <button
            ref={screenshotBtnRef}
            className="preview-screenshot-btn"
            onClick={() => canvasViewerRef.current?.sendScreenshot(false)}
            disabled={!isConnected}
            title="Screenshot visible area"
          >📷</button>
          <button
            ref={scrollshotBtnRef}
            className="preview-screenshot-btn"
            onClick={() => canvasViewerRef.current?.sendScrollshot()}
            disabled={!isConnected}
            title="Scrollshot (full page)"
          >📜</button>
          {isConnected && (
            <button
              className={`preview-devtools-toggle ${devtoolsVisible ? 'active' : ''}`}
              onClick={() => setDevtoolsVisible(!devtoolsVisible)}
              title="Toggle DevTools"
            >DevTools</button>
          )}
        </div>
        {/* Connection bar — always shown */}
        <ConnectionBar tab={activeTab || { id: '' }} tabIdx={previewActiveIdx} />
        <div className="preview-tab-row">
          {previewTabs.map((t, i) => (
            <div key={t.id} className={`preview-tab ${i === previewActiveIdx ? 'active' : ''}`} onClick={() => setPreviewActiveIdx(i)}>
              <span className="preview-tab-label">{t.label}</span>
              <span className="preview-tab-close" onClick={(e) => closeTab(i, e)}>×</span>
            </div>
          ))}
          <button className="preview-tab-add" onClick={addTab} title="New preview tab">+</button>
        </div>
      </div>
    </div>
  );
}
