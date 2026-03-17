import React, { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../state/store';
import { sendStatusMessage } from '../../api/websocket';
import { FileTree } from '../FileTree/FileTree';
import { GitHistory } from '../Git/GitHistory';
import { EditorArea } from '../Editor/Editor';
import { ChatArea } from '../Chat/Chat';
import { SessionsPanel } from '../Sessions/Sessions';
import { IssuesPanel, PullsPanel, useGitHubStatus } from '../GitHub/GitHubPanel';
import { IssueDetailPanel, IssueActionBar } from '../GitHub/IssueSessionView';
import { PreviewPanel } from '../Preview/Preview';
import { ChangesPanel } from '../Changes/ChangesPanel';
import { AgentTabIcon } from './AgentTabIcon';
import { SessionLoadingOverlay } from '../Modals/SessionLoadingOverlay';
import { useDraggableTabs } from '../../hooks/useDraggableTabs';

export function Workspace() {
  const { activeProjectId, projects, activeTabType, previewVisible, rightPanelCollapsed } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];

  // Track session focus/blur — send continuous viewing state to backend
  const contentRef = useRef<HTMLDivElement>(null);
  const prevFocusedRef = useRef<string | null>(null);
  useEffect(() => {
    const currentSessionId = (activeTabType === 'session' && session) ? session.id : null;
    const prevSessionId = prevFocusedRef.current;

    // Blur previous session if we switched away
    if (prevSessionId && prevSessionId !== currentSessionId) {
      sendStatusMessage({ type: 'session_blur', session_id: prevSessionId });
    }
    // Focus new session
    if (currentSessionId && currentSessionId !== prevSessionId) {
      sendStatusMessage({ type: 'session_focus', session_id: currentSessionId });
    }
    prevFocusedRef.current = currentSessionId;

    // On unmount, blur the current session
    return () => {
      if (prevFocusedRef.current) {
        sendStatusMessage({ type: 'session_blur', session_id: prevFocusedRef.current });
        prevFocusedRef.current = null;
      }
    };
  }, [session?.id, activeTabType, activeProjectId]);

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
          <div className="center-content" id="center-content" ref={contentRef}>
            <SessionLoadingOverlay />
            {session && activeTabType === 'session' && (
              <ViewToggle session={session} proj={proj} />
            )}
            {activeTabType === 'terminal' ? (
              <TerminalArea proj={proj} />
            ) : session?.linkedIssue && activeTabType === 'session' ? (
              <div className="issue-split-view">
                <IssueDetailPanel
                  linkedIssue={session.linkedIssue}
                  projectId={proj.id}
                  sessionId={session.id}
                />
                <IssueActionBar
                  linkedIssue={session.linkedIssue}
                  projectId={proj.id}
                  sessionId={session.id}
                />
                <div className="issue-split-divider" id="issue-split-divider" onMouseDown={(e) => (window as any).startIssueSplitDrag?.(e.nativeEvent)}></div>
                <div className="issue-split-agent">
                  {session.viewMode === 'tui' ? (
                    <TuiArea session={session} />
                  ) : (
                    <ChatArea />
                  )}
                </div>
              </div>
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
  const { activeTabType, setCtxMenu } = useStore();
  const activeSessions = proj.sessions.filter((s: any) => s.status !== 'ended');
  const terminals = proj.terminals || [];
  const isWorktreeProject = !!proj.parent_project_id;

  // Drag-and-drop reordering for sessions
  const sessionDrag = useDraggableTabs(useCallback((from: number, to: number) => {
    (window as any).reorderSessions?.(proj.id, from, to);
  }, [proj.id]));

  // Drag-and-drop reordering for terminals
  const termDrag = useDraggableTabs(useCallback((from: number, to: number) => {
    (window as any).reorderTerminals?.(proj.id, from, to);
  }, [proj.id]));

  const showSessionCtx = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const count = activeSessions.length;
    setCtxMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Close', icon: '×', action: () => (window as any).closeSession(proj.id, idx) },
        { label: 'Close All', icon: '⊗', danger: true, action: () => closeAllSessions(proj.id, activeSessions) },
        ...(count > 1 ? [
          { label: 'Close Others', icon: '⊖', action: () => closeOtherSessions(proj.id, activeSessions, idx) },
          ...(idx < count - 1 ? [{ label: 'Close to the Right', icon: '⊳', action: () => closeSessionsRight(proj.id, activeSessions, idx) }] : []),
          ...(idx > 0 ? [{ label: 'Close to the Left', icon: '⊲', action: () => closeSessionsLeft(proj.id, activeSessions, idx) }] : []),
        ] : []),
      ],
    });
  };

  const showTermCtx = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const count = terminals.length;
    setCtxMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Close', icon: '×', action: () => (window as any).closeTerminal(proj.id, idx) },
        { label: 'Close All', icon: '⊗', danger: true, action: () => closeAllTerminals(proj.id, terminals) },
        ...(count > 1 ? [
          { label: 'Close Others', icon: '⊖', action: () => closeOtherTerminals(proj.id, terminals, idx) },
          ...(idx < count - 1 ? [{ label: 'Close to the Right', icon: '⊳', action: () => closeTerminalsRight(proj.id, terminals, idx) }] : []),
          ...(idx > 0 ? [{ label: 'Close to the Left', icon: '⊲', action: () => closeTerminalsLeft(proj.id, terminals, idx) }] : []),
        ] : []),
      ],
    });
  };

  return (
    <div className={`center-tabs ${isWorktreeProject ? 'worktree-active' : ''}`}>
      {activeSessions.map((s: any, i: number) => {
        const isActive = activeTabType === 'session' && i === (proj.activeSessionIdx || 0);
        const warn = s.permissionMode === 'bypassPermissions' ? <span className="tab-warn" title="--dangerously-skip-permissions">⚠</span> : null;
        const displayName = s.metaName || s.title || 'New session';
        const truncated = displayName.length > 16 ? displayName.substring(0, 16) + '…' : displayName;
        return (
          <div
            key={s.id}
            className={`center-tab ${isActive ? 'active' : ''}`}
            onClick={() => (window as any).switchToSession(proj.id, i)}
            onContextMenu={(e) => showSessionCtx(e, i)}
            title={displayName}
            {...sessionDrag.getTabDragProps(i)}
          >
            <AgentTabIcon agentType={s.agentType} status={s.status} />
            <span>{truncated}</span>{warn}
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); (window as any).closeSession(proj.id, i); }}>×</span>
          </div>
        );
      })}
      <button className="center-tab-add" onClick={() => (window as any).newSession()} title="New Claude session">+ <span className="add-label">Agent</span></button>
      {terminals.length > 0 && <div className="center-tab-sep"></div>}
      {terminals.map((t: any, i: number) => {
        const isActive = activeTabType === 'terminal' && i === (proj.activeTerminalIdx || 0);
        return (
          <div
            key={t.id}
            className={`center-tab terminal-type ${isActive ? 'active' : ''}`}
            onClick={() => (window as any).switchToTerminal(proj.id, i)}
            onContextMenu={(e) => showTermCtx(e, i)}
            {...termDrag.getTabDragProps(i)}
          >
            <span className="tab-term-icon">›_</span>
            <span>{t.name || 'bash'}</span>
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); (window as any).closeTerminal(proj.id, i); }}>×</span>
          </div>
        );
      })}
      <button className="center-tab-add" onClick={() => (window as any).addTerminal()} title="New terminal">+ <span className="add-label">Terminal</span></button>
    </div>
  );
}

// ── Bulk close helpers ──

async function closeAllSessions(projId: string, sessions: any[]) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    await (window as any).closeSession(projId, i);
  }
}
async function closeOtherSessions(projId: string, sessions: any[], keepIdx: number) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (i !== keepIdx) await (window as any).closeSession(projId, i > keepIdx ? i : i);
  }
}
async function closeSessionsRight(projId: string, sessions: any[], fromIdx: number) {
  for (let i = sessions.length - 1; i > fromIdx; i--) {
    await (window as any).closeSession(projId, i);
  }
}
async function closeSessionsLeft(projId: string, sessions: any[], fromIdx: number) {
  for (let i = fromIdx - 1; i >= 0; i--) {
    await (window as any).closeSession(projId, i);
  }
}

async function closeAllTerminals(projId: string, terminals: any[]) {
  for (let i = terminals.length - 1; i >= 0; i--) {
    await (window as any).closeTerminal(projId, i);
  }
}
async function closeOtherTerminals(projId: string, terminals: any[], keepIdx: number) {
  for (let i = terminals.length - 1; i >= 0; i--) {
    if (i !== keepIdx) await (window as any).closeTerminal(projId, i > keepIdx ? i : i);
  }
}
async function closeTerminalsRight(projId: string, terminals: any[], fromIdx: number) {
  for (let i = terminals.length - 1; i > fromIdx; i--) {
    await (window as any).closeTerminal(projId, i);
  }
}
async function closeTerminalsLeft(projId: string, terminals: any[], fromIdx: number) {
  for (let i = fromIdx - 1; i >= 0; i--) {
    await (window as any).closeTerminal(projId, i);
  }
}

function ViewToggle({ session, proj }: { session: any; proj: any }) {
  const mode = session.agentMode || 'terminal+chat';
  const hasChat = mode === 'chat' || mode === 'terminal+chat' || mode === 'terminal+chatRO';
  const hasTerminal = mode === 'terminal' || mode === 'terminal+chat' || mode === 'terminal+chatRO';
  const chatReadOnly = mode === 'terminal+chatRO';
  const hasVerbose = mode === 'terminal+chat' || mode === 'terminal+chatRO';
  const [showDesc, setShowDesc] = React.useState(false);

  return (
    <>
      <div className="session-view-toggle">
        {hasTerminal && (
          <button className={`svt-btn ${session.viewMode === 'tui' ? 'active' : ''}`} onClick={() => (window as any).setSessionView('tui')}><span className="svt-icon">›_</span> Terminal</button>
        )}
        {hasChat && (
          <button className={`svt-btn ${session.viewMode === 'chat' ? 'active' : ''}`} onClick={() => (window as any).setSessionView('chat')}>
            <span className="svt-icon">◉</span> Chat{chatReadOnly ? ' readonly' : ''}
          </button>
        )}
        {session.linkedIssue && (
          <span className="svt-issue-badge" title={`${session.linkedIssue.type === 'pr' ? 'PR' : 'Issue'} #${session.linkedIssue.number}`}>
            #{session.linkedIssue.number} {session.linkedIssue.title.length > 30 ? session.linkedIssue.title.substring(0, 30) + '...' : session.linkedIssue.title}
          </span>
        )}
        {session.tags && session.tags.length > 0 && (
          <div className="svt-tags">
            {session.tags.map((tag: string) => (
              <span key={tag} className="svt-tag-badge">{tag}</span>
            ))}
          </div>
        )}
        <div style={{ flex: 1 }}></div>
        {hasVerbose && (
          <button className={`svt-filter-btn ${session.showVerbose !== false ? 'active' : ''}`} onClick={() => (window as any).toggleVerbose()} title="Show/hide tool calls and intermediate messages">
            <span className="svt-filter-icon">⚡</span> Verbose
          </button>
        )}
        {session.metaDescription && (
          <button
            className={`svt-filter-btn ${showDesc ? 'active' : ''}`}
            onClick={() => setShowDesc(!showDesc)}
            title="Show/hide session description"
          >
            <span className="svt-filter-icon">📋</span> Description
          </button>
        )}
        <button
          className="svt-filter-btn"
          onClick={() => (window as any).chainSession(session.id)}
          title="Continue in a new chain link (preserves full context via search)"
        >
          <span className="svt-filter-icon">⛓</span> Chain
        </button>
      </div>
      {showDesc && session.metaDescription && (
        <div className="svt-description-panel">
          <div className="svt-description-content">{session.metaDescription}</div>
        </div>
      )}
    </>
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
  const { rightPanelCollapsed: collapsed, setRightPanelCollapsed: setCollapsed, rightPanelTab, setRightPanelTab } = useStore();
  const { status: ghStatus, loading: ghLoading } = useGitHubStatus(proj.id);

  const ghAvailable = ghStatus?.available ?? false;

  // Persist tab to project settings
  const handleTabChange = (tab: 'sessions' | 'issues' | 'prs' | 'changes') => {
    setRightPanelTab(tab);
    if (proj.pe_id) {
      import('../../api').then(({ api }) => {
        api('PUT', `/api/project-links/${proj.pe_id}/settings`, { rightPanelTab: tab }).catch(() => {});
      });
    }
  };

  return (
    <div className={`right-panel ${collapsed ? 'collapsed' : ''}`} id="right-panel">
      <div className="rp-header">
        <div className="rp-tabs">
          <button
            className={`rp-tab${rightPanelTab === 'sessions' ? ' active' : ''}`}
            onClick={() => handleTabChange('sessions')}
          >
            Sessions
          </button>
          <button
            className={`rp-tab${rightPanelTab === 'issues' ? ' active' : ''}${!ghAvailable ? ' disabled' : ''}`}
            onClick={() => ghAvailable && handleTabChange('issues')}
            title={!ghAvailable ? (ghLoading ? 'Checking GitHub...' : ghStatus?.unavailableReason || 'GitHub not available') : `Issues (${ghStatus!.owner}/${ghStatus!.repo})`}
          >
            Issues
          </button>
          <button
            className={`rp-tab${rightPanelTab === 'prs' ? ' active' : ''}${!ghAvailable ? ' disabled' : ''}`}
            onClick={() => ghAvailable && handleTabChange('prs')}
            title={!ghAvailable ? (ghLoading ? 'Checking GitHub...' : ghStatus?.unavailableReason || 'GitHub not available') : `PRs (${ghStatus!.owner}/${ghStatus!.repo})`}
          >
            PRs
          </button>
          <button
            className={`rp-tab${rightPanelTab === 'changes' ? ' active' : ''}`}
            onClick={() => handleTabChange('changes')}
          >
            Changes
          </button>
        </div>
        <button className="rp-collapse-btn" onClick={() => setCollapsed(!collapsed)} title="Collapse/expand">&#x25b8;</button>
      </div>
      {rightPanelTab === 'sessions' && <SessionsPanel />}
      {rightPanelTab === 'issues' && ghStatus && <IssuesPanel projectId={proj.id} ghStatus={ghStatus} />}
      {rightPanelTab === 'prs' && ghStatus && <PullsPanel projectId={proj.id} ghStatus={ghStatus} />}
      {rightPanelTab === 'changes' && <ChangesPanel projectId={proj.id} />}
      <div className="rp-collapsed-label" onClick={() => setCollapsed(false)}>Sessions / Issues / PRs / Changes</div>
    </div>
  );
}
