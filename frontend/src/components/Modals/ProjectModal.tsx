import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';
import { FolderBrowser } from './FolderBrowser';

interface Props {
  mode: 'new' | 'open';
  onClose: () => void;
}

export function ProjectModal({ mode, onClose }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const { activeEnvironmentId, projects, setProjects, addToast } = useStore();

  useEffect(() => { nameRef.current?.focus(); }, []);

  const isNew = mode === 'new';

  const submit = async () => {
    if (!name.trim() || !path.trim()) return;
    if (!activeEnvironmentId) return;
    try {
      const project = await api('POST', `/api/environments/${activeEnvironmentId}/projects`, {
        name: name.trim(),
        path: path.trim(),
        initGit: isNew,
      });
      setProjects([...projects, {
        ...project,
        sessions: [], files: [], gitChanges: [], terminals: [], stashes: [],
        gitLog: { branches: [], currentBranch: '', commits: [], remotes: [] },
        activeSessionIdx: 0, activeTerminalIdx: 0,
      }]);
      onClose();
      addToast(name, isNew ? 'Project created' : 'Project opened', 'success');
    } catch (e: any) {
      addToast(name, `Failed: ${e.message}`, 'attention');
    }
  };

  return (
    <div className="modal">
      <div className="modal-title">{isNew ? 'New Project' : 'Open Existing Project'}</div>
      <div className="modal-field">
        <label className="modal-label">Project Name</label>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
        />
      </div>
      <div className="modal-field">
        <label className="modal-label">Path on Linux Machine</label>
        <div className="modal-path-row">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/dev/projects/my-project"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
          />
          <button className="modal-browse-btn" onClick={() => setBrowsing(!browsing)}>Browse</button>
        </div>
        {browsing && <FolderBrowser startPath={path} onSelect={(p) => { setPath(p); setBrowsing(false); }} />}
      </div>
      <div className="modal-actions">
        <button className="modal-btn cancel" onClick={onClose}>Cancel</button>
        <button className="modal-btn confirm" onClick={submit}>{isNew ? 'Create Project' : 'Open Project'}</button>
      </div>
    </div>
  );
}
