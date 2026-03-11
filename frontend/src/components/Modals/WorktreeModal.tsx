import React, { useEffect, useRef, useState } from 'react';
import { FolderBrowser } from './FolderBrowser';

interface WorktreeModalProps {
  branches: string[];
  usedBranches?: string[];
  projectPath: string;
  onConfirm: (path: string, branch: string, isNewBranch: boolean) => void;
  onClose: () => void;
}

export function WorktreeModal({ branches, usedBranches = [], projectPath, onConfirm, onClose }: WorktreeModalProps) {
  const [branch, setBranch] = useState('');
  const [isNewBranch, setIsNewBranch] = useState(true);
  const [pathMode, setPathMode] = useState<'default' | 'custom'>('default');
  const [customPath, setCustomPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const defaultPath = branch.trim()
    ? projectPath + '/.atoo-studio/worktrees/' + sanitize(branch.trim())
    : '';

  const resolvedPath = pathMode === 'default' ? defaultPath : customPath;

  const canSubmit = resolvedPath && (isNewBranch ? branch.trim() : branch);

  const handleConfirm = () => {
    if (!canSubmit) return;
    onConfirm(resolvedPath, isNewBranch ? branch.trim() : branch, isNewBranch);
    onClose();
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Enter' && !browsing) { e.preventDefault(); handleConfirm(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [resolvedPath, branch, browsing]);

  return (
    <div className="confirm-dialog" style={{ minWidth: 440 }}>
      <div className="confirm-dialog-title">New Worktree</div>

      <div className="worktree-form">
        {/* Branch mode toggle */}
        <div className="worktree-toggle" style={{ marginBottom: 12 }}>
          <button
            className={`worktree-toggle-btn ${isNewBranch ? 'active' : ''}`}
            onClick={() => setIsNewBranch(true)}
          >New branch</button>
          <button
            className={`worktree-toggle-btn ${!isNewBranch ? 'active' : ''}`}
            onClick={() => setIsNewBranch(false)}
          >Existing branch</button>
        </div>

        {/* Branch input */}
        {isNewBranch ? (
          <label className="worktree-label">
            <span className="worktree-label-text">Branch name</span>
            <input
              ref={inputRef}
              className="input-dialog-input"
              type="text"
              value={branch}
              onChange={e => setBranch(e.target.value)}
              placeholder="feature/my-feature"
              style={{ marginBottom: 12 }}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
            />
          </label>
        ) : (
          <label className="worktree-label">
            <span className="worktree-label-text">Branch</span>
            <select
              className="input-dialog-input"
              value={branch}
              onChange={e => setBranch(e.target.value)}
              style={{ marginBottom: 12 }}
            >
              <option value="">Select branch...</option>
              {branches.map(b => {
                const used = usedBranches.includes(b);
                return <option key={b} value={b} disabled={used} style={used ? { color: 'var(--text-muted)' } : undefined}>{b}{used ? ' (in use)' : ''}</option>;
              })}
            </select>
          </label>
        )}

        {/* Path mode toggle */}
        <label className="worktree-label">
          <span className="worktree-label-text">Worktree location</span>
        </label>
        <div className="worktree-toggle" style={{ marginBottom: 8 }}>
          <button
            className={`worktree-toggle-btn ${pathMode === 'default' ? 'active' : ''}`}
            onClick={() => setPathMode('default')}
          >Default</button>
          <button
            className={`worktree-toggle-btn ${pathMode === 'custom' ? 'active' : ''}`}
            onClick={() => setPathMode('custom')}
          >Custom</button>
        </div>

        {pathMode === 'default' ? (
          <div className="worktree-default-path" title={defaultPath}>
            {defaultPath || <span style={{ color: 'var(--text-muted)' }}>Enter a branch name first...</span>}
          </div>
        ) : (
          <>
            <div className="modal-path-row" style={{ marginBottom: browsing ? 0 : 12 }}>
              <input
                className="input-dialog-input"
                type="text"
                value={customPath}
                onChange={e => setCustomPath(e.target.value)}
                placeholder="/path/to/worktree"
                style={{ marginBottom: 0 }}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                data-form-type="other"
              />
              <button className="modal-browse-btn" onClick={() => setBrowsing(!browsing)}>Browse</button>
            </div>
            {browsing && (
              <FolderBrowser
                startPath={customPath || projectPath}
                onSelect={(p) => { setCustomPath(p); setBrowsing(false); }}
              />
            )}
          </>
        )}
      </div>

      <div className="confirm-dialog-actions">
        <button className="confirm-dialog-btn cancel" onClick={onClose}>Cancel</button>
        <button
          className="confirm-dialog-btn primary"
          onClick={handleConfirm}
          disabled={!canSubmit}
        >Create Worktree</button>
      </div>
    </div>
  );
}
