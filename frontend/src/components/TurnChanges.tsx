import React, { useState, useEffect, useCallback } from 'react';
import { fetchChanges, fetchDiff, revertChange, revertAllChanges } from '../api/client';
import DiffViewer, { type DiffSide } from './DiffViewer';
import type { FileChange, DiffData, ChangeOperation } from '../types';

interface TurnChangesProps {
  sessionId: string;
  startTime: number;
  endTime: number;
}

const OP_LABELS: Record<ChangeOperation, string> = {
  create: 'A',
  modify: 'M',
  delete: 'D',
  rename: 'R',
};

const OP_COLORS: Record<ChangeOperation, string> = {
  create: '#2ea043',
  modify: '#d29922',
  delete: '#e5534b',
  rename: '#7aa2f7',
};

export default function TurnChanges({ sessionId, startTime, endTime }: TurnChangesProps) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [loading, setLoading] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);

  const loadChanges = useCallback(async () => {
    try {
      const data = await fetchChanges(sessionId, startTime, endTime);
      if (data.changes) {
        setChanges(data.changes);
      }
    } catch {
      // silently fail
    }
  }, [sessionId, startTime, endTime]);

  useEffect(() => {
    loadChanges();
  }, [loadChanges]);

  if (changes.length === 0) return null;

  const handleFileClick = async (change: FileChange) => {
    if (expandedFile === change.change_id) {
      setExpandedFile(null);
      setDiffData(null);
      return;
    }

    setExpandedFile(change.change_id);
    setLoading(true);
    try {
      const data = await fetchDiff(sessionId, change.change_id);
      setDiffData(data);
    } catch {
      setDiffData(null);
    }
    setLoading(false);
  };

  const handleRevert = async (e: React.MouseEvent, change: FileChange) => {
    e.stopPropagation();
    setReverting(change.change_id);
    try {
      await revertChange(sessionId, change.change_id);
      await loadChanges();
    } catch {
      // silently fail
    }
    setReverting(null);
  };

  const handleRevertAll = async () => {
    setReverting('all');
    try {
      await revertAllChanges(sessionId);
      await loadChanges();
    } catch {
      // silently fail
    }
    setReverting(null);
  };

  const shortPath = (fullPath: string) => {
    const parts = fullPath.split('/');
    // Show last 2-3 segments
    return parts.length > 3 ? `.../${parts.slice(-3).join('/')}` : fullPath;
  };

  // Collapsed state
  if (!expanded) {
    return (
      <div style={styles.collapsedContainer} onClick={() => setExpanded(true)}>
        <span style={styles.icon}>&#128193;</span>
        <span style={styles.summary}>{changes.length} file{changes.length !== 1 ? 's' : ''} changed</span>
        <span style={styles.expandBtn}>Review Changes &#9662;</span>
      </div>
    );
  }

  // Expanded state
  return (
    <div style={styles.expandedContainer}>
      <div style={styles.header}>
        <span
          style={{ ...styles.icon, cursor: 'pointer' }}
          onClick={() => setExpanded(false)}
        >&#128193;</span>
        <span
          style={{ ...styles.summary, cursor: 'pointer' }}
          onClick={() => setExpanded(false)}
        >
          {changes.length} file{changes.length !== 1 ? 's' : ''} changed &#9652;
        </span>
        <button
          onClick={handleRevertAll}
          disabled={reverting === 'all'}
          style={styles.revertAllBtn}
        >
          {reverting === 'all' ? 'Reverting...' : 'Revert All'}
        </button>
      </div>

      <div style={styles.fileList}>
        {changes.map((change) => (
          <React.Fragment key={change.change_id}>
            <div
              style={{
                ...styles.fileRow,
                background: expandedFile === change.change_id ? '#2a2a4a' : undefined,
              }}
              onClick={() => handleFileClick(change)}
            >
              <span style={{ ...styles.opBadge, color: OP_COLORS[change.operation] }}>
                {OP_LABELS[change.operation]}
              </span>
              <span style={styles.fileName} title={change.path}>
                {shortPath(change.path)}
              </span>
              <button
                onClick={(e) => handleRevert(e, change)}
                disabled={reverting === change.change_id}
                style={styles.revertBtn}
              >
                {reverting === change.change_id ? '...' : 'Revert'}
              </button>
            </div>

            {expandedFile === change.change_id && (
              <div style={styles.diffContainer}>
                {loading ? (
                  <div style={styles.loadingDiff}>Loading diff...</div>
                ) : diffData ? (
                  <DiffViewer
                    path={diffData.path}
                    before={diffData.before ? {
                      content: diffData.before,
                      hash: diffData.before_hash || '',
                      size: change.file_size,
                      isBinary: diffData.is_binary,
                    } : null}
                    after={diffData.after ? {
                      content: diffData.after,
                      hash: diffData.after_hash || '',
                      size: change.file_size,
                      isBinary: diffData.is_binary,
                    } : null}
                    onClose={() => { setExpandedFile(null); setDiffData(null); }}
                  />
                ) : (
                  <div style={styles.loadingDiff}>Failed to load diff</div>
                )}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      <div style={styles.footer}>
        Click a file to view diff
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  collapsedContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    margin: '8px 0',
    background: '#1e1e2e',
    border: '1px solid #333',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    color: '#ccc',
  },
  expandedContainer: {
    margin: '8px 0',
    background: '#1e1e2e',
    border: '1px solid #333',
    borderRadius: 6,
    fontSize: 13,
    color: '#ccc',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom: '1px solid #333',
  },
  icon: {
    fontSize: 14,
  },
  summary: {
    flex: 1,
    fontWeight: 500,
  },
  expandBtn: {
    color: '#7aa2f7',
    fontSize: 12,
    cursor: 'pointer',
  },
  revertAllBtn: {
    background: '#e5534b30',
    border: '1px solid #e5534b50',
    color: '#e5534b',
    padding: '3px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 500,
  },
  fileList: {
    maxHeight: 300,
    overflowY: 'auto' as const,
  },
  fileRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    cursor: 'pointer',
    borderBottom: '1px solid #2a2a3a',
  },
  opBadge: {
    fontFamily: 'monospace',
    fontWeight: 700,
    fontSize: 12,
    width: 16,
    textAlign: 'center' as const,
  },
  fileName: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#e0e0e0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  revertBtn: {
    background: '#333',
    border: '1px solid #555',
    color: '#ccc',
    padding: '2px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
  },
  diffContainer: {
    padding: '0 8px 8px',
  },
  loadingDiff: {
    padding: 16,
    textAlign: 'center' as const,
    color: '#888',
  },
  footer: {
    padding: '6px 12px',
    borderTop: '1px solid #333',
    color: '#666',
    fontSize: 11,
    textAlign: 'center' as const,
  },
};
