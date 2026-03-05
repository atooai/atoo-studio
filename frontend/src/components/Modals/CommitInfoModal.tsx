import React from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';

interface Props {
  hash: string;
  onClose: () => void;
}

export function CommitInfoModal({ hash, onClose }: Props) {
  const { getActiveProject } = useStore();
  const proj = getActiveProject();
  if (!proj || !proj.gitLog) return null;

  const commit = proj.gitLog.commits.find((c: any) => c.hash === hash);
  if (!commit) return null;

  const statusMap: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

  return (
    <div className="modal" style={{ width: 520 }}>
      <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>{commit.hash}</span>
      </div>
      <div className="commit-info-msg">
        {(commit.fullMessage || commit.msg || '').split('\n').map((line: string, i: number) => (
          <React.Fragment key={i}>{line}{i < (commit.fullMessage || commit.msg || '').split('\n').length - 1 && <br />}</React.Fragment>
        ))}
      </div>
      <div className="commit-info-grid">
        <span className="commit-info-label">Author</span><span className="commit-info-value">{commit.author}</span>
        <span className="commit-info-label">Date</span><span className="commit-info-value">{commit.date}</span>
        <span className="commit-info-label">Refs</span>
        <span className="commit-info-value">
          {(commit.refs || []).length > 0
            ? (commit.refs || []).map((r: any, i: number) => (
                <span key={i} className={`gh-ref-badge ${r.type === 'head' ? 'head-badge' : r.type === 'branch' ? 'branch-badge' : ''}`}>
                  {r.label}
                </span>
              ))
            : '—'}
        </span>
      </div>
      {commit.files && commit.files.length > 0 && (
        <>
          <div className="modal-label" style={{ marginBottom: 6 }}>Changed Files</div>
          <div className="commit-info-file-list">
            {commit.files.map((f: any, i: number) => {
              const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/') + 1) : '';
              const name = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
              return (
                <div key={i} className="gh-file-item" onClick={() => { onClose(); (window as any).openFileInEditor?.(f.path); }}>
                  <span className={`gh-file-status ${statusMap[f.status] || ''}`}>{f.status}</span>
                  <span className="gh-file-path">
                    {dir && <span className="gh-file-path-dir">{dir}</span>}{name}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="modal-actions">
        <button className="modal-btn cancel" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
