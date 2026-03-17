import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useStore } from '../../state/store';
import { sendStatusMessage } from '../../api/websocket';
import type { NiriPanelType, NiriColumn, NiriWindow, NiriWidthMode } from '../../types';
import { FileTree } from '../FileTree/FileTree';
import { GitHistory } from '../Git/GitHistory';
import { EditorArea } from '../Editor/Editor';
import { ChatArea } from '../Chat/Chat';
import { SessionsPanel } from '../Sessions/Sessions';
import { IssuesPanel, PullsPanel, useGitHubStatus } from '../GitHub/GitHubPanel';
import { ChangesPanel } from '../Changes/ChangesPanel';
import { PreviewPanel } from '../Preview/Preview';
import { Sidebar } from '../Sidebar/Sidebar';
import { AgentTabIcon } from './AgentTabIcon';

/* ══════════════════════════════════════════════════════
   Panel type metadata
   ══════════════════════════════════════════════════════ */
const PANEL_META: Record<NiriPanelType, { label: string; icon: string }> = {
  'file-tree':     { label: 'Files',       icon: '📁' },
  'git-history':   { label: 'Git',         icon: '⎇' },
  'editor':        { label: 'Editor',      icon: '✎' },
  'agent-tui':     { label: 'Agent TUI',   icon: '▶' },
  'agent-chat':    { label: 'Agent Chat',  icon: '💬' },
  'terminal':      { label: 'Terminal',    icon: '⬛' },
  'preview':       { label: 'Preview',     icon: '⬒' },
  'sessions-list': { label: 'Sessions',    icon: '◎' },
  'issues':        { label: 'Issues',      icon: '⊙' },
  'pulls':         { label: 'Pull Requests', icon: '⤮' },
  'changes':       { label: 'Changes',     icon: '△' },
};

const WIDTH_PRESETS: NiriWidthMode[] = ['1/3', '1/2', '2/3', 'full'];

function widthModeToPixels(mode: NiriWidthMode, customPx?: number): number {
  const vw = window.innerWidth - 48; // minus toolbar width
  switch (mode) {
    case '1/3': return Math.round(vw / 3);
    case '1/2': return Math.round(vw / 2);
    case '2/3': return Math.round((vw * 2) / 3);
    case 'full': return vw;
    case 'custom': return customPx ?? Math.round(vw / 3);
  }
}

/* ══════════════════════════════════════════════════════
   Session TUI view (reuses xterm attach pattern)
   ══════════════════════════════════════════════════════ */
function NiriSessionTui({ sessionId }: { sessionId: string }) {
  const tuiRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sendStatusMessage({ type: 'session_focus', session_id: sessionId });
    return () => { sendStatusMessage({ type: 'session_blur', session_id: sessionId }); };
  }, [sessionId]);
  useEffect(() => {
    if (tuiRef.current) {
      (window as any).attachXterm(`niri-tui-${sessionId}`, sessionId, tuiRef.current);
    }
  }, [sessionId]);
  return <div className="niri-tui-view" ref={tuiRef} />;
}

/* ══════════════════════════════════════════════════════
   Terminal view
   ══════════════════════════════════════════════════════ */
function NiriTerminalView({ terminalId }: { terminalId: string }) {
  const termRef = useRef<HTMLDivElement>(null);
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  const terminal = proj?.terminals.find(t => t.id === terminalId);

  useEffect(() => {
    if (termRef.current && terminal) {
      if (terminal.shellId) {
        (window as any).attachXterm(terminal.id, terminal.shellId, termRef.current, 'shell');
      } else if (terminal.sessionId) {
        (window as any).attachXterm(terminal.id, terminal.sessionId, termRef.current, 'terminal');
      }
    }
  }, [terminal?.id]);
  return <div className="niri-terminal-view" ref={termRef} />;
}

/* ══════════════════════════════════════════════════════
   Dynamic panel renderer
   ══════════════════════════════════════════════════════ */
function DynamicPanel({ type, params }: { type: NiriPanelType; params?: Record<string, string> }) {
  const { activeProjectId } = useStore();
  const { status: ghStatus } = useGitHubStatus(activeProjectId || '');
  const defaultGhStatus = ghStatus || { available: false, owner: '', repo: '', canWrite: false };
  switch (type) {
    case 'file-tree': return <FileTree />;
    case 'git-history': return <GitHistory />;
    case 'editor': return <EditorArea />;
    case 'agent-tui': return <NiriSessionTui sessionId={params!.sessionId} />;
    case 'agent-chat': return <ChatArea />;
    case 'terminal': return <NiriTerminalView terminalId={params!.terminalId} />;
    case 'preview': return <PreviewPanel />;
    case 'sessions-list': return <SessionsPanel />;
    case 'issues': return <IssuesPanel projectId={activeProjectId || ''} ghStatus={defaultGhStatus} />;
    case 'pulls': return <PullsPanel projectId={activeProjectId || ''} ghStatus={defaultGhStatus} />;
    case 'changes': return <ChangesPanel projectId={activeProjectId || ''} />;
    default: return <div className="niri-panel-empty">Unknown panel</div>;
  }
}

/* ══════════════════════════════════════════════════════
   Drag resize hook
   ══════════════════════════════════════════════════════ */
function useNiriDrag(
  onDrag: (deltaX: number, deltaY: number) => void,
  onEnd?: () => void,
) {
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, y: e.clientY };
    document.body.classList.add('dragging');

    const onMove = (ev: MouseEvent) => {
      if (!startRef.current) return;
      const dx = ev.clientX - startRef.current.x;
      const dy = ev.clientY - startRef.current.y;
      startRef.current = { x: ev.clientX, y: ev.clientY };
      onDrag(dx, dy);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dragging');
      startRef.current = null;
      onEnd?.();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onDrag, onEnd]);

  return handleMouseDown;
}

/* ══════════════════════════════════════════════════════
   Column splitter (vertical bar between columns)
   ══════════════════════════════════════════════════════ */
function NiriColumnSplitter({ leftIdx }: { leftIdx: number }) {
  const { niriLayout, niriSetColumnWidth } = useStore();
  const leftCol = niriLayout.columns[leftIdx];
  const rightCol = niriLayout.columns[leftIdx + 1];

  const handleDrag = useCallback((dx: number) => {
    if (!leftCol || !rightCol) return;
    const leftPx = widthModeToPixels(leftCol.widthMode, leftCol.customWidthPx);
    const rightPx = widthModeToPixels(rightCol.widthMode, rightCol.customWidthPx);
    const newLeft = Math.max(150, leftPx + dx);
    const newRight = Math.max(150, rightPx - dx);
    niriSetColumnWidth(leftIdx, 'custom', newLeft);
    niriSetColumnWidth(leftIdx + 1, 'custom', newRight);
  }, [leftCol, rightCol, leftIdx, niriSetColumnWidth]);

  const onMouseDown = useNiriDrag(
    (dx) => handleDrag(dx),
  );

  return <div className="niri-col-splitter" onMouseDown={onMouseDown} />;
}

/* ══════════════════════════════════════════════════════
   Window splitter (horizontal bar between windows)
   ══════════════════════════════════════════════════════ */
function NiriWindowSplitter({ columnIdx, topWinIdx }: { columnIdx: number; topWinIdx: number }) {
  const { niriLayout, niriSetWindowHeight } = useStore();
  const col = niriLayout.columns[columnIdx];
  const colEl = useRef<HTMLElement | null>(null);

  const handleDrag = useCallback((_dx: number, dy: number) => {
    if (!col) return;
    const totalHeight = colEl.current?.parentElement?.clientHeight ?? window.innerHeight;
    const fractionDelta = dy / totalHeight;
    const wins = col.windows;
    const topFrac = wins[topWinIdx].heightFraction ?? (1 / wins.length);
    const newFrac = Math.max(0.05, Math.min(0.95, topFrac + fractionDelta));
    niriSetWindowHeight(columnIdx, topWinIdx, newFrac);
  }, [col, columnIdx, topWinIdx, niriSetWindowHeight]);

  const onMouseDown = useNiriDrag(
    (_dx, dy) => handleDrag(0, dy),
  );

  return (
    <div
      className="niri-win-splitter"
      onMouseDown={onMouseDown}
      ref={(el) => { colEl.current = el; }}
    />
  );
}

/* ══════════════════════════════════════════════════════
   Window header bar
   ══════════════════════════════════════════════════════ */
function NiriWindowHeader({
  win, columnIdx, windowIdx, isFocused,
}: {
  win: NiriWindow; columnIdx: number; windowIdx: number; isFocused: boolean;
}) {
  const {
    niriSetFocus, niriRemoveWindow, niriMoveWindow, niriAddColumn,
    niriLayout, setCtxMenu,
  } = useStore();
  const meta = PANEL_META[win.type] || { label: win.type, icon: '?' };
  const cols = niriLayout.columns;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: Array<{ label: string; icon: string; action: () => void; separator?: boolean; danger?: boolean }> = [];

    // Move to left column
    if (columnIdx > 0) {
      items.push({
        label: 'Move to left column',
        icon: '←',
        action: () => niriMoveWindow(columnIdx, windowIdx, columnIdx - 1, cols[columnIdx - 1].windows.length),
      });
    }
    // Move to right column
    if (columnIdx < cols.length - 1) {
      items.push({
        label: 'Move to right column',
        icon: '→',
        action: () => niriMoveWindow(columnIdx, windowIdx, columnIdx + 1, cols[columnIdx + 1].windows.length),
      });
    }
    // Expel to new column
    if (cols[columnIdx].windows.length > 1) {
      items.push({
        label: 'Expel to new column',
        icon: '⤮',
        action: () => {
          const newCol: NiriColumn = {
            id: 'col-' + Date.now(),
            windows: [{ ...win }],
            widthMode: '1/3',
          };
          niriRemoveWindow(columnIdx, windowIdx);
          // Use setTimeout to let the removal settle before adding
          setTimeout(() => {
            useStore.getState().niriAddColumn(columnIdx, newCol);
          }, 0);
        },
      });
    }
    items.push({ label: '', icon: '', action: () => {}, separator: true });
    items.push({
      label: 'Close',
      icon: '✕',
      danger: true,
      action: () => niriRemoveWindow(columnIdx, windowIdx),
    });

    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div
      className={`niri-win-header ${isFocused ? 'focused' : ''}`}
      onClick={() => niriSetFocus(columnIdx, windowIdx)}
      onContextMenu={handleContextMenu}
    >
      <span className="niri-win-header-icon">{meta.icon}</span>
      <span className="niri-win-header-label">{meta.label}</span>
      {win.params?.sessionId && <span className="niri-win-header-param">#{win.params.sessionId.slice(0, 6)}</span>}
      {win.params?.terminalId && <span className="niri-win-header-param">#{win.params.terminalId.slice(0, 6)}</span>}
      <span className="niri-win-header-spacer" />
      <button
        className="niri-win-header-close"
        onClick={(e) => { e.stopPropagation(); niriRemoveWindow(columnIdx, windowIdx); }}
        title="Close panel"
      >✕</button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Add panel dropdown
   ══════════════════════════════════════════════════════ */
function AddPanelButton({ afterColumnIdx }: { afterColumnIdx: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { niriAddColumn, activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const addPanel = (type: NiriPanelType, params?: Record<string, string>) => {
    const col: NiriColumn = {
      id: 'col-' + Date.now(),
      windows: [{ id: `w-${type}-${Date.now()}`, type, params }],
      widthMode: '1/3',
    };
    niriAddColumn(afterColumnIdx, col);
    setOpen(false);
  };

  const staticPanels: NiriPanelType[] = [
    'file-tree', 'git-history', 'editor', 'preview',
    'sessions-list', 'issues', 'pulls', 'changes',
  ];

  return (
    <div className="niri-add-panel" ref={ref}>
      <button className="niri-add-panel-btn" onClick={() => setOpen(!open)} title="Add column">+</button>
      {open && (
        <div className="niri-add-panel-dropdown">
          {staticPanels.map(type => (
            <button key={type} className="niri-add-panel-item" onClick={() => addPanel(type)}>
              {PANEL_META[type].icon} {PANEL_META[type].label}
            </button>
          ))}
          {/* Dynamic: active sessions */}
          {proj?.sessions.filter(s => s.status !== 'ended').map(s => (
            <button
              key={`tui-${s.id}`}
              className="niri-add-panel-item"
              onClick={() => addPanel('agent-tui', { sessionId: s.id })}
            >
              ▶ Agent: {s.metaName || s.title || s.id.slice(0, 8)}
            </button>
          ))}
          {/* Dynamic: terminals */}
          {proj?.terminals.map(t => (
            <button
              key={`term-${t.id}`}
              className="niri-add-panel-item"
              onClick={() => addPanel('terminal', { terminalId: t.id })}
            >
              ⬛ Terminal: {t.name || t.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Toolbar
   ══════════════════════════════════════════════════════ */
function NiriToolbar() {
  const {
    niriLayout, niriSetOverview, niriSetToolbarPosition,
    sidebarCollapsed, setSidebarCollapsed,
  } = useStore();
  const [sidebarOverlay, setSidebarOverlay] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sidebarOverlay) return;
    const close = (e: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        setSidebarOverlay(false);
      }
    };
    const closeEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOverlay(false);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
    document.addEventListener('keydown', closeEsc);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', closeEsc);
    };
  }, [sidebarOverlay]);

  const pos = niriLayout.toolbarPosition;
  const isHorizontal = pos === 'top' || pos === 'bottom';

  // Cycle position
  const positions: Array<'left' | 'right' | 'top' | 'bottom'> = ['left', 'right', 'top', 'bottom'];
  const nextPos = positions[(positions.indexOf(pos) + 1) % positions.length];

  return (
    <>
      <div className={`niri-toolbar niri-toolbar-${pos}`}>
        <button
          className="niri-tb-btn"
          onClick={() => setSidebarOverlay(!sidebarOverlay)}
          title="Toggle project sidebar"
        >☰</button>
        <button
          className={`niri-tb-btn ${niriLayout.overviewMode ? 'active' : ''}`}
          onClick={() => niriSetOverview(!niriLayout.overviewMode)}
          title="Toggle overview (Ctrl+Shift+O)"
        >⊡</button>
        <div className="niri-tb-sep" />
        <button
          className="niri-tb-btn"
          onClick={() => niriSetToolbarPosition(nextPos)}
          title={`Move toolbar to ${nextPos}`}
        >⇄</button>
      </div>
      {sidebarOverlay && (
        <div className={`niri-sidebar-overlay niri-sidebar-overlay-${pos}`} ref={overlayRef}>
          <Sidebar />
        </div>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════
   Overview overlay
   ══════════════════════════════════════════════════════ */
function NiriOverviewOverlay({ stripRef }: { stripRef: React.RefObject<HTMLDivElement | null> }) {
  const { niriLayout, niriSetFocus, niriSetOverview } = useStore();

  const handleColumnClick = (colIdx: number) => {
    niriSetFocus(colIdx, 0);
    niriSetOverview(false);
    // Scroll to focused column after exit
    setTimeout(() => {
      const el = stripRef.current?.children[colIdx * 2] as HTMLElement; // columns interleaved with splitters
      el?.scrollIntoView({ behavior: 'smooth', inline: 'center' });
    }, 50);
  };

  if (!niriLayout.overviewMode) return null;

  return (
    <div className="niri-overview-labels">
      {niriLayout.columns.map((col, i) => (
        <div
          key={col.id}
          className={`niri-overview-label ${i === niriLayout.focusedColumnIdx ? 'focused' : ''}`}
          onClick={() => handleColumnClick(i)}
        >
          {col.windows.map(w => PANEL_META[w.type]?.label || w.type).join(' + ')}
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Main NiriWorkspace component
   ══════════════════════════════════════════════════════ */
export function NiriWorkspace() {
  const {
    niriLayout, niriSetFocus, niriSetOverview,
    niriSetColumnWidth, niriMoveWindow, niriAddColumn,
    niriRemoveWindow, activeProjectId, projects,
  } = useStore();
  const stripRef = useRef<HTMLDivElement>(null);
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  const { columns, focusedColumnIdx, focusedWindowIdx, overviewMode } = niriLayout;

  // Calculate overview scale
  const totalWidth = columns.reduce((sum, col) => sum + widthModeToPixels(col.widthMode, col.customWidthPx), 0)
    + (columns.length - 1) * 5; // splitters
  const viewportWidth = window.innerWidth - 48;
  const overviewScale = overviewMode ? Math.min(1, viewportWidth / totalWidth) : 1;

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ignore if typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const { niriLayout } = useStore.getState();
      const { columns, focusedColumnIdx: colIdx, focusedWindowIdx: winIdx } = niriLayout;
      if (columns.length === 0) return;

      // Ctrl+Shift+O: toggle overview
      if (e.ctrlKey && e.shiftKey && e.key === 'O') {
        e.preventDefault();
        useStore.getState().niriSetOverview(!niriLayout.overviewMode);
        return;
      }

      // Alt+Arrow navigation
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === 'ArrowLeft' && colIdx > 0) {
          e.preventDefault();
          useStore.getState().niriSetFocus(colIdx - 1, 0);
          scrollToColumn(colIdx - 1);
        } else if (e.key === 'ArrowRight' && colIdx < columns.length - 1) {
          e.preventDefault();
          useStore.getState().niriSetFocus(colIdx + 1, 0);
          scrollToColumn(colIdx + 1);
        } else if (e.key === 'ArrowUp' && winIdx > 0) {
          e.preventDefault();
          useStore.getState().niriSetFocus(colIdx, winIdx - 1);
        } else if (e.key === 'ArrowDown' && winIdx < columns[colIdx].windows.length - 1) {
          e.preventDefault();
          useStore.getState().niriSetFocus(colIdx, winIdx + 1);
        }
        return;
      }

      // Alt+Shift+Arrow: consume
      if (e.altKey && e.shiftKey && !e.ctrlKey) {
        if (e.key === 'ArrowLeft' && colIdx > 0) {
          e.preventDefault();
          useStore.getState().niriMoveWindow(colIdx, winIdx, colIdx - 1, columns[colIdx - 1].windows.length);
        } else if (e.key === 'ArrowRight' && colIdx < columns.length - 1) {
          e.preventDefault();
          useStore.getState().niriMoveWindow(colIdx, winIdx, colIdx + 1, columns[colIdx + 1].windows.length);
        } else if (e.key === 'E' || e.key === 'e') {
          // Expel: only if column has multiple windows
          e.preventDefault();
          if (columns[colIdx].windows.length > 1) {
            const win = columns[colIdx].windows[winIdx];
            useStore.getState().niriRemoveWindow(colIdx, winIdx);
            setTimeout(() => {
              const newCol: NiriColumn = {
                id: 'col-' + Date.now(),
                windows: [{ ...win }],
                widthMode: '1/3',
              };
              useStore.getState().niriAddColumn(colIdx, newCol);
            }, 0);
          }
        }
        return;
      }

      // Alt+F: cycle width preset
      if (e.altKey && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        const col = columns[colIdx];
        const currentPresetIdx = WIDTH_PRESETS.indexOf(col.widthMode as any);
        const nextPresetIdx = currentPresetIdx >= 0 ? (currentPresetIdx + 1) % WIDTH_PRESETS.length : 0;
        useStore.getState().niriSetColumnWidth(colIdx, WIDTH_PRESETS[nextPresetIdx]);
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const scrollToColumn = (colIdx: number) => {
    if (!stripRef.current) return;
    // Each column is interleaved with splitters: col0, splitter, col1, splitter, col2...
    // The child index for column i is i * 2 (each column) + i splitters before it
    const children = stripRef.current.children;
    let childIdx = 0;
    for (let i = 0; i < colIdx; i++) {
      childIdx++; // column
      childIdx++; // splitter
    }
    const el = children[childIdx] as HTMLElement;
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center' });
  };

  // Scroll to focused column when focus changes
  useEffect(() => {
    if (!overviewMode) scrollToColumn(focusedColumnIdx);
  }, [focusedColumnIdx, overviewMode]);

  // Horizontal wheel scroll
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  const pos = niriLayout.toolbarPosition;

  return (
    <div
      id="workspace"
      className={`workspace layout-niri niri-toolbar-pos-${pos}`}
    >
      <NiriToolbar />
      <div className="niri-strip-container">
        <div
          className={`niri-strip ${overviewMode ? 'niri-overview' : ''}`}
          ref={stripRef}
          style={overviewMode ? {
            '--niri-overview-scale': overviewScale,
          } as React.CSSProperties : undefined}
        >
          {columns.map((col, colIdx) => (
            <React.Fragment key={col.id}>
              {colIdx > 0 && <NiriColumnSplitter leftIdx={colIdx - 1} />}
              <div
                className={`niri-column ${colIdx === focusedColumnIdx ? 'niri-column-focused' : ''}`}
                style={{ width: widthModeToPixels(col.widthMode, col.customWidthPx) }}
                onClick={() => niriSetFocus(colIdx, focusedWindowIdx < col.windows.length ? focusedWindowIdx : 0)}
              >
                {/* Column header with width preset indicator */}
                <div className="niri-col-header">
                  <span className="niri-col-header-width">{col.widthMode === 'custom' ? `${col.customWidthPx}px` : col.widthMode}</span>
                  <AddPanelButton afterColumnIdx={colIdx} />
                </div>
                {/* Windows */}
                {col.windows.map((win, winIdx) => {
                  const isFocused = colIdx === focusedColumnIdx && winIdx === focusedWindowIdx;
                  const fraction = win.heightFraction ?? (1 / col.windows.length);
                  const splitterCount = Math.max(0, col.windows.length - 1);
                  const splitterTotal = splitterCount * 5; // 5px per splitter
                  const headerHeight = 28; // niri-col-header
                  const winHeaderHeight = 24; // per window header
                  const totalWinHeaders = col.windows.length * winHeaderHeight;

                  return (
                    <React.Fragment key={win.id}>
                      {winIdx > 0 && <NiriWindowSplitter columnIdx={colIdx} topWinIdx={winIdx - 1} />}
                      <div
                        className={`niri-window-cell ${isFocused ? 'focused' : ''}`}
                        style={{
                          height: `calc((100% - ${headerHeight}px - ${totalWinHeaders}px - ${splitterTotal}px) * ${fraction})`,
                        }}
                        onClick={(e) => { e.stopPropagation(); niriSetFocus(colIdx, winIdx); }}
                      >
                        <NiriWindowHeader
                          win={win}
                          columnIdx={colIdx}
                          windowIdx={winIdx}
                          isFocused={isFocused}
                        />
                        <div className="niri-window-content">
                          <DynamicPanel type={win.type} params={win.params} />
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </React.Fragment>
          ))}
          {/* Trailing add button */}
          <div className="niri-add-column-end">
            <AddPanelButton afterColumnIdx={columns.length - 1} />
          </div>
        </div>
        {overviewMode && <NiriOverviewOverlay stripRef={stripRef} />}
      </div>
    </div>
  );
}
