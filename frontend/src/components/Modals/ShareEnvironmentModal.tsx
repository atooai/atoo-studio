import React, { useState, useEffect } from 'react';
import * as authApi from '../../api/auth';

interface Props {
  environmentId: string;
  environmentName: string;
  onClose: () => void;
}

export function ShareEnvironmentModal({ environmentId, environmentName, onClose }: Props) {
  const [shares, setShares] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [s, u] = await Promise.all([
        authApi.listEnvironmentShares(environmentId),
        authApi.listUsers(),
      ]);
      setShares(s);
      setUsers(u);
    } catch {}
  };

  useEffect(() => { load(); }, []);

  const sharedUserIds = new Set(shares.map(s => s.user_id));
  const availableUsers = users.filter(u => !sharedUserIds.has(u.id));

  const handleShare = async () => {
    if (!selectedUserId) return;
    setError('');
    try {
      await authApi.shareEnvironment(environmentId, selectedUserId);
      setSelectedUserId('');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleUnshare = async (userId: string) => {
    try {
      await authApi.unshareEnvironment(environmentId, userId);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Share "{environmentName}"</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {shares.length > 0 && (
            <div className="settings-section">
              <h3>Shared with</h3>
              <table className="users-table">
                <thead><tr><th>User</th><th></th></tr></thead>
                <tbody>
                  {shares.map(s => (
                    <tr key={s.id}>
                      <td>{s.display_name} ({s.username})</td>
                      <td>
                        <button className="action-btn action-btn-danger" onClick={() => handleUnshare(s.user_id)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="settings-section">
            <h3>Add user</h3>
            {availableUsers.length > 0 ? (
              <div className="settings-form settings-form-inline">
                <select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)}>
                  <option value="">Select user...</option>
                  {availableUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>
                  ))}
                </select>
                <button className="auth-btn auth-btn-small" onClick={handleShare} disabled={!selectedUserId}>Share</button>
              </div>
            ) : (
              <p className="settings-info">No more users available to share with.</p>
            )}
            {error && <div className="auth-error">{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
