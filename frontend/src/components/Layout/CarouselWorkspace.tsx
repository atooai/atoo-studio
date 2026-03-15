import React, { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../state/store';
import { sendAgentCommand } from '../../api/websocket';
import { FileTree } from '../FileTree/FileTree';
import { GitHistory } from '../Git/GitHistory';
import { EditorArea } from '../Editor/Editor';
import { SessionsPanel } from '../Sessions/Sessions';
import { IssuesPanel, PullsPanel, useGitHubStatus } from '../GitHub/GitHubPanel';
import { ChangesPanel } from '../Changes/ChangesPanel';
import { PreviewPanel } from '../Preview/Preview';
import { SessionLoadingOverlay } from '../Modals/SessionLoadingOverlay';
import { AgentTabIcon } from './AgentTabIcon';

const HOVER_DELAY = 400; // ms before hover triggers scroll

/* ══════════════════════════════════════════════════════
   Debounced hover-to-scroll helper (horizontal)
   ══════════════════════════════════════════════════════ */
function useHoverScroll(containerRef: React.RefObject<HTMLElement | null>) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHover = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleChildHover = useCallback((childEl: HTMLElement) => {
    cancelHover();
    const container = containerRef.current;
    if (!container) return;

    const childRect = childEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const isClipped =
      childRect.left < containerRect.left + 20 ||
      childRect.right > containerRect.right - 20;

    if (isClipped) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        childEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }, HOVER_DELAY);
    }
  }, [containerRef, cancelHover]);

  useEffect(() => cancelHover, [cancelHover]);

  return { handleChildHover, cancelHover };
}

/* ══════════════════════════════════════════════════════
   Main Carousel Slide (horizontal)
   ══════════════════════════════════════════════════════ */
function CarouselSlide({
  id,
  className,
  children,
  label,
  onHover,
  onLeave,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
  label?: string;
  onHover?: (el: HTMLElement) => void;
  onLeave?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMouseEnter = useCallback(() => {
    if (ref.current && onHover) onHover(ref.current);
  }, [onHover]);

  return (
    <div
      ref={ref}
      className={`carousel-slide ${className || ''}`}
      data-slide={id}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
    >
      {label && <div className="carousel-slide-label">{label}</div>}
      {children}
    </div>
  );
}

/* ── Track session focus/blur for attention state management ── */
function useSessionFocusTracking(sessionId: string) {
  useEffect(() => {
    sendAgentCommand(sessionId, { action: 'session_focus' });
    return () => {
      sendAgentCommand(sessionId, { action: 'session_blur' });
    };
  }, [sessionId]);
}

/* ── Per-session TUI view ── */
function SessionTui({ session }: { session: any }) {
  const tuiRef = useRef<HTMLDivElement>(null);
  useSessionFocusTracking(session.id);

  useEffect(() => {
    if (tuiRef.current) {
      (window as any).attachXterm(`carousel-tui-${session.id}`, session.id, tuiRef.current);
    }
  }, [session.id]);

  return <div className="carousel-tui-view" ref={tuiRef}></div>;
}

/* ── Per-terminal view ── */
function TerminalView({ terminal }: { terminal: any }) {
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (termRef.current && terminal) {
      if (terminal.shellId) {
        (window as any).attachXterm(terminal.id, terminal.shellId, termRef.current, 'shell');
      } else if (terminal.sessionId) {
        (window as any).attachXterm(terminal.id, terminal.sessionId, termRef.current, 'terminal');
      }
    }
  }, [terminal?.id]);

  return <div className="carousel-terminal-view" ref={termRef}></div>;
}

/* ══════════════════════════════════════════════════════
   Vertical Carousel — shared by agents & terminals

   Layout:
     [tabs above]         ← collapsed headers for items above
     [50px peek above]    ← preview of item above the focused one
     [focused item]       ← fills remaining space
     [50px peek below]    ← preview of item below the focused one
     [tabs below]         ← collapsed headers for items below
   ══════════════════════════════════════════════════════ */
function VerticalCarousel({
  items,
  renderHeader,
  renderContent,
  onClose,
  onContextMenu,
}: {
  items: any[];
  renderHeader: (item: any, idx: number) => React.ReactNode;
  renderContent: (item: any, idx: number) => React.ReactNode;
  onClose?: (idx: number) => void;
  onContextMenu?: (idx: number, e: React.MouseEvent) => void;
}) {
  const [focusedIdx, setFocusedIdx] = React.useState(0);
  const [animDir, setAnimDir] = React.useState<'up' | 'down' | null>(null);

  const idx = Math.max(0, Math.min(focusedIdx, items.length - 1));

  const switchTo = useCallback((newIdx: number) => {
    if (newIdx === idx) return;
    setAnimDir(newIdx < idx ? 'up' : 'down');
    setFocusedIdx(newIdx);
  }, [idx]);

  // Clear animation class after transition
  useEffect(() => {
    if (animDir) {
      const t = setTimeout(() => setAnimDir(null), 250);
      return () => clearTimeout(t);
    }
  }, [animDir, idx]);

  const above = items.slice(0, idx);
  const below = items.slice(idx + 1);
  const focused = items[idx];
  const peekAbove = idx > 0 ? items[idx - 1] : null;
  const peekBelow = idx < items.length - 1 ? items[idx + 1] : null;

  return (
    <div className="vcarousel-layout">
      {/* Collapsed tabs above */}
      {above.length > (peekAbove ? 1 : 0) && (
        <div className="vcarousel-stack vcarousel-stack-top">
          {above.slice(0, peekAbove ? -1 : undefined).map((item: any, i: number) => (
            <div key={item.id} className="vcarousel-tab" onMouseEnter={() => switchTo(i)} onClick={() => switchTo(i)} onContextMenu={onContextMenu ? (e) => onContextMenu(i, e) : undefined}>
              {renderHeader(item, i)}
              {onClose && <span className="vcarousel-close" onClick={(e) => { e.stopPropagation(); onClose(i); }}>&times;</span>}
            </div>
          ))}
        </div>
      )}

      {/* 50px peek of item above */}
      {peekAbove && (
        <div
          className="vcarousel-peek vcarousel-peek-top"
          onMouseEnter={() => switchTo(idx - 1)}
          onClick={() => switchTo(idx - 1)}
        >
          <div className="vcarousel-peek-header">
            {renderHeader(peekAbove, idx - 1)}
            {onClose && <span className="vcarousel-close" onClick={(e) => { e.stopPropagation(); onClose(idx - 1); }}>&times;</span>}
          </div>
          <div className="vcarousel-peek-fade"></div>
        </div>
      )}

      {/* Focused item */}
      {focused && (
        <div className={`vcarousel-active ${animDir === 'up' ? 'vcarousel-enter-up' : animDir === 'down' ? 'vcarousel-enter-down' : ''}`} key={focused.id}>
          <div className="vcarousel-active-header" onContextMenu={onContextMenu ? (e) => onContextMenu(idx, e) : undefined}>
            {renderHeader(focused, idx)}
            {onClose && <span className="vcarousel-close" onClick={(e) => { e.stopPropagation(); onClose(idx); }}>&times;</span>}
          </div>
          {renderContent(focused, idx)}
        </div>
      )}

      {/* 50px peek of item below */}
      {peekBelow && (
        <div
          className="vcarousel-peek vcarousel-peek-bottom"
          onMouseEnter={() => switchTo(idx + 1)}
          onClick={() => switchTo(idx + 1)}
        >
          <div className="vcarousel-peek-fade"></div>
          <div className="vcarousel-peek-header">
            {renderHeader(peekBelow, idx + 1)}
            {onClose && <span className="vcarousel-close" onClick={(e) => { e.stopPropagation(); onClose(idx + 1); }}>&times;</span>}
          </div>
        </div>
      )}

      {/* Collapsed tabs below */}
      {below.length > (peekBelow ? 1 : 0) && (
        <div className="vcarousel-stack vcarousel-stack-bottom">
          {below.slice(peekBelow ? 1 : 0).map((item: any, origIdx: number) => {
            const realIdx = idx + 1 + (peekBelow ? 1 : 0) + origIdx;
            return (
              <div key={item.id} className="vcarousel-tab" onMouseEnter={() => switchTo(realIdx)} onClick={() => switchTo(realIdx)}>
                {renderHeader(item, realIdx)}
                {onClose && <span className="vcarousel-close" onClick={(e) => { e.stopPropagation(); onClose(realIdx); }}>&times;</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Sessions slide: agents (vertical carousel) | panels (fixed right)
   ══════════════════════════════════════════════════════ */
function SessionsSlide({ proj }: { proj: any }) {
  const { rightPanelTab, setRightPanelTab, setCtxMenu } = useStore();
  const { status: ghStatus } = useGitHubStatus(proj.id);
  const ghAvailable = ghStatus?.available ?? false;

  const activeSessions = proj.sessions.filter((s: any) => s.status !== 'ended');

  const showSessionCtx = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const count = activeSessions.length;
    setCtxMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Close', icon: '×', action: () => (window as any).closeSession(proj.id, idx) },
        { label: 'Close All', icon: '⊗', danger: true, action: () => { for (let i = count - 1; i >= 0; i--) (window as any).closeSession(proj.id, i); } },
        ...(count > 1 ? [
          { label: 'Close Others', icon: '⊖', action: () => { for (let i = count - 1; i >= 0; i--) { if (i !== idx) (window as any).closeSession(proj.id, i); } } },
        ] : []),
      ],
    });
  };

  return (
    <div className="carousel-sessions-layout">
      {/* Left: agent sessions */}
      <div className="carousel-agents-col">
        <div className="carousel-agents-header">
          <span className="carousel-area-title">Agent Sessions</span>
          <button className="carousel-mini-btn" onClick={() => (window as any).newSession()} title="New session">+</button>
        </div>

        {activeSessions.length === 0 ? (
          <div className="carousel-empty-state">
            <div className="carousel-empty-icon">&#x25C9;</div>
            <div className="carousel-empty-text">No active sessions</div>
            <button className="carousel-mini-btn" onClick={() => (window as any).newSession()}>Start session</button>
          </div>
        ) : activeSessions.length === 1 ? (
          <div className="carousel-single-agent">
            <div className="vcarousel-active-header" onContextMenu={(e) => showSessionCtx(e, 0)}>
              <AgentTabIcon agentType={activeSessions[0].agentType} status={activeSessions[0].status} />
              <span>{activeSessions[0].title || 'Claude Session'}</span>
              <span className="vcarousel-close" onClick={() => (window as any).closeSession(proj.id, 0)}>&times;</span>
            </div>
            <SessionTui session={activeSessions[0]} />
          </div>
        ) : (
          <VerticalCarousel
            items={activeSessions}
            onClose={(i) => (window as any).closeSession(proj.id, i)}
            onContextMenu={(i, e) => showSessionCtx(e, i)}
            renderHeader={(s, i) => (
              <>
                <AgentTabIcon agentType={s.agentType} status={s.status} />
                <span className="vcarousel-tab-title">{s.title || `Session ${i + 1}`}</span>
              </>
            )}
            renderContent={(s) => <SessionTui session={s} />}
          />
        )}
      </div>

      {/* Right: fixed Sessions/Issues/PRs panel */}
      <div className="carousel-panels-col">
        <div className="rp-header">
          <div className="rp-tabs">
            <button className={`rp-tab${rightPanelTab === 'sessions' ? ' active' : ''}`} onClick={() => setRightPanelTab('sessions')}>Sessions</button>
            <button className={`rp-tab${rightPanelTab === 'issues' ? ' active' : ''}${!ghAvailable ? ' disabled' : ''}`} onClick={() => ghAvailable && setRightPanelTab('issues')}>Issues</button>
            <button className={`rp-tab${rightPanelTab === 'prs' ? ' active' : ''}${!ghAvailable ? ' disabled' : ''}`} onClick={() => ghAvailable && setRightPanelTab('prs')}>PRs</button>
            <button className={`rp-tab${rightPanelTab === 'changes' ? ' active' : ''}`} onClick={() => setRightPanelTab('changes')}>Changes</button>
          </div>
        </div>
        {rightPanelTab === 'sessions' && <SessionsPanel />}
        {rightPanelTab === 'issues' && ghStatus && <IssuesPanel projectId={proj.id} ghStatus={ghStatus} />}
        {rightPanelTab === 'prs' && ghStatus && <PullsPanel projectId={proj.id} ghStatus={ghStatus} />}
        {rightPanelTab === 'changes' && <ChangesPanel projectId={proj.id} />}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Terminals slide (vertical carousel, same pattern)
   ══════════════════════════════════════════════════════ */
function TerminalsSlide({ proj }: { proj: any }) {
  const { setCtxMenu } = useStore();
  const terminals = proj.terminals || [];

  const showTermCtx = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const count = terminals.length;
    setCtxMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Close', icon: '×', action: () => (window as any).closeTerminal(proj.id, idx) },
        { label: 'Close All', icon: '⊗', danger: true, action: () => { for (let i = count - 1; i >= 0; i--) (window as any).closeTerminal(proj.id, i); } },
        ...(count > 1 ? [
          { label: 'Close Others', icon: '⊖', action: () => { for (let i = count - 1; i >= 0; i--) { if (i !== idx) (window as any).closeTerminal(proj.id, i); } } },
        ] : []),
      ],
    });
  };

  if (terminals.length === 0) {
    return (
      <div className="carousel-empty-state" style={{ flex: 1 }}>
        <div className="carousel-empty-icon">&#x203A;_</div>
        <div className="carousel-empty-text">No terminals</div>
        <button className="carousel-mini-btn" onClick={() => (window as any).addTerminal()}>Open terminal</button>
      </div>
    );
  }

  if (terminals.length === 1) {
    return (
      <div className="carousel-single-terminal">
        <div className="vcarousel-active-header" onContextMenu={(e) => showTermCtx(e, 0)}>
          <span className="tab-term-icon">›_</span>
          <span>{terminals[0].name || 'bash'}</span>
          <span className="vcarousel-close" onClick={() => (window as any).closeTerminal(proj.id, 0)}>&times;</span>
        </div>
        <TerminalView terminal={terminals[0]} />
      </div>
    );
  }

  return (
    <VerticalCarousel
      items={terminals}
      onClose={(i) => (window as any).closeTerminal(proj.id, i)}
      onContextMenu={(i, e) => showTermCtx(e, i)}
      renderHeader={(t, i) => (
        <>
          <span className="tab-term-icon">›_</span>
          <span className="vcarousel-tab-title">{t.name || `Terminal ${i + 1}`}</span>
        </>
      )}
      renderContent={(t) => <TerminalView terminal={t} />}
    />
  );
}

/* ══════════════════════════════════════════════════════
   Main Carousel Workspace
   ══════════════════════════════════════════════════════ */
export function CarouselWorkspace() {
  const { activeProjectId, projects, previewVisible } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  const containerRef = useRef<HTMLDivElement>(null);
  const { handleChildHover, cancelHover } = useHoverScroll(containerRef);

  return (
    <div className="workspace layout-carousel" id="workspace" ref={containerRef}>
      <SessionLoadingOverlay />

      {/* 1. Explorer + Editor (combined) */}
      <CarouselSlide id="explorer-editor" className="slide-explorer-editor" label="Explorer & Editor" onHover={handleChildHover} onLeave={cancelHover}>
        <div className="carousel-explorer-editor">
          <div className="carousel-explorer-pane">
            <FileTree />
            <div className="lp-splitter" id="lp-splitter" onMouseDown={(e) => (window as any).startLpSplitterDrag(e.nativeEvent)}></div>
            <GitHistory />
          </div>
          <div className="carousel-editor-pane">
            <EditorArea />
          </div>
        </div>
      </CarouselSlide>

      {/* 2. Agent Sessions | Sessions Panel */}
      <CarouselSlide id="sessions" className="slide-sessions" label="Sessions" onHover={handleChildHover} onLeave={cancelHover}>
        <SessionsSlide proj={proj} />
      </CarouselSlide>

      {/* 3. Bash Terminals (always visible) */}
      <CarouselSlide id="terminals" className="slide-terminals" label="Terminals" onHover={handleChildHover} onLeave={cancelHover}>
        <div className="carousel-terminals-header">
          <span className="carousel-area-title">Terminals</span>
          <button className="carousel-mini-btn" onClick={() => (window as any).addTerminal()} title="New terminal">+</button>
        </div>
        <TerminalsSlide proj={proj} />
      </CarouselSlide>

      {/* 4. App Preview */}
      {previewVisible && (
        <CarouselSlide id="preview" className="slide-preview" label="Preview" onHover={handleChildHover} onLeave={cancelHover}>
          <PreviewPanel />
        </CarouselSlide>
      )}
    </div>
  );
}
