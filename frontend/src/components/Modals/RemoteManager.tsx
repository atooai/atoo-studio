import React, { useState } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';

interface Props {
  onClose: () => void;
}

export function RemoteManager({ onClose }: Props) {
  const { getActiveProject, updateProject, addToast } = useStore();
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const proj = getActiveProject();

  if (!proj || !proj.gitLog) return null;
  const remotes = proj.gitLog.remotes || [];

  const refreshRemotes = async () => {
    const fresh = await api('GET', `/api/projects/${proj.id}/git/remotes`);
    updateProject(proj.id, p => ({ ...p, gitLog: { ...p.gitLog, remotes: fresh } }));
  };

  const addRemote = async () => {
    if (!newName.trim() || !newUrl.trim()) { addToast(proj.name, 'Name and URL required', 'attention'); return; }
    try {
      await api('POST', `/api/projects/${proj.id}/git/remotes`, { name: newName.trim(), url: newUrl.trim() });
      await refreshRemotes();
      addToast(proj.name, `Added remote "${newName.trim()}"`, 'success');
      setNewName(''); setNewUrl('');
    } catch (e: any) { addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  const removeRemote = async (name: string) => {
    try {
      await api('DELETE', `/api/projects/${proj.id}/git/remotes/${name}`);
      await refreshRemotes();
      addToast(proj.name, `Removed "${name}"`, 'info');
    } catch (e: any) { addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  const editRemote = async (name: string) => {
    const remote = remotes.find((r: any) => r.name === name);
    if (!remote) return;
    const url = prompt(`Edit URL for "${name}":`, remote.url);
    if (!url?.trim()) return;
    try {
      await api('PUT', `/api/projects/${proj.id}/git/remotes/${name}`, { url: url.trim() });
      await refreshRemotes();
      addToast(proj.name, `Updated "${name}"`, 'success');
    } catch (e: any) { addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  return (
    <div className="modal" style={{ width: 460 }}>
      <div className="modal-title">Git Remotes</div>
      <div className="remote-list">
        {remotes.length === 0 ? (
          <div className="remote-empty">No remotes configured</div>
        ) : (
          remotes.map((r: any) => (
            <div key={r.name} className="remote-item">
              <span className="remote-item-icon">{r.type === 'ssh' ? '🔑' : '🌐'}</span>
              <div className="remote-item-info">
                <div className="remote-item-name">{r.name}</div>
                <div className="remote-item-url">{r.url}</div>
              </div>
              <div className="remote-item-actions">
                <button className="remote-action-btn" onClick={() => editRemote(r.name)} title="Edit URL">✎</button>
                <button className="remote-action-btn delete" onClick={() => removeRemote(r.name)} title="Remove">✕</button>
              </div>
            </div>
          ))
        )}
      </div>
      <hr className="remote-sep" />
      <div className="remote-add-form">
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Add Remote</div>
        <div className="remote-add-row">
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="name" style={{ fontFamily: 'var(--font-mono)' }} />
          <input type="text" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://github.com/user/repo.git" style={{ fontFamily: 'var(--font-mono)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="modal-btn confirm" onClick={addRemote} style={{ padding: '5px 14px', fontSize: 11 }}>Add</button>
        </div>
      </div>
      <div className="modal-actions">
        <button className="modal-btn cancel" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
