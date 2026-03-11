import React from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';

export function StartPage() {
  const { environments } = useStore();

  return (
    <div className="start-page" id="start-page">
      <div className="start-page-inner">
        <div className="start-logo">Atoo Studio</div>
        <div className="start-subtitle">Development Environment</div>
        <div className="start-label">Select Environment</div>
        <div className="start-grid">
          {environments.map(env => (
            <div key={env.id} className="start-card" onClick={() => (window as any).navigate('/env/' + env.id)}>
              <div className="start-card-name">{env.name}</div>
              <div className="start-card-count">{env.project_count || 0} projects</div>
            </div>
          ))}
        </div>
        <button className="start-new-btn" onClick={() => (window as any).createEnvironmentFromStart()}>+ New Environment</button>
      </div>
    </div>
  );
}
