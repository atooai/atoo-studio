import React from 'react';
import { useStore } from '../../state/store';
import { useAuthStore } from '../../state/auth-store';

export function MobileDrawer() {
  const { mobileDrawerOpen, setMobileDrawerOpen, projects, activeProjectId, environments, activeEnvironmentId, setModal } = useStore();
  const { user, logout } = useAuthStore();

  const initial = user ? (user.display_name || user.username).charAt(0).toUpperCase() : 'U';

  return (
    <>
      <div
        className={`mobile-drawer-overlay ${mobileDrawerOpen ? 'open' : ''}`}
        onClick={() => setMobileDrawerOpen(false)}
      />
      <div className={`mobile-drawer ${mobileDrawerOpen ? 'open' : ''}`}>
        {/* User header */}
        <div className="mobile-drawer-header">
          <div className="mobile-drawer-user">
            <div className="mobile-drawer-avatar">{initial}</div>
            <div>
              <div className="mobile-drawer-name">{user?.display_name || user?.username || 'User'}</div>
              <div className="mobile-drawer-role">{user?.role || 'user'}</div>
            </div>
          </div>
        </div>

        {/* User management */}
        <div className="mobile-drawer-section">
          <div className="mobile-drawer-section-title">User Management</div>
          {user?.role === 'admin' && (
            <div className="mobile-drawer-item" onClick={() => { setMobileDrawerOpen(false); setModal({ type: 'user-management' }); }}>
              <span className="mobile-drawer-item-icon">&#x1f465;</span> Team Members
            </div>
          )}
          <div className="mobile-drawer-item" onClick={() => { setMobileDrawerOpen(false); setModal({ type: 'security-settings' }); }}>
            <span className="mobile-drawer-item-icon">&#x1f511;</span> Security Settings
          </div>
        </div>

        {/* Environments */}
        <div className="mobile-drawer-section">
          <div className="mobile-drawer-section-title">Environments</div>
          {environments.map(env => (
            <div
              key={env.id}
              className={`mobile-drawer-item ${env.id === activeEnvironmentId ? 'active' : ''}`}
              onClick={() => { setMobileDrawerOpen(false); (window as any).navigate('/env/' + env.id); }}
            >
              <span className="mobile-drawer-item-icon">&#x25C8;</span> {env.name}
              <span className="mobile-drawer-item-count">{env.project_count || 0}</span>
            </div>
          ))}
        </div>

        {/* Projects */}
        <div className="mobile-drawer-section">
          <div className="mobile-drawer-section-title">Projects</div>
          {projects.map(p => (
            <div
              key={p.id}
              className={`mobile-drawer-item ${p.id === activeProjectId ? 'active' : ''} ${p.parent_project_id ? 'nested' : ''}`}
              onClick={() => { setMobileDrawerOpen(false); (window as any).selectProject(p.id, p.pe_id || ''); }}
            >
              <span className="mobile-drawer-item-icon">{p.parent_project_id ? '\u2442' : '\u25BC'}</span> {p.name}
            </div>
          ))}
        </div>

        {/* Infrastructure */}
        <div className="mobile-drawer-section">
          <div className="mobile-drawer-section-title">Infrastructure</div>
          <div className="mobile-drawer-item" onClick={() => { setMobileDrawerOpen(false); setModal({ type: 'container-manager' }); }}>
            <span className="mobile-drawer-item-icon">&#x1f433;</span> Containers
          </div>
          <div className="mobile-drawer-item" onClick={() => { setMobileDrawerOpen(false); setModal({ type: 'forwarded-connections' }); }}>
            <span className="mobile-drawer-item-icon">&#x1f310;</span> Connections
          </div>
        </div>

        {/* Quick actions */}
        <div className="mobile-drawer-section">
          <div className="mobile-drawer-section-title">Quick Actions</div>
          <div className="mobile-drawer-item" onClick={() => { setMobileDrawerOpen(false); (window as any).togglePreviewPanel?.(); }}>
            <span className="mobile-drawer-item-icon">&#x2B12;</span> Preview
          </div>
          <div className="mobile-drawer-item mobile-drawer-danger" onClick={() => { setMobileDrawerOpen(false); logout(); }}>
            <span className="mobile-drawer-item-icon">&#x1f6AA;</span> Sign Out
          </div>
        </div>
      </div>
    </>
  );
}
