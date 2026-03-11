import React from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';
import { escapeHtml } from '../../utils';

function getProjectStatus(proj: any): string {
  if (proj.sessions.some((s: any) => s.status === 'attention')) return 'attention';
  if (proj.sessions.some((s: any) => s.status === 'active')) return 'active';
  return 'open';
}

export function Sidebar() {
  const {
    projects, activeProjectId, sidebarCollapsed,
    setSidebarCollapsed, addToast,
  } = useStore();

  const attention = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'attention').length, 0);
  const active = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'active').length, 0);
  const openChats = projects.reduce((n, p) => n + p.sessions.filter(s => s.status !== 'ended').length, 0);

  // Group projects: root projects first, then children indented under them
  const rootProjects = projects.filter(p => !p.parent_project_id);
  const childrenByParent = new Map<string, typeof projects>();
  for (const p of projects) {
    if (p.parent_project_id) {
      const children = childrenByParent.get(p.parent_project_id) || [];
      children.push(p);
      childrenByParent.set(p.parent_project_id, children);
    }
  }

  return (
    <div id="sidebar" className={sidebarCollapsed ? 'collapsed' : ''}>
      <div className="sidebar-header">
        <div>
          <div className="sidebar-logo">
            <img className="sidebar-logo-icon" src="/logo_64x64.png" alt="" />
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
                <span className="sidebar-logo-text">too Studio</span>
                <span className="sidebar-logo-badge">ADE</span>
              </div>
              <div className="sidebar-logo-sub">Agent Development Environment</div>
            </div>
          </div>
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
        {rootProjects.map(p => {
          const children = childrenByParent.get(p.id) || [];

          return (
            <React.Fragment key={p.id}>
              <ProjectItem
                project={p}
                isActive={p.id === activeProjectId}
                hasChildren={children.length > 0}
              />
              {children.map(child => (
                <ProjectItem
                  key={child.id}
                  project={child}
                  isActive={child.id === activeProjectId}
                  isChild={true}
                  hasChildren={false}
                />
              ))}
            </React.Fragment>
          );
        })}
      </div>
      <div className="sidebar-collapsed-label" onClick={() => setSidebarCollapsed(false)}>Projects</div>
    </div>
  );
}

function StatusChip({ type, count, label, filter }: { type: string; count: number; label: string; filter: string }) {
  return (
    <div className={`status-chip ${type}`} title={`${label}`}>
      <span className="status-chip-count">{count}</span>
      <span className="status-chip-label">{label}</span>
    </div>
  );
}

function ProjectItem({ project: p, isActive, isChild, hasChildren }: { project: any; isActive: boolean; isChild?: boolean; hasChildren: boolean }) {
  const { projects, setProjects, setModal, setCtxMenu, addToast } = useStore();

  const status = getProjectStatus(p);
  const attentionCount = p.sessions.filter((s: any) => s.status === 'attention').length;
  const activeCount = p.sessions.filter((s: any) => s.status === 'active').length;
  const openChats = p.sessions.filter((s: any) => s.status !== 'ended').length;
  const hasAttention = attentionCount > 0;
  const initials = p.name.substring(0, 2).toUpperCase();

  const handleClick = () => {
    (window as any).selectProject(p.id, p.pe_id || '');
  };

  const handleRemove = async () => {
    // For child projects (worktrees), remove the worktree
    if (p.parent_project_id) {
      (window as any).removeWorktree(p.id);
      return;
    }

    let linkCount = 1;
    try {
      const envs = await api('GET', `/api/projects/${p.id}/environments`);
      linkCount = Array.isArray(envs) ? envs.length : 1;
    } catch {}

    const isLastLink = linkCount <= 1;

    setModal({
      type: 'remove-project',
      props: {
        projectName: p.name,
        isLastLink,
        onRemove: async (deleteFiles: boolean) => {
          try {
            const params = isLastLink
              ? `?deleteProject=true${deleteFiles ? '&deleteFiles=true' : ''}`
              : '';
            await api('DELETE', `/api/project-links/${p.pe_id}${params}`);
            const current = useStore.getState().projects;
            setProjects(current.filter(proj => proj.id !== p.id));
            addToast(p.name, deleteFiles ? 'Project removed and files deleted' : 'Project removed', 'success');
            setModal(null);
          } catch (e: any) {
            addToast(p.name, `Failed: ${e.message}`, 'attention');
          }
        },
      },
    });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: isChild ? 'Remove Worktree' : 'Remove Project', icon: '✕', danger: true, action: handleRemove },
      ],
    });
  };

  if (isChild) {
    const dirName = p.path.split('/').pop() || p.path;
    return (
      <div
        className={`project-item worktree-sub-item ${isActive ? 'active' : ''} ${hasAttention ? 'has-attention' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`Worktree: ${p.name}\n${p.path}`}
      >
        <span className={`project-dot ${status}`}></span>
        <div className="project-info">
          <div className="project-name worktree-name">
            <span className="worktree-icon">⑂</span>
            {p.name}
          </div>
          <div className="project-path">{dirName}</div>
        </div>
        <div className="project-badges">
          <span className="badge badge-attention">{attentionCount}</span>
          <span className="badge badge-active">{activeCount}</span>
          <span className="badge badge-chats">{openChats}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`project-item ${isActive ? 'active' : ''} ${hasAttention ? 'has-attention' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={p.name}
    >
      <div className="project-square-icon">
        {p.ssh_connection_id ? <span style={{ fontSize: '10px' }}>SSH</span> : initials}
        <span className={`project-square-notif ${status}`}></span>
      </div>
      <span className={`project-dot ${status}`}></span>
      <div className="project-info">
        <div className="project-name">{p.name}{p.ssh_connection_id && <span className="ssh-badge" title="Remote (SSH)"> &#x26D3;</span>}</div>
        <div className="project-path">{p.path}</div>
      </div>
      <div className="project-badges">
        <span className="badge badge-attention">{attentionCount}</span>
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
