import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../state/store';
import { DEVICE_PRESETS } from '../../data/device-presets';
import { DEVICE_FRAMES, DeviceFrameDef } from '../../data/device-frames';
import { api } from '../../api';
import { CanvasViewer, CanvasViewerHandle } from './CanvasViewer';
import { ConnectionBar } from './ConnectionBar';
import { DevToolsPanel } from './DevToolsPanel';
import { DeviceFrame, captureFramedScreenshot, captureMockupScreenshot } from './DeviceFrame';
import { ArealRect } from './ArealOverlay';
import {
  DialogModal, DialogInfo, FileChooserModal, FileChooserInfo, DownloadNotification, DownloadInfo,
  SelectDropdownOverlay, SelectInfo, PickerOverlay, PickerInfo,
  AuthModal, AuthInfo, TooltipOverlay, TooltipInfo,
  ContextMenuOverlay, ContextMenuInfo,
} from './PreviewDialogs';

const MIN_VP = 200;

/** Input with non-passive wheel listener for scroll-to-adjust. */
function ScrollInput({ onScroll, ...props }: React.InputHTMLAttributes<HTMLInputElement> & {
  onScroll: (delta: number, shift: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const cbRef = useRef(onScroll);
  cbRef.current = onScroll;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      cbRef.current(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  return <input ref={ref} {...props} />;
}

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
  const [streamQuality, setStreamQuality] = useState(80);
  const [activeDialog, setActiveDialog] = useState<DialogInfo | null>(null);
  const [fileChooser, setFileChooser] = useState<FileChooserInfo | null>(null);
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  // Shadow overlay state
  const [selectOverlay, setSelectOverlay] = useState<SelectInfo | null>(null);
  const [pickerOverlay, setPickerOverlay] = useState<PickerInfo | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [authDialog, setAuthDialog] = useState<AuthInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuInfo | null>(null);
  const tooltipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenshotBtnRef = useRef<HTMLButtonElement>(null);
  const scrollshotBtnRef = useRef<HTMLButtonElement>(null);
  const framedBtnRef = useRef<HTMLButtonElement>(null);
  const arealBtnRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number; edges: string } | null>(null);

  // --- Local state for dimension inputs (allows free typing, deferred validation) ---
  const [dimW, setDimW] = useState(String(previewViewportWidth));
  const [dimH, setDimH] = useState(String(previewViewportHeight));
  const [dimWValid, setDimWValid] = useState(true);
  const [dimHValid, setDimHValid] = useState(true);

  // --- Areal screenshot state ---
  const [arealMode, setArealMode] = useState(false);
  const [arealRect, setArealRect] = useState<ArealRect | null>(null);

  // --- Device frame state ---
  const [deviceFrameId, setDeviceFrameId] = useState<string>('none');
  const activeFrame: DeviceFrameDef | null = DEVICE_FRAMES.find(f => f.id === deviceFrameId) || null;

  // --- Mockup mode state ---
  const [mockupMode, setMockupMode] = useState(false);
  const [mockupBg1, setMockupBg1] = useState('#667eea');
  const [mockupBg2, setMockupBg2] = useState('#764ba2');
  const [mockupGradient, setMockupGradient] = useState(true);
  const [mockupGradientDir, setMockupGradientDir] = useState('to bottom');
  const [mockupHeaderText, setMockupHeaderText] = useState('Your Amazing App');
  const [mockupHeaderColor, setMockupHeaderColor] = useState('#ffffff');
  const [mockupHeaderFont, setMockupHeaderFont] = useState('system-ui');
  const [mockupHeaderSize, setMockupHeaderSize] = useState(28);
  const [editingHeader, setEditingHeader] = useState(false);
  const mockupBtnRef = useRef<HTMLButtonElement>(null);

  // Sync local inputs when viewport changes externally (preset, rotate, resize handles)
  useEffect(() => { setDimW(String(previewViewportWidth)); setDimWValid(true); }, [previewViewportWidth]);
  useEffect(() => { setDimH(String(previewViewportHeight)); setDimHValid(true); }, [previewViewportHeight]);

  // --- Container size tracking for "Fit" zoom ---
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = iframeContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        const h = Math.round(entry.contentRect.height);
        if (w > 0 && h > 0) setContainerSize(prev => (prev && prev.w === w && prev.h === h) ? prev : { w, h });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Total dimensions including device frame bezels
  const fb = activeFrame?.bezel || { top: 0, right: 0, bottom: 0, left: 0 };
  const totalW = previewViewportWidth + fb.left + fb.right;
  const totalH = previewViewportHeight + fb.top + fb.bottom;

  // Mockup dimensions
  const mockupW = Math.round(totalW * 1.35);
  const mockupH = Math.round(totalH * 1.3);
  const fitTargetW = mockupMode && activeFrame ? mockupW : totalW;
  const fitTargetH = mockupMode && activeFrame ? mockupH : totalH;

  // Compute "fit" zoom: largest scale that fits viewport + frame + padding inside the container
  const fitZoom = useMemo(() => {
    if (!containerSize) return 100;
    const availW = containerSize.w - 60; // padding + resize handle space
    const availH = containerSize.h - 60;
    return Math.max(10, Math.floor(Math.min(availW / fitTargetW, availH / fitTargetH) * 100));
  }, [containerSize, fitTargetW, fitTargetH]);

  // previewZoom === 0 means "Fit"
  const effectiveZoom = previewZoom === 0 ? fitZoom : previewZoom;
  const scale = effectiveZoom / 100;

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
    const valid = val.trim() !== '' && !isNaN(n) && n >= MIN_VP && n <= 9999;
    if (axis === 'w') {
      setDimW(val);
      setDimWValid(valid);
      if (valid) setPreviewViewport(n, previewViewportHeight);
    } else {
      setDimH(val);
      setDimHValid(valid);
      if (valid) setPreviewViewport(previewViewportWidth, n);
    }
  };

  // Scroll-adjust helper: delta is +1 (up) or -1 (down)
  const scrollAdjust = (cur: number, delta: number, shift: boolean, min = 0, max = 9999) =>
    Math.max(min, Math.min(max, cur + delta * (shift ? 10 : 1)));

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

  // --- Reload / Home ---
  const handleReload = () => {
    canvasViewerRef.current?.sendReload();
  };

  const handleHome = () => {
    if (!activeTab) return;
    const proto = activeTab.protocol || 'http';
    const host = activeTab.headerHost;
    const port = activeTab.targetPort;
    const url = host ? `${proto}://${host}` : `${proto}://localhost:${port}`;
    canvasViewerRef.current?.sendNavigate(url);
  };

  // --- Areal screenshot ---
  const handleArealToggle = () => {
    if (arealMode) {
      // Confirm: take the cropped screenshot
      if (arealRect && arealRect.w > 0 && arealRect.h > 0) {
        const base64 = canvasViewerRef.current?.cropScreenshot(arealRect.x, arealRect.y, arealRect.w, arealRect.h);
        if (base64 && arealBtnRef.current) {
          showScreenshotActions(base64, arealBtnRef.current);
        }
      }
      setArealMode(false);
      setArealRect(null);
    } else {
      setArealMode(true);
      setArealRect(null);
    }
  };

  const handleArealCancel = () => {
    setArealMode(false);
    setArealRect(null);
  };

  const handleArealInput = (field: 'x' | 'y' | 'w' | 'h', val: string) => {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 0) return;
    setArealRect(prev => {
      if (!prev) return { x: 0, y: 0, w: 0, h: 0, [field]: n };
      return { ...prev, [field]: n };
    });
  };

  // --- Framed screenshot ---
  const handleFramedScreenshot = () => {
    if (!activeFrame) return;
    const canvas = canvasViewerRef.current?.getCanvas();
    if (!canvas) return;
    const base64 = captureFramedScreenshot(canvas, activeFrame);
    if (base64 && framedBtnRef.current) {
      showScreenshotActions(base64, framedBtnRef.current);
    }
  };

  // --- Mockup screenshot ---
  const handleMockupScreenshot = () => {
    if (!activeFrame) return;
    const canvas = canvasViewerRef.current?.getCanvas();
    if (!canvas) return;
    const base64 = captureMockupScreenshot(canvas, activeFrame, {
      bg1: mockupBg1, bg2: mockupBg2, gradient: mockupGradient,
      gradientDir: mockupGradientDir, headerText: mockupHeaderText,
      headerColor: mockupHeaderColor, headerFont: mockupHeaderFont,
      headerSize: mockupHeaderSize,
    });
    if (base64 && mockupBtnRef.current) showScreenshotActions(base64, mockupBtnRef.current);
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
        quality={streamQuality}
        zoom={previewZoom}
        responsive={previewResponsive}
        active={true}
        arealMode={arealMode}
        arealRect={arealRect}
        onArealRectChange={setArealRect}
        onScreenshot={(data) => {
          if (screenshotBtnRef.current) showScreenshotActions(data, screenshotBtnRef.current);
        }}
        onScrollshot={(data) => {
          if (scrollshotBtnRef.current) showScreenshotActions(data, scrollshotBtnRef.current);
        }}
        onRecording={handleRecordingData}
        onDialogOpened={(d) => setActiveDialog(d as DialogInfo)}
        onDialogClosed={() => setActiveDialog(null)}
        onFileChooserOpened={(info) => setFileChooser(info as FileChooserInfo)}
        onDownloadStarted={(info) => setDownloads(prev => [...prev, { ...info, complete: false } as DownloadInfo])}
        onDownloadComplete={(guid) => setDownloads(prev =>
          prev.map(d => d.guid === guid ? { ...d, complete: true } : d)
        )}
        onNewTab={(info) => {
          // Navigate current page to the new tab URL
          canvasViewerRef.current?.sendNavigate(info.url);
        }}
        onSelectOpened={(info) => setSelectOverlay(info as SelectInfo)}
        onPickerOpened={(info) => setPickerOverlay(info as PickerInfo)}
        onTooltipShow={(info) => {
          if (tooltipHideTimer.current) clearTimeout(tooltipHideTimer.current);
          setTooltip(info as TooltipInfo);
        }}
        onTooltipHide={() => {
          // Debounce hide to prevent flicker between adjacent elements
          tooltipHideTimer.current = setTimeout(() => setTooltip(null), 100);
        }}
        onAuthRequired={(info) => setAuthDialog(info as AuthInfo)}
        onContextMenu={(info) => setContextMenu(info as ContextMenuInfo)}
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
            /* Sizer wrapper: has the *scaled* dimensions so flex layout/centering works correctly.
               Without this, CSS scale() doesn't affect layout and the container overflows. */
            <div
              className="preview-responsive-viewport-sizer"
              style={{
                width: Math.ceil((mockupMode && activeFrame ? mockupW : totalW) * scale),
                height: Math.ceil((mockupMode && activeFrame ? mockupH : totalH) * scale),
              }}
            >
              {mockupMode && activeFrame ? (
                <div className="preview-mockup-inner" style={{
                  width: mockupW, height: mockupH,
                  transform: scale !== 1 ? `scale(${scale})` : undefined,
                  transformOrigin: '0 0',
                  background: mockupGradient
                    ? `linear-gradient(${mockupGradientDir}, ${mockupBg1}, ${mockupBg2})`
                    : mockupBg1,
                  borderRadius: 16,
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  gap: totalH * 0.02,
                }}>
                  {editingHeader ? (
                    <input className="preview-mockup-header-input" autoFocus
                      value={mockupHeaderText}
                      onChange={e => setMockupHeaderText(e.target.value)}
                      onBlur={() => setEditingHeader(false)}
                      onKeyDown={e => { if (e.key === 'Enter') setEditingHeader(false); }}
                      style={{ color: mockupHeaderColor, fontFamily: mockupHeaderFont,
                        fontSize: mockupHeaderSize * (previewViewportWidth / 390), fontWeight: 700 }}
                    />
                  ) : (
                    <div className="preview-mockup-header" onClick={() => setEditingHeader(true)}
                      style={{ color: mockupHeaderColor, fontFamily: mockupHeaderFont,
                        fontSize: mockupHeaderSize * (previewViewportWidth / 390), fontWeight: 700 }}>
                      {mockupHeaderText}
                    </div>
                  )}
                  <DeviceFrame frame={activeFrame} viewportWidth={previewViewportWidth}
                    viewportHeight={previewViewportHeight} scale={1}>
                    <div className="preview-responsive-viewport" ref={viewportRef}
                      style={{ width: previewViewportWidth, height: previewViewportHeight }}>
                      {renderCanvasViewer()}
                    </div>
                  </DeviceFrame>
                </div>
              ) : activeFrame ? (
                <DeviceFrame frame={activeFrame} viewportWidth={previewViewportWidth} viewportHeight={previewViewportHeight} scale={scale}>
                  <div
                    className="preview-responsive-viewport"
                    ref={viewportRef}
                    style={{ width: previewViewportWidth, height: previewViewportHeight }}
                  >
                    {renderCanvasViewer()}
                  </div>
                </DeviceFrame>
              ) : (
                <div
                  className="preview-responsive-viewport"
                  ref={viewportRef}
                  style={{
                    width: previewViewportWidth,
                    height: previewViewportHeight,
                    transform: scale !== 1 ? `scale(${scale})` : undefined,
                    transformOrigin: '0 0',
                  }}
                >
                  {renderCanvasViewer()}
                </div>
              )}
              {dragging && <div className="preview-drag-overlay" />}
              <div className="preview-resize-handle preview-resize-handle-n" onMouseDown={handleResizeStart('n')} />
              <div className="preview-resize-handle preview-resize-handle-s" onMouseDown={handleResizeStart('s')} />
              <div className="preview-resize-handle preview-resize-handle-e" onMouseDown={handleResizeStart('e')} />
              <div className="preview-resize-handle preview-resize-handle-w" onMouseDown={handleResizeStart('w')} />
              <div className="preview-resize-handle preview-resize-handle-nw" onMouseDown={handleResizeStart('nw')} />
              <div className="preview-resize-handle preview-resize-handle-ne" onMouseDown={handleResizeStart('ne')} />
              <div className="preview-resize-handle preview-resize-handle-sw" onMouseDown={handleResizeStart('sw')} />
              <div className="preview-resize-handle preview-resize-handle-se" onMouseDown={handleResizeStart('se')} />
              <div className="preview-viewport-dims">{previewViewportWidth} x {previewViewportHeight} {effectiveZoom !== 100 && `(${effectiveZoom}%)`}</div>
            </div>
          ) : isConnected ? (
            renderCanvasViewer()
          ) : null}
          {/* CDP interception overlays */}
          {activeDialog && (
            <DialogModal
              dialog={activeDialog}
              onRespond={(dialogId, accept, promptText) => {
                canvasViewerRef.current?.sendDialogResponse(dialogId, accept, promptText);
                setActiveDialog(null);
              }}
            />
          )}
          {fileChooser && activeProjectId && activeTab && (
            <FileChooserModal
              info={fileChooser}
              projectId={activeProjectId}
              tabId={activeTab.id}
              onDone={() => setFileChooser(null)}
            />
          )}
          {downloads.length > 0 && activeProjectId && activeTab && (
            <div className="preview-download-bar">
              {downloads.map(dl => (
                <DownloadNotification
                  key={dl.guid}
                  download={dl}
                  projectId={activeProjectId}
                  tabId={activeTab.id}
                  onDismiss={() => setDownloads(prev => prev.filter(d => d.guid !== dl.guid))}
                />
              ))}
            </div>
          )}
          {/* Shadow overlay components */}
          {selectOverlay && (
            <SelectDropdownOverlay
              info={selectOverlay}
              canvasRef={canvasViewerRef.current?.getCanvas ? { current: canvasViewerRef.current.getCanvas() } : { current: null }}
              onSelect={(selectorPath, value) => {
                canvasViewerRef.current?.sendSelectResponse(selectorPath, value);
                setSelectOverlay(null);
              }}
              onDismiss={() => setSelectOverlay(null)}
            />
          )}
          {pickerOverlay && (
            <PickerOverlay
              info={pickerOverlay}
              canvasRef={canvasViewerRef.current?.getCanvas ? { current: canvasViewerRef.current.getCanvas() } : { current: null }}
              onSelect={(selectorPath, value, inputType) => {
                canvasViewerRef.current?.sendPickerResponse(selectorPath, value, inputType);
                setPickerOverlay(null);
              }}
              onDismiss={() => setPickerOverlay(null)}
            />
          )}
          {tooltip && (
            <TooltipOverlay
              info={tooltip}
              canvasRef={canvasViewerRef.current?.getCanvas ? { current: canvasViewerRef.current.getCanvas() } : { current: null }}
            />
          )}
          {authDialog && (
            <AuthModal
              info={authDialog}
              onSubmit={(requestId, username, password) => {
                canvasViewerRef.current?.sendAuthResponse(requestId, username, password);
                setAuthDialog(null);
              }}
              onCancel={(requestId) => {
                canvasViewerRef.current?.sendAuthCancel(requestId);
                setAuthDialog(null);
              }}
            />
          )}
          {contextMenu && (
            <ContextMenuOverlay
              info={contextMenu}
              canvasRef={canvasViewerRef.current?.getCanvas ? { current: canvasViewerRef.current.getCanvas() } : { current: null }}
              onAction={(action, params) => {
                canvasViewerRef.current?.sendContextMenuAction(action, params);
              }}
              onDismiss={() => setContextMenu(null)}
            />
          )}
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
            onClick={() => {
              if (!previewResponsive) setPreviewZoom(0);
              setPreviewResponsive(!previewResponsive);
            }}
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
              <span className="preview-dim-group">
                <ScrollInput
                  className={`preview-dim-input ${!dimWValid ? 'invalid' : ''}`}
                  type="text"
                  inputMode="numeric"
                  value={dimW}
                  onChange={(e) => handleDimInput('w', e.target.value)}
                  onScroll={(d, s) => handleDimInput('w', String(scrollAdjust(previewViewportWidth, d, s, MIN_VP)))}
                />
                {!dimWValid && <span className="preview-dim-warn" title={`Min ${MIN_VP}, max 9999`}>⚠</span>}
              </span>
              <span className="preview-dim-separator">x</span>
              <span className="preview-dim-group">
                <ScrollInput
                  className={`preview-dim-input ${!dimHValid ? 'invalid' : ''}`}
                  type="text"
                  inputMode="numeric"
                  value={dimH}
                  onChange={(e) => handleDimInput('h', e.target.value)}
                  onScroll={(d, s) => handleDimInput('h', String(scrollAdjust(previewViewportHeight, d, s, MIN_VP)))}
                />
                {!dimHValid && <span className="preview-dim-warn" title={`Min ${MIN_VP}, max 9999`}>⚠</span>}
              </span>
              <button className="preview-rotate-btn" onClick={handleRotate} title="Rotate (swap dimensions)">⟳</button>
              <span className="preview-dim-separator">|</span>
              <select
                className="preview-zoom-select"
                value={previewZoom}
                onChange={(e) => setPreviewZoom(Number(e.target.value))}
                title="Zoom level"
              >
                <option value={0}>Fit{previewZoom === 0 ? ` (${fitZoom}%)` : ''}</option>
                <option value={25}>25%</option>
                <option value={50}>50%</option>
                <option value={75}>75%</option>
                <option value={100}>100%</option>
                <option value={125}>125%</option>
                <option value={150}>150%</option>
              </select>
              <span className="preview-dim-separator">|</span>
              <select
                className="preview-frame-select"
                value={deviceFrameId}
                onChange={(e) => setDeviceFrameId(e.target.value)}
                title="Device frame"
              >
                <option value="none">No frame</option>
                {DEVICE_FRAMES.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              {activeFrame && (
                <button className={`preview-screenshot-btn ${mockupMode ? 'active' : ''}`}
                  onClick={() => setMockupMode(!mockupMode)} title="Mockup mode">🖼</button>
              )}
            </>
          )}
          <span style={{ flex: 1 }} />
          {/* Areal screenshot controls */}
          {isConnected && arealMode && (
            <>
              <button
                className="preview-screenshot-btn"
                onClick={handleArealCancel}
                title="Cancel areal screenshot"
              >✕</button>
              <span className="preview-areal-inputs">
                <label>X<ScrollInput type="text" inputMode="numeric" value={arealRect?.x ?? ''} onChange={(e) => handleArealInput('x', e.target.value)} onScroll={(d, s) => handleArealInput('x', String(scrollAdjust(arealRect?.x ?? 0, d, s)))} /></label>
                <label>Y<ScrollInput type="text" inputMode="numeric" value={arealRect?.y ?? ''} onChange={(e) => handleArealInput('y', e.target.value)} onScroll={(d, s) => handleArealInput('y', String(scrollAdjust(arealRect?.y ?? 0, d, s)))} /></label>
                <label>W<ScrollInput type="text" inputMode="numeric" value={arealRect?.w ?? ''} onChange={(e) => handleArealInput('w', e.target.value)} onScroll={(d, s) => handleArealInput('w', String(scrollAdjust(arealRect?.w ?? 0, d, s)))} /></label>
                <label>H<ScrollInput type="text" inputMode="numeric" value={arealRect?.h ?? ''} onChange={(e) => handleArealInput('h', e.target.value)} onScroll={(d, s) => handleArealInput('h', String(scrollAdjust(arealRect?.h ?? 0, d, s)))} /></label>
              </span>
            </>
          )}
          {isConnected && (
            <button
              ref={arealBtnRef}
              className={`preview-screenshot-btn ${arealMode ? 'active' : ''}`}
              onClick={handleArealToggle}
              title={arealMode ? 'Confirm areal screenshot' : 'Areal screenshot'}
            >{arealMode ? '✓' : '✂'}</button>
          )}
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
          {isConnected && activeFrame && (
            <button
              ref={framedBtnRef}
              className="preview-screenshot-btn"
              onClick={handleFramedScreenshot}
              title="Screenshot with device frame"
            >📱</button>
          )}
          {isConnected && mockupMode && activeFrame && (
            <button
              ref={mockupBtnRef}
              className="preview-screenshot-btn"
              onClick={handleMockupScreenshot}
              title="Mockup screenshot"
            >🖼</button>
          )}
          {isConnected && (
            <select
              className="preview-quality-select"
              value={streamQuality}
              onChange={e => setStreamQuality(Number(e.target.value))}
              title="Stream quality"
            >
              <option value={30}>Low</option>
              <option value={60}>Medium</option>
              <option value={85}>High</option>
              <option value={100}>Lossless</option>
            </select>
          )}
          {isConnected && (
            <button
              className={`preview-devtools-toggle ${devtoolsVisible ? 'active' : ''}`}
              onClick={() => setDevtoolsVisible(!devtoolsVisible)}
              title="Toggle DevTools"
            >DevTools</button>
          )}
        </div>
        {/* Mockup settings toolbar */}
        {mockupMode && activeFrame && (
          <div className="preview-mockup-toolbar">
            <label>BG <input type="color" value={mockupBg1} onChange={e => setMockupBg1(e.target.value)} /></label>
            <label><input type="checkbox" checked={mockupGradient} onChange={e => setMockupGradient(e.target.checked)} /> Gradient</label>
            {mockupGradient && (
              <>
                <input type="color" value={mockupBg2} onChange={e => setMockupBg2(e.target.value)} />
                <select value={mockupGradientDir} onChange={e => setMockupGradientDir(e.target.value)}>
                  <option value="to bottom">↓</option>
                  <option value="to top">↑</option>
                  <option value="to right">→</option>
                  <option value="135deg">↘</option>
                  <option value="45deg">↗</option>
                </select>
              </>
            )}
            <span className="preview-dim-separator">|</span>
            <label>Text <input type="color" value={mockupHeaderColor} onChange={e => setMockupHeaderColor(e.target.value)} /></label>
            <select value={mockupHeaderFont} onChange={e => setMockupHeaderFont(e.target.value)}>
              <option value="system-ui">Sans-serif</option>
              <option value="Georgia, serif">Serif</option>
            </select>
            <ScrollInput className="preview-mockup-size-input" type="text" inputMode="numeric"
              value={String(mockupHeaderSize)}
              onChange={e => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n > 0) setMockupHeaderSize(n); }}
              onScroll={(d, s) => setMockupHeaderSize(Math.max(10, Math.min(72, mockupHeaderSize + d * (s ? 4 : 1))))}
            />
          </div>
        )}
        {/* Connection bar — always shown */}
        <ConnectionBar
          tab={activeTab || { id: '' }}
          tabIdx={previewActiveIdx}
          onReload={handleReload}
          onHome={handleHome}
        />
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
