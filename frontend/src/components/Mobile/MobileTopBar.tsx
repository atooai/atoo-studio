import React from 'react';
import { useStore } from '../../state/store';
import { useAuthStore } from '../../state/auth-store';

export function MobileTopBar() {
  const { mobileDrawerOpen, setMobileDrawerOpen, projects } = useStore();

  const attention = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'waiting').length, 0);

  return (
    <div className="mobile-topbar">
      <div className="mobile-topbar-left">
        <button
          className={`mobile-hamburger ${mobileDrawerOpen ? 'active' : ''}`}
          onClick={() => setMobileDrawerOpen(!mobileDrawerOpen)}
        >
          <span></span><span></span><span></span>
        </button>
        <div className="mobile-logo">
          <img className="mobile-logo-icon" src="/logo_64x64.png" alt="" />
          <div>
            <div className="mobile-logo-text">
              <span className="mobile-logo-a">A</span>too Studio
            </div>
            <div className="mobile-logo-sub">ADE</div>
          </div>
        </div>
      </div>
      <div className="mobile-topbar-right">
        <button className="mobile-topbar-btn" onClick={() => useStore.getState().setModal({ type: 'container-manager' })}>
          <span>&#x229e;</span>
        </button>
        <button className="mobile-topbar-btn" style={{ position: 'relative' }}>
          <span>&#x1f514;</span>
          {attention > 0 && <span className="mobile-badge">{attention}</span>}
        </button>
        <MobileAvatar />
      </div>
    </div>
  );
}

function MobileAvatar() {
  const { user } = useAuthStore();
  const initial = user ? (user.display_name || user.username).charAt(0).toUpperCase() : 'U';

  return (
    <div className="mobile-avatar" onClick={() => useStore.getState().setMobileDrawerOpen(true)}>
      <span>{initial}</span>
    </div>
  );
}
