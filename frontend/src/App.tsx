import React, { useState, useEffect } from 'react';
import SessionList from './components/SessionList.js';
import ChatView from './components/ChatView.js';
import { fetchStatus, fetchSessions } from './api/client.js';
import type { ProxyStatus, SessionSummary } from './types/index.js';

export default function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    fetchStatus().then(setStatus);
    fetchSessions().then(setSessions);
    const interval = setInterval(() => {
      fetchStatus().then(setStatus);
      fetchSessions().then(setSessions);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const parentSession = selectedSession?.parent_session_id
    ? sessions.find((s) => s.id === selectedSession.parent_session_id)
    : null;

  return (
    <div style={styles.app}>
      <SessionList
        selectedId={selectedSessionId}
        onSelect={setSelectedSessionId}
      />
      <div style={styles.main}>
        {selectedSessionId ? (
          <ChatView
            sessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
            parentSessionId={selectedSession?.parent_session_id}
            parentTitle={parentSession?.title}
            forkAfterEventUuid={selectedSession?.fork_after_event_uuid}
          />
        ) : (
          <div style={styles.empty}>
            <h2 style={styles.emptyTitle}>CCProxy</h2>
            <p style={styles.emptyText}>
              Local proxy for Claude Code remote control.
            </p>
            {status && (
              <div style={styles.statusGrid}>
                <div style={styles.statItem}>
                  <div style={styles.statValue}>{status.environments}</div>
                  <div style={styles.statLabel}>Environments</div>
                </div>
                <div style={styles.statItem}>
                  <div style={styles.statValue}>{status.sessions}</div>
                  <div style={styles.statLabel}>Sessions</div>
                </div>
                <div style={styles.statItem}>
                  <div style={styles.statValue}>{status.active_ingress}</div>
                  <div style={styles.statLabel}>CLI Connections</div>
                </div>
                <div style={styles.statItem}>
                  <div style={styles.statValue}>{status.active_subscribers}</div>
                  <div style={styles.statLabel}>Subscribers</div>
                </div>
              </div>
            )}
            <p style={styles.hint}>
              Select a session from the sidebar, or create a new one.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    height: '100vh',
    background: '#0d1117',
    color: '#e6edf3',
  },
  main: { flex: 1, display: 'flex' },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  emptyTitle: { fontSize: 28, fontWeight: 700 },
  emptyText: { color: '#8b949e', fontSize: 14 },
  hint: { color: '#8b949e', fontSize: 13, marginTop: 24 },
  statusGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 16,
    marginTop: 16,
  },
  statItem: {
    textAlign: 'center',
    padding: 16,
    background: '#161b22',
    borderRadius: 8,
    border: '1px solid #30363d',
    minWidth: 100,
  },
  statValue: { fontSize: 24, fontWeight: 700, color: '#58a6ff' },
  statLabel: { fontSize: 12, color: '#8b949e', marginTop: 4 },
};
