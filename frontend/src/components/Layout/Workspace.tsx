import React from 'react';
import { useStore } from '../../state/store';
import { FileTree } from '../FileTree/FileTree';
import { GitHistory } from '../Git/GitHistory';
import { EditorArea } from '../Editor/Editor';
import { ChatArea } from '../Chat/Chat';
import { SessionsPanel } from '../Sessions/Sessions';
import { PreviewPanel } from '../Preview/Preview';
import { SessionLoadingOverlay } from '../Modals/SessionLoadingOverlay';

export function Workspace() {
  const { activeProjectId, projects, activeTabType, previewVisible, rightPanelCollapsed } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];

  const layoutClass = previewVisible ? 'layout-wide' : 'layout-default';
  const rpClass = rightPanelCollapsed ? 'rp-collapsed' : '';

  return (
    <div className={`workspace ${layoutClass} ${rpClass}`} id="workspace">
      {/* Left panel: file tree + git */}
      <div className="left-panel">
        <FileTree />
        <div className="lp-splitter" id="lp-splitter" onMouseDown={(e) => (window as any).startLpSplitterDrag(e.nativeEvent)}></div>
        <GitHistory />
      </div>

      <div className="panel-vsplit panel-vsplit-left" id="vsplit-left" onMouseDown={(e) => (window as any).startVSplitDrag(e.nativeEvent, 'left')}></div>

      {/* Center panel: editor + chat/terminal */}
      <div className="center-panel">
        <EditorArea />
        <div className="editor-splitter" id="editor-splitter" onMouseDown={(e) => (window as any).startEditorSplitterDrag(e.nativeEvent)}></div>
        <div className="sessions-area">
          <CenterTabs proj={proj} />
          <div className="center-content" id="center-content">
            <SessionLoadingOverlay />
            {session && activeTabType === 'session' && (
              <ViewToggle session={session} proj={proj} />
            )}
            {activeTabType === 'terminal' ? (
              <TerminalArea proj={proj} />
            ) : session?.viewMode === 'tui' ? (
              <TuiArea session={session} />
            ) : (
              <ChatArea />
            )}
          </div>
        </div>
      </div>

      <div className="panel-vsplit panel-vsplit-right" id="vsplit-right" onMouseDown={(e) => (window as any).startVSplitDrag(e.nativeEvent, 'right')}></div>

      {/* Right panel: sessions */}
      <RightPanel proj={proj} />

      {previewVisible && (
        <>
          <div className="panel-vsplit panel-vsplit-preview" id="vsplit-preview" onMouseDown={(e) => (window as any).startVSplitDrag(e.nativeEvent, 'preview')}></div>
          <PreviewPanel />
        </>
      )}
    </div>
  );
}

function CenterTabs({ proj }: { proj: any }) {
  const { activeTabType, setActiveTabType } = useStore();
  const activeSessions = proj.sessions.filter((s: any) => s.status !== 'ended');
  const terminals = proj.terminals || [];
  const isWorktreeProject = !!proj.parent_project_id;

  return (
    <div className={`center-tabs ${isWorktreeProject ? 'worktree-active' : ''}`}>
      {activeSessions.map((s: any, i: number) => {
        const isActive = activeTabType === 'session' && i === (proj.activeSessionIdx || 0);
        const warn = s.permissionMode === 'bypassPermissions' ? <span className="tab-warn" title="--dangerously-skip-permissions">⚠</span> : null;
        return (
          <div key={s.id} className={`center-tab ${isActive ? 'active' : ''}`} onClick={() => (window as any).switchToSession(proj.id, i)}>
            <span className={`tab-dot ${s.status}`}></span>
            <span>{s.title && s.title.length > 10 ? s.title.substring(0, 10) + '…' : (s.title || 'New session')}</span>{warn}
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); (window as any).closeSession(proj.id, i); }}>×</span>
          </div>
        );
      })}
      <button className="center-tab-add" onClick={() => (window as any).newSession()} title="New Claude session">+ <span className="add-label">Session</span></button>
      {terminals.length > 0 && <div className="center-tab-sep"></div>}
      {terminals.map((t: any, i: number) => {
        const isActive = activeTabType === 'terminal' && i === (proj.activeTerminalIdx || 0);
        return (
          <div key={t.id} className={`center-tab terminal-type ${isActive ? 'active' : ''}`} onClick={() => (window as any).switchToTerminal(proj.id, i)}>
            <span className="tab-term-icon">›_</span>
            <span>{t.name || 'bash'}</span>
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); (window as any).closeTerminal(proj.id, i); }}>×</span>
          </div>
        );
      })}
      <button className="center-tab-add" onClick={() => (window as any).addTerminal()} title="New terminal">+ <span className="add-label">Term</span></button>
    </div>
  );
}

function ViewToggle({ session, proj }: { session: any; proj: any }) {
  const mode = session.agentMode || 'terminal+chat';
  const hasChat = mode === 'chat' || mode === 'terminal+chat' || mode === 'terminal+chatRO';
  const hasTerminal = mode === 'terminal' || mode === 'terminal+chat' || mode === 'terminal+chatRO';
  const chatReadOnly = mode === 'terminal+chatRO';
  const hasVerbose = mode === 'terminal+chat' || mode === 'terminal+chatRO';

  return (
    <div className="session-view-toggle">
      {hasTerminal && (
        <button className={`svt-btn ${session.viewMode === 'tui' ? 'active' : ''}`} onClick={() => (window as any).setSessionView('tui')}><span className="svt-icon">›_</span> Terminal</button>
      )}
      {hasChat && (
        <button className={`svt-btn ${session.viewMode === 'chat' ? 'active' : ''}`} onClick={() => (window as any).setSessionView('chat')}>
          <span className="svt-icon">◉</span> Chat{chatReadOnly ? ' readonly' : ''}
        </button>
      )}
      <div style={{ flex: 1 }}></div>
      {hasVerbose && (
        <button className={`svt-filter-btn ${session.showVerbose !== false ? 'active' : ''}`} onClick={() => (window as any).toggleVerbose()} title="Show/hide tool calls and intermediate messages">
          <span className="svt-filter-icon">⚡</span> Verbose
        </button>
      )}
    </div>
  );
}

function TerminalArea({ proj }: { proj: any }) {
  const termRef = React.useRef<HTMLDivElement>(null);
  const terminals = proj.terminals || [];
  const termInfo = terminals[proj.activeTerminalIdx || 0];

  React.useEffect(() => {
    if (termRef.current && termInfo) {
      if (termInfo.shellId) {
        (window as any).attachXterm(termInfo.id, termInfo.shellId, termRef.current, 'shell');
      } else if (termInfo.sessionId) {
        (window as any).attachXterm(termInfo.id, termInfo.sessionId, termRef.current, 'terminal');
      }
    }
  }, [termInfo?.id]);

  return <div className="terminal-output" ref={termRef}></div>;
}

function TuiArea({ session }: { session: any }) {
  const tuiRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (tuiRef.current) {
      const tuiTermId = `tui-${session.id}`;
      (window as any).attachXterm(tuiTermId, session.id, tuiRef.current);
    }
  }, [session.id]);

  return <div className="tui-view" ref={tuiRef}></div>;
}

function RightPanel({ proj }: { proj: any }) {
  const { rightPanelCollapsed: collapsed, setRightPanelCollapsed: setCollapsed } = useStore();

  return (
    <div className={`right-panel ${collapsed ? 'collapsed' : ''}`} id="right-panel">
      <div className="rp-header">
        <span className="rp-header-title">Sessions</span>
        <button className="rp-collapse-btn" onClick={() => setCollapsed(!collapsed)} title="Collapse/expand">▸</button>
      </div>
      <SessionsPanel />
      <div className="rp-collapsed-label" onClick={() => setCollapsed(false)}>Sessions</div>
    </div>
  );
}
