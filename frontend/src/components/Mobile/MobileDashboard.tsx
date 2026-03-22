import React from 'react';
import { useStore } from '../../state/store';
import type { Project, Session } from '../../types';

export function MobileDashboard() {
  const { projects, reportedServices } = useStore();

  const attention = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'attention').length, 0);
  const running = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'active').length, 0);
  const alive = projects.reduce((n, p) => n + p.sessions.filter(s => s.status !== 'ended').length, 0);

  // Gather projects that have running (non-ended) agents
  const projectsWithAgents = projects.filter(p => p.sessions.some(s => s.status !== 'ended'));

  return (
    <div className="mobile-dashboard">
      {/* Stats */}
      <div className="mobile-stats-row">
        <div className="mobile-stat-card">
          <div className="mobile-stat-val" style={{ color: 'var(--accent-red)' }}>{attention}</div>
          <div className="mobile-stat-label">Attention</div>
        </div>
        <div className="mobile-stat-card">
          <div className="mobile-stat-val" style={{ color: 'var(--accent-green)' }}>{running}</div>
          <div className="mobile-stat-label">Running</div>
        </div>
        <div className="mobile-stat-card">
          <div className="mobile-stat-val" style={{ color: 'var(--accent-blue)' }}>{alive}</div>
          <div className="mobile-stat-label">Alive</div>
        </div>
      </div>

      {/* Running agents grouped by project */}
      {projectsWithAgents.length > 0 ? (
        projectsWithAgents.map(p => (
          <ProjectAgentGroup key={p.id} project={p} />
        ))
      ) : (
        <div className="mobile-empty-state" style={{ padding: '40px 20px' }}>
          <div className="mobile-empty-icon">&#x1f916;</div>
          <div className="mobile-empty-title">No running agents</div>
          <div className="mobile-empty-desc">Launch a new session to get started</div>
        </div>
      )}

      {/* Services / Proxy Routes */}
      {reportedServices.length > 0 && (
        <>
          <div className="mobile-section-hdr">
            <span className="mobile-section-title">Services</span>
          </div>
          {reportedServices.map(svc => (
            <div key={svc.port} className="mobile-proxy-row">
              <span className="mobile-proxy-method">{svc.protocol.toUpperCase()}</span>
              <span className="mobile-proxy-route">{svc.name || `Port ${svc.port}`}</span>
              <span className="mobile-proxy-target">:{svc.port}</span>
              <span className="mobile-status-dot green"></span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ProjectAgentGroup({ project }: { project: Project }) {
  const activeSessions = project.sessions.filter(s => s.status !== 'ended');
  const projectName = project.name || project.path.split('/').pop() || 'Project';

  const openAgent = (session: Session, idx: number) => {
    const store = useStore.getState();
    store.setActiveProjectId(project.id);
    (window as any).switchToSession?.(project.id, idx);
    store.setMobileView('agents');
  };

  return (
    <>
      <div className="mobile-section-hdr">
        <span className="mobile-section-title">{projectName}</span>
        <span className="mobile-section-count">{activeSessions.length}</span>
      </div>
      {activeSessions.map((s, i) => (
        <div
          key={s.id}
          className="mobile-agent-card"
          onClick={() => openAgent(s, i)}
        >
          <div className="mobile-agent-card-row">
            <div className="mobile-agent-card-icon" style={{
              background: s.status === 'attention' ? 'var(--accent-amber-dim)' : 'var(--accent-green-dim)',
            }}>&#x1f916;</div>
            <div className="mobile-agent-card-body">
              <div className="mobile-agent-card-title">
                {s.metaName || s.title || 'Session'} <span className={`mobile-status-dot ${s.status === 'active' ? 'green' : s.status === 'attention' ? 'amber' : 'blue'}`}></span>
              </div>
              <div className="mobile-agent-card-desc">{s.lastMessage || 'No messages yet'}</div>
            </div>
            <span className="mobile-agent-card-chevron">&#x203A;</span>
          </div>
          <div className="mobile-agent-card-meta">
            <span className={`mobile-tag tag-${s.status === 'active' ? 'green' : s.status === 'attention' ? 'amber' : 'muted'}`}>{s.status}</span>
            {s.tags?.map(t => <span key={t} className="mobile-tag tag-blue">{t}</span>)}
            {s.model && <span className="mobile-tag tag-purple">{s.model}</span>}
          </div>
        </div>
      ))}
    </>
  );
}
