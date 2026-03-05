import React from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';

export function SessionsPanel() {
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  return (
    <div className="session-list">
      {proj.sessions.map(s => (
        <div key={s.id} className={`session-item ${s.status !== 'ended' ? 'active-session' : ''}`}>
          <div className={`session-status-dot ${s.status === 'ended' ? 'ended' : s.status === 'waiting' ? 'waiting' : s.status === 'running' ? 'live' : 'ended'}`}></div>
          <div className="session-info">
            <div className="session-title">{s.title}</div>
            <div className="session-meta"><span>{s.startedAt || ''}</span><span>{s.status}</span></div>
          </div>
          {(s.status === 'ended' || s.status === 'idle') && (
            <button className="session-resume-btn" onClick={() => (window as any).resumeSession(proj.id, s.id)}>Resume</button>
          )}
        </div>
      ))}
      {(proj.historicalSessions || []).length > 0 && (
        <>
          <div className="session-history-divider">History</div>
          {(proj.historicalSessions || []).map(h => {
            const d = new Date(h.lastModified);
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            return (
              <div key={h.id} className="session-item session-historical" onClick={() => (window as any).resumeHistoricalSession(proj.id, h.id)}>
                <div className="session-status-dot ended"></div>
                <div className="session-info">
                  <div className="session-title">{escapeHtml(h.title)}</div>
                  <div className="session-meta"><span>{dateStr} {timeStr}</span><span>{h.eventCount} events</span></div>
                </div>
                <button className="session-resume-btn" onClick={(e) => { e.stopPropagation(); (window as any).resumeHistoricalSession(proj.id, h.id); }}>Resume</button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
