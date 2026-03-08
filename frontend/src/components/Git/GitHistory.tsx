import React, { useState } from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';
import { api } from '../../api';
import type { GitCommit, GitFile } from '../../types';

export function GitHistory() {
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  if (!proj.isGit || !proj.gitLog) {
    return (
      <div className="git-history-panel" style={{ height: 220 }}>
        <div className="gh-empty">
          <span className="gh-empty-icon">&#x2298;</span>
          <span className="gh-empty-title">Not a git repository</span>
        </div>
      </div>
    );
  }

  return (
    <div className="git-history-panel" id="git-history-panel" style={{ height: 220 }}>
      <BranchBar proj={proj} />
      <CommitList proj={proj} />
    </div>
  );
}

function BranchBar({ proj }: { proj: any }) {
  const { projects } = useStore();
  const isWorktree = !!proj.parent_project_id;

  // Collect branches used by sibling worktree projects (exclude our own)
  const parentId = proj.parent_project_id || proj.id;
  const worktreeBranches = new Set(
    projects
      .filter(p => p.parent_project_id === parentId && p.id !== proj.id)
      .map(p => p.gitLog?.currentBranch)
      .filter(Boolean)
  );

  return (
    <div className="gh-branch-bar">
      <span className="gh-branch-icon">&#x2442;</span>
      <select
        className="gh-branch-select"
        value={proj.gitLog.currentBranch}
        onChange={(e) => (window as any).switchGitBranch(e.target.value)}
      >
        {(proj.gitLog.branches || []).filter((b: string) => {
          if (b.startsWith('remotes/')) return true;
          // Always show our own current branch
          if (b === proj.gitLog.currentBranch) return true;
          // Hide branches checked out in other worktrees
          return !worktreeBranches.has(b);
        }).map((b: string) => {
          const isRemote = b.startsWith('remotes/');
          const display = isRemote ? b.replace('remotes/', '') : b;
          return <option key={b} value={b}>{display}</option>;
        })}
      </select>
      <div className="gh-branch-actions">
        <button className="gh-branch-btn" onClick={() => (window as any).createBranch()} title="New branch">+</button>
        {!isWorktree && <button className="gh-branch-btn" onClick={() => (window as any).createWorktree()} title="New worktree">&#x2295;</button>}
        <button className="gh-branch-btn" onClick={() => (window as any).fetchRemote()} title="Fetch">&#x2193;</button>
        {!isWorktree && <button className="gh-branch-btn" onClick={() => (window as any).openRemoteManager()} title="Manage remotes">&#x21C4;</button>}
      </div>
    </div>
  );
}

function CommitList({ proj }: { proj: any }) {
  const commits: GitCommit[] = proj.gitLog.commits || [];
  const [expandedHashes, setExpandedHashes] = useState<Set<string>>(new Set());
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [loadedFiles, setLoadedFiles] = useState<Record<string, GitFile[]>>({});

  const toggleExpand = async (hash: string) => {
    const newSet = new Set(expandedHashes);
    if (newSet.has(hash)) {
      newSet.delete(hash);
    } else {
      newSet.add(hash);
      if (!loadedFiles[hash]) {
        try {
          const files = await api('GET', `/api/projects/${proj.id}/git/commit-files?hash=${hash}`);
          setLoadedFiles(prev => ({ ...prev, [hash]: files }));
        } catch {}
      }
    }
    setExpandedHashes(newSet);
  };

  const copyHash = (hash: string) => {
    navigator.clipboard?.writeText(hash);
    useStore.getState().addToast(proj.name || '', `Copied ${hash}`, 'info');
  };

  return (
    <div className="gh-commit-list">
      {commits.map((c) => {
        const isHead = (c.refs || []).some(r => r.type === 'head');
        const isMerge = c.merge;
        const isExpanded = expandedHashes.has(c.hash);
        const files = loadedFiles[c.hash] || c.files || [];

        return (
          <React.Fragment key={c.hash}>
            <div
              className={`gh-commit ${isHead ? 'head' : ''} ${isMerge ? 'merge' : ''} ${selectedHash === c.hash ? 'selected' : ''}`}
              onClick={() => { setSelectedHash(c.hash); toggleExpand(c.hash); }}
              onContextMenu={(e) => { e.preventDefault(); (window as any).showCommitCtxMenu(e.nativeEvent, c.hash); }}
            >
              <div className="gh-graph">
                <div className="gh-graph-line"></div>
                <div className="gh-graph-dot"></div>
              </div>
              <div className="gh-commit-body">
                <div className="gh-commit-msg">
                  {escapeHtml(c.msg)}
                  {(c.refs || []).length > 0 && (
                    <span className="gh-commit-refs">
                      {c.refs!.map((r, i) => {
                        let cls = 'gh-ref-badge ';
                        if (r.type === 'head') cls += 'head-badge';
                        else if (r.type === 'branch') cls += 'branch-badge';
                        else if (r.type === 'tag') cls += 'tag-badge';
                        else if (r.type === 'remote') cls += 'remote-badge';
                        return <span key={i} className={cls}>{r.label}</span>;
                      })}
                    </span>
                  )}
                </div>
                <div className="gh-commit-meta">
                  <span className={`gh-commit-expand ${isExpanded ? 'open' : ''}`} onClick={(e) => { e.stopPropagation(); toggleExpand(c.hash); }}>&#x25B8;</span>
                  <span className="gh-commit-hash" onClick={(e) => { e.stopPropagation(); copyHash(c.hash); }}>{c.hash}</span>
                  <span className="gh-commit-author">{c.author}</span>
                  {files.length > 0 && <span className="gh-commit-file-count">{files.length} files</span>}
                  <span className="gh-commit-date">{c.date}</span>
                </div>
              </div>
            </div>
            {isExpanded && (
              <div className="gh-commit-files open">
                {files.map((f) => {
                  const statusMap: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
                  const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/') + 1) : '';
                  const name = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
                  return (
                    <div key={f.path} className="gh-file-item" onClick={() => (window as any).openFileInEditor(f.path)}>
                      <span className={`gh-file-status ${statusMap[f.status] || ''}`}>{f.status}</span>
                      <span className="gh-file-path">
                        {f.oldPath && <span className="gh-file-path-old">{f.oldPath} → </span>}
                        {dir && <span className="gh-file-path-dir">{dir}</span>}
                        {name}
                      </span>
                      <span className="gh-file-stats">
                        {f.additions ? <span className="gh-file-add">+{f.additions}</span> : null}
                        {f.deletions ? <span className="gh-file-del">-{f.deletions}</span> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
