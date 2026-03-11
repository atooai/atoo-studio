import React, { useState } from 'react';
import { useStore } from '../../state/store';
import { ChatArea } from '../Chat/Chat';
import { SessionsPanel } from '../Sessions/Sessions';

type AgentSubView = 'list' | 'chat';

export function MobileAgents() {
  const { activeProjectId, projects, activeTabType } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  const [subView, setSubView] = useState<AgentSubView>('list');
  const [selectedSessionIdx, setSelectedSessionIdx] = useState<number | null>(null);

  if (!proj) {
    return (
      <div className="mobile-empty-state">
        <div className="mobile-empty-icon">&#x1f916;</div>
        <div className="mobile-empty-title">No project selected</div>
        <div className="mobile-empty-desc">Select a project to view agents</div>
      </div>
    );
  }

  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = selectedSessionIdx !== null ? activeSessions[selectedSessionIdx] : activeSessions[proj.activeSessionIdx || 0];

  if (subView === 'chat' && session) {
    return (
      <div className="mobile-agents-chat">
        <div className="mobile-agents-chat-header">
          <button className="mobile-back-btn" onClick={() => setSubView('list')}>&#x2190;</button>
          <div className="mobile-agents-chat-title">&#x1f916; {session.title || 'Session'}</div>
          <span className={`mobile-tag tag-${session.status === 'active' ? 'green' : session.status === 'attention' ? 'amber' : 'muted'}`}>
            {session.status}
          </span>
        </div>
        <MobileAgentModeToggle session={session} />
        <div className="mobile-agents-chat-body">
          {session.viewMode === 'tui' ? (
            <MobileTuiView session={session} />
          ) : (
            <ChatArea />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-agents">
      <div className="mobile-section-hdr">
        <span className="mobile-section-title">Active Agents</span>
        <button className="mobile-section-action" onClick={() => (window as any).newSession?.()}>+ Launch</button>
      </div>

      {activeSessions.map((s, i) => (
        <div
          key={s.id}
          className="mobile-agent-card"
          onClick={() => {
            (window as any).switchToSession?.(proj.id, i);
            setSelectedSessionIdx(i);
            setSubView('chat');
          }}
        >
          <div className="mobile-agent-card-row">
            <div className="mobile-agent-card-icon" style={{
              background: s.status === 'attention' ? 'var(--accent-amber-dim)' : 'var(--accent-green-dim)',
            }}>&#x1f916;</div>
            <div className="mobile-agent-card-body">
              <div className="mobile-agent-card-title">
                {s.title || 'Session'} <span className={`mobile-status-dot ${s.status === 'active' ? 'green' : s.status === 'attention' ? 'amber' : 'blue'}`}></span>
              </div>
              <div className="mobile-agent-card-desc">{s.lastMessage || 'No messages yet'}</div>
            </div>
            <span className="mobile-agent-card-chevron">&#x203A;</span>
          </div>
          <div className="mobile-agent-card-meta">
            <span className={`mobile-tag tag-${s.status === 'active' ? 'green' : s.status === 'attention' ? 'amber' : 'muted'}`}>{s.status}</span>
            <span className="mobile-tag tag-blue">{s.messages.length} msgs</span>
            {s.model && <span className="mobile-tag tag-purple">{s.model}</span>}
          </div>
        </div>
      ))}

      {activeSessions.length === 0 && (
        <div className="mobile-empty-state" style={{ padding: '40px 20px' }}>
          <div className="mobile-empty-icon">&#x1f916;</div>
          <div className="mobile-empty-title">No active agents</div>
          <div className="mobile-empty-desc">Launch a new session to get started</div>
        </div>
      )}

      {/* Session history from right panel */}
      <div className="mobile-section-hdr" style={{ marginTop: '16px' }}>
        <span className="mobile-section-title">Session History</span>
      </div>
      <div className="mobile-sessions-panel">
        <SessionsPanel />
      </div>
    </div>
  );
}

function MobileAgentModeToggle({ session }: { session: any }) {
  const mode = session.agentMode || 'terminal+chat';
  const hasChat = mode === 'chat' || mode === 'terminal+chat' || mode === 'terminal+chatRO';
  const hasTerminal = mode === 'terminal' || mode === 'terminal+chat' || mode === 'terminal+chatRO';

  if (!hasChat || !hasTerminal) return null;

  return (
    <div className="mobile-agent-mode-bar">
      <button
        className={`mobile-mode-btn ${session.viewMode === 'chat' ? 'active' : ''}`}
        onClick={() => (window as any).setSessionView?.('chat')}
      >Chat</button>
      <button
        className={`mobile-mode-btn ${session.viewMode === 'tui' ? 'active' : ''}`}
        onClick={() => (window as any).setSessionView?.('tui')}
      >TUI</button>
    </div>
  );
}

function MobileTuiView({ session }: { session: any }) {
  const tuiRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (tuiRef.current) {
      const tuiTermId = `tui-${session.id}`;
      (window as any).attachXterm?.(tuiTermId, session.id, tuiRef.current);
    }
  }, [session.id]);

  return <div className="mobile-tui-view" ref={tuiRef}></div>;
}
