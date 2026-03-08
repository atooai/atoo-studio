import React, { useState } from 'react';
import { useStore } from '../../state/store';
import { getFileIconSvg, FOLDER_ARROW_CLOSED, FOLDER_ARROW_OPEN } from '../../icons';
import type { FileNode, GitChange } from '../../types';

const GIT_STATUS_MAP: Record<string, { cls: string; label: string }> = {
  'M': { cls: 'M', label: 'M' },
  'A': { cls: 'A', label: 'A' },
  'D': { cls: 'D', label: 'D' },
  'R': { cls: 'R', label: 'R' },
  'U': { cls: 'U', label: 'U' },
  'MM': { cls: 'M', label: 'M' },
  'AM': { cls: 'A', label: 'A' },
  'AD': { cls: 'A', label: 'A' },
  'MD': { cls: 'M', label: 'M' },
  '??': { cls: 'untracked', label: 'U' },
  '!!': { cls: 'ignored', label: 'I' },
};

function GitBadge({ status, staged, oldPath }: { status: string; staged?: boolean; oldPath?: string }) {
  const mapped = GIT_STATUS_MAP[status] || { cls: status.replace(/[^a-zA-Z]/g, ''), label: status.trim() };
  return (
    <>
      {staged && <span className="file-git-badge staged">S</span>}
      <span className={`file-git-badge ${mapped.cls}`} title={oldPath ? `Moved from: ${oldPath}` : undefined}>{mapped.label}</span>
    </>
  );
}

// Compute set of directory paths that contain git-modified files
function getDirtyDirs(gitMap: Record<string, string>): Set<string> {
  const dirs = new Set<string>();
  for (const filePath of Object.keys(gitMap)) {
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs;
}

// Merge git-deleted files into the file tree so they remain visible
function mergeDeletedFiles(nodes: FileNode[], gitMap: Record<string, string>, parentPath: string): FileNode[] {
  // Collect deleted file paths that belong under parentPath
  const deletedHere: string[] = [];
  const deletedInSubdirs: Map<string, string[]> = new Map();

  for (const [filePath, status] of Object.entries(gitMap)) {
    if (status !== 'D') continue;
    const rel = parentPath ? (filePath.startsWith(parentPath + '/') ? filePath.slice(parentPath.length + 1) : null) : filePath;
    if (!rel) continue;
    const parts = rel.split('/');
    if (parts.length === 1) {
      // Direct child — check if already in nodes
      if (!nodes.some(n => n.name === parts[0])) {
        deletedHere.push(parts[0]);
      }
    } else {
      // In a subdirectory
      const dirName = parts[0];
      if (!deletedInSubdirs.has(dirName)) deletedInSubdirs.set(dirName, []);
      deletedInSubdirs.get(dirName)!.push(filePath);
    }
  }

  let result = nodes.map(node => {
    if (node.type === 'dir' && node.children) {
      const dirPath = parentPath ? parentPath + '/' + node.name : node.name;
      return { ...node, children: mergeDeletedFiles(node.children, gitMap, dirPath) };
    }
    return node;
  });

  // Add virtual directories for deleted files in subdirs that don't exist on disk
  for (const [dirName, _files] of deletedInSubdirs) {
    if (!result.some(n => n.name === dirName && n.type === 'dir')) {
      const dirPath = parentPath ? parentPath + '/' + dirName : dirName;
      result.push({ name: dirName, type: 'dir', children: mergeDeletedFiles([], gitMap, dirPath) });
    }
  }

  // Add deleted files as file nodes
  for (const name of deletedHere) {
    result.push({ name, type: 'file' });
  }

  // Re-sort: dirs first, then files, alphabetically
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

function isDirectory(nodes: FileNode[], path: string): boolean {
  for (const node of nodes) {
    const name = node.name;
    if (node.type === 'dir') {
      if (name === path) return true;
      if (path.startsWith(name + '/') && node.children) {
        if (isDirectory(node.children, path.slice(name.length + 1))) return true;
      }
    }
  }
  return false;
}

export function FileTree() {
  const { activeProjectId, projects, fileFilter, fileView, stashOpen } = useStore();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  const gitMap: Record<string, string> = {};
  const gitStaged: Record<string, boolean> = {};
  const gitOldPaths: Record<string, string> = {};
  (proj.gitChanges || []).forEach(c => { gitMap[c.file] = c.status; if (c.staged) gitStaged[c.file] = true; if (c.oldPath) gitOldPaths[c.file] = c.oldPath; });
  const changeCount = Object.keys(gitMap).length;
  const dirtyDirs = getDirtyDirs(gitMap);

  // Merge deleted files into the tree
  const filesWithDeleted = mergeDeletedFiles(proj.files || [], gitMap, '');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' && selectedPath) {
      const gitStatus = gitMap[selectedPath] || '';
      if (gitStatus === 'D') return; // Already deleted
      // Determine if it's a dir by checking the tree
      const isDir = isDirectory(filesWithDeleted, selectedPath);
      (window as any).deleteFileOrFolder?.(selectedPath, isDir);
    }
  };

  return (
    <>
      <FileToolbar proj={proj} changeCount={changeCount} />
      <div className="panel-content" id="files-panel" tabIndex={0} onKeyDown={handleKeyDown}
        onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        onDrop={(e) => { e.preventDefault(); (window as any).dropRoot(); }}
      >
        {fileFilter === 'changed'
          ? <ChangedFiles gitMap={gitMap} gitStaged={gitStaged} gitOldPaths={gitOldPaths} selectedPath={selectedPath} onSelect={setSelectedPath} />
          : fileView === 'flat'
            ? <FlatList nodes={filesWithDeleted} parentPath="" gitMap={gitMap} gitStaged={gitStaged} gitOldPaths={gitOldPaths} selectedPath={selectedPath} onSelect={setSelectedPath} />
            : <TreeNodes nodes={filesWithDeleted} parentPath="" gitMap={gitMap} gitStaged={gitStaged} gitOldPaths={gitOldPaths} dirtyDirs={dirtyDirs} depth={0} selectedPath={selectedPath} onSelect={setSelectedPath} />
        }
      </div>
      {stashOpen && proj.stashes && proj.stashes.length > 0 && (
        <StashPanel stashes={proj.stashes} projectId={proj.id} />
      )}
    </>
  );
}

function FileToolbar({ proj, changeCount }: { proj: any; changeCount: number }) {
  const { fileFilter, setFileFilter, fileView, setFileView, showHidden, setShowHidden, stashOpen, setStashOpen } = useStore();

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    // Re-fetch files with new setting
    useStore.getState().updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
    (window as any).selectProject(proj.id, proj.pe_id || '');
  };

  return (
    <>
      <div className="lp-header">
        <span className="lp-title">Explorer</span>
        {changeCount > 0 && <span className="lp-change-count">{changeCount}</span>}
      </div>
      <div className="lp-toolbar">
        <div className="lp-toolbar-group">
          <button className={`lp-tb-btn ${fileFilter === 'all' ? 'active' : ''}`} onClick={() => setFileFilter('all')} title="All files">◫</button>
          <button className={`lp-tb-btn ${fileFilter === 'changed' ? 'active' : ''}`} onClick={() => setFileFilter('changed')} title="Changed only">Δ</button>
        </div>
        <div className="lp-toolbar-sep"></div>
        <div className="lp-toolbar-group">
          <button className={`lp-tb-btn ${fileView === 'tree' ? 'active' : ''}`} onClick={() => setFileView('tree')} title="Tree view">⊞</button>
          <button className={`lp-tb-btn ${fileView === 'flat' ? 'active' : ''}`} onClick={() => setFileView('flat')} title="Flat list">☰</button>
        </div>
        <div className="lp-toolbar-sep"></div>
        <div className="lp-toolbar-group">
          <button className={`lp-tb-btn ${showHidden ? 'active' : ''}`} onClick={toggleHidden} title="Show hidden directories (node_modules, .git, etc.)">⦿</button>
          <button className={`lp-tb-btn ${(!proj.stashes || proj.stashes.length === 0) ? 'disabled' : ''}`} onClick={() => setStashOpen(!stashOpen)} title="Stashes">⊟</button>
        </div>
        {proj.isGit && (
          <div className="lp-toolbar-actions">
            <button className="lp-tb-action danger" onClick={() => (window as any).gitRevertAll()} title="Revert all changes">⟲</button>
            <button className="lp-tb-action" onClick={() => (window as any).gitStashAll()} title="Stash all">⊓</button>
            <button className="lp-tb-action" onClick={() => (window as any).gitCommit()} title="Commit">✓</button>
            <button className="lp-tb-action" onClick={() => (window as any).gitPush()} title="Push">↑</button>
          </div>
        )}
      </div>
    </>
  );
}

function TreeNodes({ nodes, parentPath, gitMap, gitStaged, gitOldPaths, dirtyDirs, depth, selectedPath, onSelect }: { nodes: FileNode[]; parentPath: string; gitMap: Record<string, string>; gitStaged: Record<string, boolean>; gitOldPaths: Record<string, string>; dirtyDirs: Set<string>; depth: number; selectedPath: string | null; onSelect: (p: string) => void }) {
  if (!nodes) return null;
  return (
    <>
      {nodes.map(node => {
        const fullPath = parentPath ? parentPath + '/' + node.name : node.name;
        if (node.type === 'dir') {
          return <DirNode key={fullPath} node={node} fullPath={fullPath} gitMap={gitMap} gitStaged={gitStaged} gitOldPaths={gitOldPaths} dirtyDirs={dirtyDirs} depth={depth} selectedPath={selectedPath} onSelect={onSelect} />;
        }
        const gitBadge = gitMap[fullPath];
        return (
          <div
            key={fullPath}
            className={`file-tree-item ${selectedPath === fullPath ? 'focused' : ''}`}
            style={{ '--depth': depth } as React.CSSProperties}
            data-path={fullPath}
            data-type="file"
            draggable
            onClick={() => onSelect(fullPath)}
            onDoubleClick={() => (window as any).openFileInEditor(fullPath)}
            onContextMenu={(e) => { e.preventDefault(); (window as any).showCtxMenu(e.nativeEvent, fullPath, 'file'); }}
            onDragStart={(e) => { (window as any).dragStart(fullPath, 'file', e.currentTarget, e.dataTransfer); }}
            onDragEnd={() => (window as any).dragEnd()}
            onDragOver={(e) => { e.stopPropagation(); (window as any).dragOverItem(fullPath, 'file', e.currentTarget, e); }}
            onDragLeave={(e) => (window as any).dragLeaveItem(e.currentTarget)}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); (window as any).dropItem(fullPath, 'file'); }}
          >
            <span className="file-tree-icon" dangerouslySetInnerHTML={{ __html: getFileIconSvg(node.name) }} />
            <span className="file-tree-name file">{node.name}</span>
            {gitBadge && <GitBadge status={gitBadge} staged={gitStaged[fullPath]} oldPath={gitOldPaths[fullPath]} />}
          </div>
        );
      })}
    </>
  );
}

function DirNode({ node, fullPath, gitMap, gitStaged, gitOldPaths, dirtyDirs, depth, selectedPath, onSelect }: { node: FileNode; fullPath: string; gitMap: Record<string, string>; gitStaged: Record<string, boolean>; gitOldPaths: Record<string, string>; dirtyDirs: Set<string>; depth: number; selectedPath: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const gitBadge = gitMap[fullPath];
  const isDirty = dirtyDirs.has(fullPath);

  return (
    <>
      <div
        className={`file-tree-item ${isDirty ? 'dir-dirty' : ''}`}
        style={{ '--depth': depth } as React.CSSProperties}
        data-path={fullPath}
        data-type="dir"
        draggable
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => { e.preventDefault(); (window as any).showCtxMenu(e.nativeEvent, fullPath, 'dir'); }}
        onDragStart={(e) => { (window as any).dragStart(fullPath, 'dir', e.currentTarget, e.dataTransfer); }}
        onDragEnd={() => (window as any).dragEnd()}
        onDragOver={(e) => { e.stopPropagation(); (window as any).dragOverItem(fullPath, 'dir', e.currentTarget, e); }}
        onDragLeave={(e) => (window as any).dragLeaveItem(e.currentTarget)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); (window as any).dropItem(fullPath, 'dir'); }}
      >
        <span className="file-tree-arrow">{open ? FOLDER_ARROW_OPEN : FOLDER_ARROW_CLOSED}</span>
        <span className="file-tree-name folder">{node.name}</span>
        {gitBadge && <GitBadge status={gitBadge} staged={gitStaged[fullPath]} oldPath={gitOldPaths[fullPath]} />}
        {isDirty && !gitBadge && <span className="dir-dirty-dot"></span>}
      </div>
      {open && (
        <div className="dir-children">
          <TreeNodes nodes={node.children || []} parentPath={fullPath} gitMap={gitMap} gitStaged={gitStaged} gitOldPaths={gitOldPaths} dirtyDirs={dirtyDirs} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
        </div>
      )}
    </>
  );
}

function FlatList({ nodes, parentPath, gitMap, gitStaged, gitOldPaths, selectedPath, onSelect }: { nodes: FileNode[]; parentPath: string; gitMap: Record<string, string>; gitStaged: Record<string, boolean>; gitOldPaths: Record<string, string>; selectedPath: string | null; onSelect: (p: string) => void }) {
  const items: Array<{ fullPath: string; name: string; dir: string; node: FileNode }> = [];
  function walk(items2: FileNode[], prefix: string) {
    for (const node of items2) {
      const fullPath = prefix ? prefix + '/' + node.name : node.name;
      if (node.type === 'dir' && node.children) {
        walk(node.children, fullPath);
      } else if (node.type === 'file') {
        items.push({ fullPath, name: node.name, dir: prefix, node });
      }
    }
  }
  walk(nodes, parentPath);

  return (
    <>
      {items.map(({ fullPath, name, dir, node }) => {
        const gitBadge = gitMap[fullPath];
        return (
          <div
            key={fullPath}
            className={`file-flat-item ${selectedPath === fullPath ? 'focused' : ''}`}
            data-path={fullPath}
            data-type="file"
            onClick={() => onSelect(fullPath)}
            onDoubleClick={() => (window as any).openFileInEditor(fullPath)}
            onContextMenu={(e) => { e.preventDefault(); (window as any).showCtxMenu(e.nativeEvent, fullPath, 'file'); }}
          >
            <span className="file-tree-icon" dangerouslySetInnerHTML={{ __html: getFileIconSvg(name) }} />
            <span className="file-flat-path">
              <span className="file-flat-name">{name}</span>
              {dir && <span style={{ color: 'var(--text-muted)' }}> {dir}/</span>}
            </span>
            {gitBadge && <GitBadge status={gitBadge} staged={gitStaged[fullPath]} oldPath={gitOldPaths[fullPath]} />}
          </div>
        );
      })}
    </>
  );
}

function ChangedFiles({ gitMap, gitStaged, gitOldPaths, selectedPath, onSelect }: { gitMap: Record<string, string>; gitStaged: Record<string, boolean>; gitOldPaths: Record<string, string>; selectedPath: string | null; onSelect: (p: string) => void }) {
  const changes = Object.entries(gitMap);
  if (changes.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 20 }}>
        <div className="empty-state-icon">✓</div>
        <div className="empty-state-title">No changes</div>
      </div>
    );
  }
  return (
    <>
      {changes.map(([file, status]) => (
        <div
          key={file}
          className={`file-flat-item ${selectedPath === file ? 'focused' : ''}`}
          data-path={file}
          data-type="file"
          onClick={() => onSelect(file)}
          onDoubleClick={() => (window as any).openFileInEditor(file)}
          onContextMenu={(e) => { e.preventDefault(); (window as any).showCtxMenu(e.nativeEvent, file, 'file'); }}
        >
          <GitBadge status={status} staged={gitStaged[file]} oldPath={gitOldPaths[file]} />
          <span className="file-flat-path">{file}</span>
        </div>
      ))}
    </>
  );
}

function StashPanel({ stashes, projectId }: { stashes: any[]; projectId: string }) {
  return (
    <div className="stash-panel open">
      <div className="stash-header">
        <span className="stash-header-title">Stashes ({stashes.length})</span>
      </div>
      {stashes.map(s => (
        <div key={s.id} className="stash-item">
          <span className="stash-icon">⊟</span>
          <span className="stash-name">{s.name}</span>
          <div className="stash-actions">
            <button className="stash-action-btn apply" onClick={() => (window as any).applyStash(s.id)}>apply</button>
            <button className="stash-action-btn drop" onClick={() => (window as any).dropStash(s.id)}>drop</button>
          </div>
        </div>
      ))}
    </div>
  );
}
