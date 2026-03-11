import React, { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';

export function MobileDashboard() {
  const { activeProjectId, projects, reportedServices } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);

  const attention = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'waiting').length, 0);
  const running = projects.reduce((n, p) => n + p.sessions.filter(s => s.status === 'running').length, 0);
  const alive = projects.reduce((n, p) => n + p.sessions.filter(s => s.status !== 'ended').length, 0);

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

      {/* Containers */}
      <ContainerSummary />

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

      {/* Quick actions */}
      <div className="mobile-section-hdr">
        <span className="mobile-section-title">Quick Actions</span>
      </div>
      <div className="mobile-quick-actions">
        <button className="mobile-quick-btn" onClick={() => (window as any).newSession?.()}>
          + New Session
        </button>
        <button className="mobile-quick-btn" onClick={() => useStore.getState().setModal({ type: 'container-manager' })}>
          Containers
        </button>
        <button className="mobile-quick-btn" onClick={() => useStore.getState().setMobileView('agents')}>
          View Agents
        </button>
      </div>
    </div>
  );
}

function ContainerSummary() {
  const [containers, setContainers] = useState<any[]>([]);
  const [runtimes, setRuntimes] = useState<any>(null);

  useEffect(() => {
    api('GET', '/api/containers/runtimes')
      .then(data => {
        setRuntimes(data);
        const promises: Promise<any>[] = [];
        if (data.docker?.accessible) promises.push(api('GET', '/api/containers/docker/containers').catch(() => []));
        if (data.podman?.accessible) promises.push(api('GET', '/api/containers/podman/containers').catch(() => []));
        if (data.lxc?.accessible) promises.push(api('GET', '/api/containers/lxc/containers').catch(() => []));
        return Promise.all(promises);
      })
      .then(results => {
        setContainers(results.flat());
      })
      .catch(() => {});
  }, []);

  if (!runtimes || containers.length === 0) return null;

  return (
    <>
      <div className="mobile-section-hdr">
        <span className="mobile-section-title">Containers</span>
        <button className="mobile-section-action" onClick={() => useStore.getState().setModal({ type: 'container-manager' })}>View All &#x2192;</button>
      </div>
      {containers.slice(0, 5).map((c: any, i: number) => {
        const name = c.name || c.Names?.[0]?.replace(/^\//, '') || c.Id?.substring(0, 12) || `container-${i}`;
        const status = c.status || c.Status || c.State || '';
        const isRunning = status.toLowerCase().includes('running') || status.toLowerCase().includes('up');
        const image = c.image || c.Image || '';

        return (
          <div
            key={c.Id || c.name || i}
            className="mobile-list-item"
            onClick={() => useStore.getState().openMobileSheet('container', {
              runtime: c._runtime || 'docker',
              containerId: c.Id || c.name,
              containerName: name,
              image,
              status,
            })}
          >
            <div className="mobile-li-icon" style={{ background: isRunning ? 'var(--accent-green-dim)' : 'var(--accent-red-dim)' }}>
              &#x1f433;
            </div>
            <div className="mobile-li-body">
              <div className="mobile-li-title">
                {name} <span className={`mobile-status-dot ${isRunning ? 'green' : 'red'}`}></span>
              </div>
              <div className="mobile-li-sub">{image} &middot; {status}</div>
            </div>
          </div>
        );
      })}
    </>
  );
}
