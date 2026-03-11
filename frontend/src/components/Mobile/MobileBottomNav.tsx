import React from 'react';
import { useStore } from '../../state/store';

const tabs = [
  { id: 'dashboard' as const, icon: '\u25C9', label: 'Home' },
  { id: 'files' as const, icon: '\uD83D\uDCC2', label: 'Files' },
  { id: 'git' as const, icon: '\uD83C\uDF3F', label: 'Git' },
  { id: 'agents' as const, icon: '\uD83E\uDD16', label: 'Agents' },
  { id: 'terminal' as const, icon: '\u2B1B', label: 'Term' },
] as const;

export function MobileBottomNav() {
  const { mobileView, setMobileView, projects } = useStore();

  const agentCount = projects.reduce(
    (n, p) => n + p.sessions.filter(s => s.status !== 'ended').length,
    0,
  );

  return (
    <div className="mobile-bottom-nav">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`mobile-nav-item ${mobileView === tab.id ? 'active' : ''}`}
          onClick={() => setMobileView(tab.id)}
        >
          <span className="mobile-nav-icon">
            {tab.icon}
            {tab.id === 'agents' && agentCount > 0 && (
              <span className="mobile-nav-badge">{agentCount}</span>
            )}
          </span>
          <span className="mobile-nav-label">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
