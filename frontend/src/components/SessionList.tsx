import React, { useEffect, useState, useRef } from 'react';
import { fetchSessions, fetchEnvironments, createSession, browseDirs, fetchFsSessions, resumeFsSession } from '../api/client.js';
import type { SessionSummary, Environment, FsSessionMeta } from '../types/index.js';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface DirEntry {
  name: string;
  path: string;
}

function FolderPicker({ value, onChange, disabled }: {
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [current, setCurrent] = useState('');
  const [parent, setParent] = useState('');
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const browse = async (dirPath?: string) => {
    setLoading(true);
    try {
      const result = await browseDirs(dirPath);
      setDirs(result.dirs);
      setCurrent(result.current);
      setParent(result.parent);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    if (open && dirs.length === 0 && !loading) {
      browse(value || undefined);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectDir = (dirPath: string) => {
    onChange(dirPath);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div
        style={{
          ...pickerStyles.input,
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'default' : 'pointer',
        }}
        onClick={() => !disabled && setOpen(!open)}
      >
        <span style={pickerStyles.folderIcon}>&#128193;</span>
        <span style={pickerStyles.pathText}>
          {value || '~ (home)'}
        </span>
        <span style={pickerStyles.chevron}>{open ? '\u25B2' : '\u25BC'}</span>
      </div>

      {open && (
        <div style={pickerStyles.dropdown}>
          <div style={pickerStyles.currentPath}>
            {current}
          </div>
          <div style={pickerStyles.actionRow}>
            {parent !== current && (
              <div
                style={pickerStyles.dirItem}
                onClick={() => browse(parent)}
              >
                <span style={pickerStyles.dirIcon}>{'\u2190'}</span> ..
              </div>
            )}
            <div
              style={pickerStyles.selectBtn}
              onClick={() => selectDir(current)}
            >
              Select this folder
            </div>
          </div>
          <div style={pickerStyles.dirList}>
            {loading && <div style={pickerStyles.loading}>Loading...</div>}
            {!loading && dirs.length === 0 && (
              <div style={pickerStyles.loading}>No subdirectories</div>
            )}
            {!loading && dirs.map((d) => (
              <div
                key={d.path}
                style={pickerStyles.dirItem}
                onClick={() => browse(d.path)}
                onDoubleClick={() => selectDir(d.path)}
              >
                <span style={pickerStyles.dirIcon}>&#128193;</span>
                {d.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SessionList({ selectedId, onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [fsSessions, setFsSessions] = useState<FsSessionMeta[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [cwd, setCwd] = useState('');
  const [creating, setCreating] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [error, setError] = useState('');
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({});
  const [resumingUuid, setResumingUuid] = useState<string | null>(null);

  const resumingRef = useRef(false);

  const refresh = () => {
    // Skip polling while a resume or create is in progress to avoid
    // exhausting the browser's per-origin HTTP connection limit
    if (resumingRef.current) return;
    fetchSessions().then(setSessions);
    fetchEnvironments().then(setEnvironments);
    fetchFsSessions().then(setFsSessions).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  // Real-time agent status via WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/status`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'agent_status') {
          setAgentStatuses((prev) => ({ ...prev, [msg.session_id]: msg.status }));
        }
      } catch {}
    };
    return () => ws.close();
  }, []);

  const handleCreate = async () => {
    if (!newMessage.trim()) return;
    setCreating(true);
    setError('');
    try {
      const session = await createSession(newMessage.trim(), {
        skipPermissions,
        cwd: cwd || undefined,
      });
      setNewMessage('');
      refresh();
      onSelect(session.id);
    } catch (err: any) {
      setError(err.message || 'Failed to create session');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>CCProxy</h2>
        <div style={styles.envCount}>
          {environments.length} env{environments.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div style={styles.newSession}>
        <FolderPicker value={cwd} onChange={setCwd} disabled={creating} />
        <textarea
          style={styles.textarea}
          placeholder="New session message..."
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleCreate();
            }
          }}
          rows={2}
          disabled={creating}
        />
        <div style={styles.optionsRow}>
          <div
            style={{
              ...styles.switchTrack,
              background: skipPermissions ? '#f0883e' : '#21262d',
              opacity: creating ? 0.5 : 1,
            }}
            onClick={() => !creating && setSkipPermissions(!skipPermissions)}
          >
            <div
              style={{
                ...styles.switchThumb,
                transform: skipPermissions ? 'translateX(14px)' : 'translateX(0)',
              }}
            />
          </div>
          <span
            style={{ ...styles.toggleLabel, color: skipPermissions ? '#f0883e' : '#484f58' }}
            onClick={() => !creating && setSkipPermissions(!skipPermissions)}
          >
            skip permissions
          </span>
        </div>
        <button
          style={styles.createBtn}
          onClick={handleCreate}
          disabled={creating || !newMessage.trim()}
        >
          {creating ? 'Spawning CLI...' : 'Create'}
        </button>
        {error && <div style={styles.error}>{error}</div>}
      </div>

      <div style={styles.list}>
        {/* ── Active Sessions ── */}
        <div style={styles.sectionHeader}>Active Sessions</div>
        {sessions.length === 0 && (
          <div style={styles.empty}>No active sessions</div>
        )}
        {(() => {
          // Group active sessions by directory
          const groups = new Map<string, SessionSummary[]>();
          for (const s of sessions) {
            const dir = s.directory || 'Unknown';
            if (!groups.has(dir)) groups.set(dir, []);
            groups.get(dir)!.push(s);
          }

          // Build tree for sessions within a group
          const buildTree = (items: SessionSummary[]) => {
            const byId = new Map(items.map((s) => [s.id, s]));
            const children = new Map<string | null, SessionSummary[]>();
            for (const s of items) {
              const parentKey = s.parent_session_id && byId.has(s.parent_session_id) ? s.parent_session_id : null;
              if (!children.has(parentKey)) children.set(parentKey, []);
              children.get(parentKey)!.push(s);
            }
            return children;
          };

          const renderSessionItem = (s: SessionSummary, depth: number, childrenMap: Map<string | null, SessionSummary[]>) => {
            const kids = childrenMap.get(s.id) || [];
            return (
              <React.Fragment key={s.id}>
                <div
                  style={{
                    ...styles.item,
                    ...(s.id === selectedId ? styles.itemSelected : {}),
                    paddingLeft: 24 + depth * 16,
                  }}
                  onClick={() => onSelect(s.id)}
                >
                  <div style={styles.itemRow}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={styles.itemTitle}>
                        {depth > 0 && <span style={styles.treeConnector}>{'\u2514\u2500 '}</span>}
                        {s.title}
                      </div>
                      <div style={styles.itemMeta}>
                        {s.event_count} events &middot; {s.status}
                        {(s.change_count ?? 0) > 0 && <span> &middot; {s.change_count} files changed</span>}
                        {s.parent_session_id && <span style={styles.forkedLabel}> &middot; forked</span>}
                      </div>
                    </div>
                    {(agentStatuses[s.id] || s.agent_status) === 'active' && (
                      <span className="typing-dots" title="Agent is working">
                        <span className="dot" /><span className="dot" /><span className="dot" />
                      </span>
                    )}
                    {(agentStatuses[s.id] || s.agent_status) === 'waiting' && (
                      <span className="typing-dots typing-dots-waiting" title="Waiting for approval">
                        <span className="dot" /><span className="dot" /><span className="dot" />
                      </span>
                    )}
                  </div>
                </div>
                {kids.map((child) => renderSessionItem(child, depth + 1, childrenMap))}
              </React.Fragment>
            );
          };

          return Array.from(groups.entries()).map(([dir, items]) => {
            const childrenMap = buildTree(items);
            const roots = childrenMap.get(null) || [];
            return (
              <div key={`active-${dir}`}>
                <div style={styles.groupHeader}>
                  <span style={styles.groupIcon}>&#128193;</span>
                  <span style={styles.groupPath}>{dir.replace(/^\/home\/[^/]+/, '~')}</span>
                  <span style={styles.groupCount}>{items.length}</span>
                </div>
                {roots.map((s) => renderSessionItem(s, 0, childrenMap))}
              </div>
            );
          });
        })()}

        {/* ── Session History ── */}
        <div style={styles.sectionHeader}>Session History</div>
        {fsSessions.length === 0 && (
          <div style={styles.empty}>No session history</div>
        )}
        {(() => {
          // Group fs sessions by directory
          const groups = new Map<string, FsSessionMeta[]>();
          for (const fs of fsSessions) {
            const dir = fs.directory || 'Unknown';
            if (!groups.has(dir)) groups.set(dir, []);
            groups.get(dir)!.push(fs);
          }

          const handleFsClick = async (meta: FsSessionMeta) => {
            // If this session is already active, navigate to it
            const existing = sessions.find((s) => s.fs_uuid === meta.uuid);
            if (existing) {
              onSelect(existing.id);
              return;
            }
            if (resumingUuid) return;
            setResumingUuid(meta.uuid);
            resumingRef.current = true;
            try {
              const result = await resumeFsSession(meta.uuid, { skipPermissions });
              resumingRef.current = false;
              refresh();
              onSelect(result.id);
            } catch (err: any) {
              setError(err.message || 'Failed to resume session');
            } finally {
              setResumingUuid(null);
              resumingRef.current = false;
            }
          };

          return Array.from(groups.entries())
            .sort(([, a], [, b]) => {
              const latestA = Math.max(...a.map((m) => new Date(m.lastModified).getTime()));
              const latestB = Math.max(...b.map((m) => new Date(m.lastModified).getTime()));
              return latestB - latestA;
            })
            .map(([dir, items]) => {
              items.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
              return (
                <div key={`history-${dir}`}>
                  <div style={styles.groupHeader}>
                    <span style={styles.groupIcon}>&#128193;</span>
                    <span style={styles.groupPath}>{dir.replace(/^\/home\/[^/]+/, '~')}</span>
                    <span style={styles.groupCount}>{items.length}</span>
                  </div>
                  {items.map((meta) => {
                    const isResuming = resumingUuid === meta.uuid;
                    const isActive = sessions.some((s) => s.fs_uuid === meta.uuid);
                    return (
                      <div
                        key={`fs-${meta.uuid}`}
                        style={{
                          ...styles.item,
                          ...styles.fsItem,
                          ...(isResuming ? styles.fsItemResuming : {}),
                          ...(isActive ? styles.fsItemActive : {}),
                          cursor: isResuming ? 'wait' : 'pointer',
                        }}
                        onClick={() => handleFsClick(meta)}
                      >
                        <div style={styles.itemRow}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ ...styles.itemTitle, ...styles.fsItemTitle }}>
                              {meta.title}
                            </div>
                            <div style={styles.itemMeta}>
                              ~{meta.eventCount} events &middot; {new Date(meta.lastModified).toLocaleDateString()}
                              {isResuming && <span style={styles.resumingLabel}> &middot; Resuming...</span>}
                              {isActive && <span style={styles.activeLabel}> &middot; running</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            });
        })()}
      </div>
    </div>
  );
}

const pickerStyles: Record<string, React.CSSProperties> = {
  input: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: '6px 8px',
    marginBottom: 8,
    fontSize: 12,
    color: '#8b949e',
    userSelect: 'none',
  },
  folderIcon: {
    fontSize: 14,
    flexShrink: 0,
  },
  pathText: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'left',
    color: '#e6edf3',
  },
  chevron: {
    fontSize: 10,
    flexShrink: 0,
    color: '#484f58',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 100,
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    marginTop: 2,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    maxHeight: 300,
    display: 'flex',
    flexDirection: 'column',
  },
  currentPath: {
    padding: '6px 10px',
    fontSize: 11,
    color: '#8b949e',
    borderBottom: '1px solid #21262d',
    wordBreak: 'break-all',
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 6px',
    borderBottom: '1px solid #21262d',
  },
  selectBtn: {
    flex: 1,
    textAlign: 'center',
    padding: '4px 8px',
    fontSize: 11,
    color: '#58a6ff',
    cursor: 'pointer',
    borderRadius: 4,
    border: '1px solid #30363d',
  },
  dirList: {
    overflow: 'auto',
    maxHeight: 200,
  },
  dirItem: {
    padding: '5px 10px',
    fontSize: 12,
    color: '#e6edf3',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  dirIcon: {
    fontSize: 13,
    flexShrink: 0,
  },
  loading: {
    padding: '8px 10px',
    fontSize: 11,
    color: '#484f58',
  },
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 300,
    borderRight: '1px solid #30363d',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  header: {
    padding: '16px',
    borderBottom: '1px solid #30363d',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: 18, fontWeight: 600 },
  envCount: {
    fontSize: 12,
    color: '#8b949e',
    background: '#21262d',
    padding: '2px 8px',
    borderRadius: 12,
  },
  newSession: { padding: 12, borderBottom: '1px solid #30363d' },
  textarea: {
    width: '100%',
    background: '#161b22',
    color: '#e6edf3',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    resize: 'none',
    fontFamily: 'inherit',
  },
  optionsRow: {
    marginTop: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  switchTrack: {
    width: 28,
    height: 14,
    borderRadius: 7,
    cursor: 'pointer',
    position: 'relative' as const,
    transition: 'background 0.2s ease',
    flexShrink: 0,
  },
  switchThumb: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#e6edf3',
    position: 'absolute' as const,
    top: 2,
    left: 2,
    transition: 'transform 0.2s ease',
  },
  toggleLabel: {
    fontSize: 11,
    cursor: 'pointer',
    transition: 'color 0.2s ease',
    userSelect: 'none' as const,
  },
  createBtn: {
    marginTop: 8,
    width: '100%',
    padding: '6px 12px',
    background: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  error: {
    marginTop: 6,
    fontSize: 11,
    color: '#f85149',
  },
  list: { flex: 1, overflow: 'auto' },
  groupHeader: {
    padding: '8px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#0d1117',
    borderBottom: '1px solid #21262d',
    position: 'sticky' as const,
    top: 0,
    zIndex: 1,
  },
  groupIcon: {
    fontSize: 12,
    flexShrink: 0,
  },
  groupPath: {
    fontSize: 11,
    color: '#8b949e',
    fontFamily: 'monospace',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'left',
  },
  groupCount: {
    fontSize: 10,
    color: '#484f58',
    background: '#21262d',
    padding: '1px 6px',
    borderRadius: 8,
    flexShrink: 0,
  },
  item: {
    padding: '10px 16px 10px 24px',
    cursor: 'pointer',
    borderBottom: '1px solid #21262d',
  },
  itemSelected: { background: '#161b22' },
  itemRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  itemTitle: { fontSize: 14, fontWeight: 500, marginBottom: 4 },
  itemMeta: { fontSize: 12, color: '#8b949e' },
  empty: { padding: 16, color: '#8b949e', textAlign: 'center', fontSize: 13 },
  sectionHeader: {
    padding: '10px 12px 6px',
    fontSize: 11,
    fontWeight: 600,
    color: '#8b949e',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    borderBottom: '1px solid #21262d',
    background: '#0d1117',
    position: 'sticky' as const,
    top: 0,
    zIndex: 2,
  },
  fsItem: {
    opacity: 0.6,
  },
  fsItemResuming: {
    opacity: 0.8,
    background: '#161b22',
  },
  fsItemActive: {
    opacity: 0.8,
    borderLeft: '2px solid #238636',
  },
  fsItemTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  resumingLabel: {
    color: '#58a6ff',
    fontSize: 11,
  },
  activeLabel: {
    color: '#238636',
    fontSize: 11,
  },
  treeConnector: {
    color: '#484f58',
    fontFamily: 'monospace',
    fontSize: 12,
    marginRight: 2,
  },
  forkedLabel: {
    color: '#8957e5',
    fontSize: 11,
  },
};
