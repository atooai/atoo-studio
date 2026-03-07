import React from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';

export function TopBar() {
  const {
    activeProjectId, projects, environments, activeEnvironmentId,
    setModal, reportedServices, serialRequests,
  } = useStore();

  const proj = projects.find(p => p.id === activeProjectId);
  const projectName = proj ? proj.name : 'Overview';
  const breadcrumb = proj ? proj.path : '';

  return (
    <div id="topbar">
      <span className="topbar-project-name">{projectName}</span>
      <span className="topbar-breadcrumb">{breadcrumb}</span>
      <div className="topbar-spacer"></div>
      <div className="topbar-actions">
        <EnvSelector />
        <button className="topbar-btn" onClick={() => setModal({ type: 'forwarded-connections' })} title="View forwarded TCP services and serial devices">
          ⇌ Connections{(reportedServices.length + serialRequests.length) > 0 ? ` (${reportedServices.length + serialRequests.length})` : ''}
        </button>
        <button className="topbar-btn" onClick={() => (window as any).togglePreviewPanel()} title="Toggle app preview panel">⬒ Preview</button>
        <button className="topbar-btn" onClick={() => (window as any).newSession()} title="Start new Claude session">+ New Session</button>
        <button className="topbar-btn" onClick={() => (window as any).showOverview()}>◫ Overview</button>
      </div>
    </div>
  );
}

function EnvSelector() {
  const { environments, activeEnvironmentId } = useStore();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const activeEnv = environments.find(e => e.id === activeEnvironmentId);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <div className="env-selector" ref={ref}>
      <button className="env-selector-btn" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span className="env-selector-name">{activeEnv?.name || 'Default'}</span>
        <span className="env-selector-arrow">▾</span>
      </button>
      <div className={`env-dropdown ${open ? 'visible' : ''}`}>
        <div className="env-dropdown-list">
          {environments.map(env => (
            <div
              key={env.id}
              className={`env-dropdown-item ${env.id === activeEnvironmentId ? 'active' : ''}`}
              onClick={() => { (window as any).navigate('/vccenv/' + env.id); setOpen(false); }}
            >
              <span className="env-dropdown-icon">◈</span>
              {env.name}
              <span className="env-dropdown-count">{env.project_count || 0}</span>
            </div>
          ))}
        </div>
        <div className="env-dropdown-sep"></div>
        <div className="env-dropdown-item env-dropdown-new" onClick={() => { setOpen(false); (window as any).createEnvironmentFromDropdown(); }}>
          <span className="env-dropdown-icon">+</span> New Environment
        </div>
      </div>
    </div>
  );
}
