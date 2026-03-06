import React from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';

function getProjectStatus(proj: any): string {
  if (proj.sessions.some((s: any) => s.status === 'waiting')) return 'waiting';
  if (proj.sessions.some((s: any) => s.status === 'running')) return 'running';
  return 'idle';
}

export function Sidebar() {
  const {
    projects, activeProjectId, sidebarCollapsed,
    setSidebarCollapsed, addToast,
  } = useStore();

  const attention = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'waiting').length, 0);
  const active = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'running' || s.status === 'waiting').length, 0);
  const openChats = projects.reduce((n, p) => n + p.sessions.filter(s => s.status !== 'ended').length, 0);

  return (
    <div id="sidebar" className={sidebarCollapsed ? 'collapsed' : ''}>
      <div className="sidebar-header">
        <div>
          <div className="sidebar-logo">VCC</div>
          <div className="sidebar-logo-sub">Command Center</div>
        </div>
        <button className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title="Collapse sidebar">▸</button>
      </div>
      <div className="global-status">
        <StatusChip type="needs-attention" count={attention} label="Attention" filter="attention" />
        <StatusChip type="active" count={active} label="Active" filter="active" />
        <StatusChip type="open-chats" count={openChats} label="Open Chats" filter="chats" />
      </div>
      <div className="project-list-header">
        <span className="project-list-title">Projects</span>
        <AddMenu />
      </div>
      <div className="project-list" id="project-list">
        {projects.map(p => {
          const status = getProjectStatus(p);
          const isActive = p.id === activeProjectId;
          const initials = p.name.substring(0, 2).toUpperCase();
          const waitingCount = p.sessions.filter(s => s.status === 'waiting').length;
          const activeCount = p.sessions.filter(s => s.status === 'running' || s.status === 'waiting').length;
          const openCh = p.sessions.filter(s => s.status !== 'ended').length;
          const hasAttention = waitingCount > 0;

          return (
            <ProjectItem
              key={p.id}
              projectId={p.id}
              peId={p.pe_id}
              name={p.name}
              path={p.path}
              initials={initials}
              status={status}
              isActive={isActive}
              hasAttention={hasAttention}
              waitingCount={waitingCount}
              activeCount={activeCount}
              openChats={openCh}
              sshConnectionId={p.ssh_connection_id}
            />
          );
        })}
      </div>
      <div className="sidebar-collapsed-label" onClick={() => setSidebarCollapsed(false)}>Projects</div>
    </div>
  );
}

function StatusChip({ type, count, label, filter }: { type: string; count: number; label: string; filter: string }) {
  // TODO: implement filterProjects
  return (
    <div className={`status-chip ${type}`} title={`${label}`}>
      <span className="status-chip-count">{count}</span>
      <span className="status-chip-label">{label}</span>
    </div>
  );
}

function ProjectItem({ projectId, peId, name, path, initials, status, isActive, hasAttention, waitingCount, activeCount, openChats, sshConnectionId }: any) {
  return (
    <div
      className={`project-item ${isActive ? 'active' : ''} ${hasAttention ? 'has-attention' : ''}`}
      onClick={() => (window as any).selectProject(projectId, peId || '')}
      title={name}
    >
      <div className="project-square-icon">
        {sshConnectionId ? <span style={{ fontSize: '10px' }}>SSH</span> : initials}
        <span className={`project-square-notif ${status}`}></span>
      </div>
      <span className={`project-dot ${status}`}></span>
      <div className="project-info">
        <div className="project-name">{name}{sshConnectionId && <span className="ssh-badge" title="Remote (SSH)"> &#x26D3;</span>}</div>
        <div className="project-path">{path}</div>
      </div>
      <div className="project-badges">
        <span className="badge badge-attention">{waitingCount}</span>
        <span className="badge badge-active">{activeCount}</span>
        <span className="badge badge-chats">{openChats}</span>
      </div>
    </div>
  );
}

function AddMenu() {
  const [visible, setVisible] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!visible) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setVisible(false);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
    return () => document.removeEventListener('click', close);
  }, [visible]);

  return (
    <div className="project-add-dropdown" style={{ position: 'relative' }} ref={ref}>
      <button className="project-add-btn" onClick={(e) => { e.stopPropagation(); setVisible(!visible); }} title="Add project">+</button>
      <div className={`add-menu ${visible ? 'visible' : ''}`}>
        <div className="add-menu-item" onClick={() => { setVisible(false); (window as any).showNewProjectModal(); }}>
          <span className="add-menu-icon">✦</span>
          <div><div className="add-menu-label">New Project</div><div className="add-menu-desc">Create from scratch</div></div>
        </div>
        <div className="add-menu-item" onClick={() => { setVisible(false); (window as any).showOpenProjectModal(); }}>
          <span className="add-menu-icon">◫</span>
          <div><div className="add-menu-label">Open Existing</div><div className="add-menu-desc">Import a project folder</div></div>
        </div>
        <div className="add-menu-item" onClick={() => { setVisible(false); (window as any).showConnectProjectModal(); }}>
          <span className="add-menu-icon">⇄</span>
          <div><div className="add-menu-label">Connect</div><div className="add-menu-desc">From other environment</div></div>
        </div>
        <div className="add-menu-item" onClick={() => { setVisible(false); (window as any).showSshProjectModal(); }}>
          <span className="add-menu-icon">&#x26D3;</span>
          <div><div className="add-menu-label">Connect Remote (SSH)</div><div className="add-menu-desc">SSH into a remote machine</div></div>
        </div>
      </div>
    </div>
  );
}
