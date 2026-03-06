import React, { useState, useEffect } from 'react';
import { api } from '../../api';

interface Props {
  connectionId: string;
  startPath?: string;
  onSelect: (path: string) => void;
}

interface BrowseData {
  current: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
}

export function RemoteFolderBrowser({ connectionId, startPath, onSelect }: Props) {
  const [data, setData] = useState<BrowseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);

  const load = async (browsePath?: string) => {
    try {
      const p = browsePath || '/home';
      const result = await api('GET', `/api/ssh/${connectionId}/browse?path=${encodeURIComponent(p)}`);
      setData(result);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load(startPath || undefined);
  }, []);

  const createFolder = async () => {
    if (!newFolderName.trim() || !data) return;
    try {
      const fullPath = data.current === '/' ? `/${newFolderName.trim()}` : `${data.current}/${newFolderName.trim()}`;
      await api('POST', `/api/ssh/${connectionId}/browse/mkdir`, { path: fullPath });
      setNewFolderName('');
      setShowNewFolder(false);
      await load(data.current);
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (error) {
    return <div className="folder-browser"><div className="folder-browser-empty">Error: {error}</div></div>;
  }
  if (!data) {
    return <div className="folder-browser"><div className="folder-browser-empty">Loading...</div></div>;
  }

  return (
    <div className="folder-browser">
      <div className="folder-browser-bar">
        {data.parent && data.parent !== data.current && (
          <button onClick={() => load(data.parent!)}>&#x2191; Up</button>
        )}
        <span className="folder-browser-path">{data.current}</span>
        <button className="folder-browser-new" onClick={() => setShowNewFolder(!showNewFolder)} title="New folder">+</button>
        <button onClick={() => onSelect(data.current)}>Select</button>
      </div>
      {showNewFolder && (
        <div className="folder-browser-new-row">
          <input
            className="folder-browser-new-input"
            type="text"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            placeholder="New folder name..."
            autoFocus
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
          />
          <button className="folder-browser-new-ok" onClick={createFolder}>Create</button>
        </div>
      )}
      <div className="folder-browser-list">
        {data.dirs.length === 0 ? (
          <div className="folder-browser-empty">No subdirectories</div>
        ) : (
          data.dirs.map((d) => (
            <div
              key={d.path}
              className="folder-browser-item"
              onClick={() => load(d.path)}
              onDoubleClick={() => onSelect(d.path)}
            >
              <span className="folder-browser-icon">&#x1F4C1;</span>
              <span className="folder-browser-name">{d.name}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
