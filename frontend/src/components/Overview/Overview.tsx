import React from 'react';
import { useStore } from '../../state/store';

function getProjectStatus(proj: any): string {
  if (proj.sessions.some((s: any) => s.status === 'attention')) return 'attention';
  if (proj.sessions.some((s: any) => s.status === 'active')) return 'active';
  return 'open';
}

export function Overview() {
  const { projects } = useStore();

  return (
    <div className="overview-screen" id="overview-screen">
      <div className="overview-header">
        <div className="overview-title">All Projects</div>
        <div className="overview-subtitle">Click any project to enter its workspace, or monitor everything from here.</div>
      </div>
      <div className="overview-grid">
        {projects.map(p => {
          const status = getProjectStatus(p);
          const hasAttention = p.sessions.some(s => s.status === 'attention');
          const attentionCount = p.sessions.filter(s => s.status === 'attention').length;
          const activeCount = p.sessions.filter(s => s.status === 'active').length;
          const openChats = p.sessions.filter(s => s.status !== 'ended').length;

          return (
            <div
              key={p.id}
              className={`overview-card ${hasAttention ? 'has-attention' : ''}`}
              onClick={() => (window as any).selectProject(p.id, p.pe_id || '')}
            >
              <div className="oc-header">
                <span className={`oc-dot ${status}`}></span>
                <span className="oc-name">{p.name}</span>
              </div>
              <div className="oc-path">{p.path}</div>
              <div className="oc-badges">
                <span className="badge badge-attention">{attentionCount}</span>
                <span className="badge badge-active">{activeCount}</span>
                <span className="badge badge-chats">{openChats}</span>
              </div>
              <div className="oc-sessions">
                {p.sessions.slice(0, 3).map(s => {
                  const dotClass = s.status === 'ended' ? 'ended' : s.status === 'attention' ? 'waiting' : s.status === 'active' ? 'live' : 'ended';
                  return (
                    <div key={s.id} className="oc-session-line">
                      <span className={`oc-session-dot ${dotClass}`}></span>
                      <span className="oc-session-name">{s.title}</span>
                      <span className="oc-session-time">{s.startedAt || ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
