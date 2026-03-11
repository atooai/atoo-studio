import React, { useState, useEffect } from 'react';
import * as authApi from '../../api/auth';

interface Props {
  onClose: () => void;
}

export function UserManagement({ onClose }: Props) {
  const [users, setUsers] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', display_name: '', role: 'basic', password: '' });
  const [resetPwUser, setResetPwUser] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadUsers = async () => {
    try {
      const list = await authApi.listUsers();
      setUsers(list);
    } catch {}
  };

  useEffect(() => { loadUsers(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await authApi.createUser(newUser);
      setShowCreate(false);
      setNewUser({ username: '', display_name: '', role: 'basic', password: '' });
      loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  };

  const handleDelete = async (id: string, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      await authApi.deleteUser(id);
      loadUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPwUser || newPassword.length < 8) return;
    try {
      await authApi.resetUserPassword(resetPwUser, newPassword);
      setResetPwUser(null);
      setNewPassword('');
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleResetTotp = async (id: string) => {
    if (!confirm('Remove TOTP for this user?')) return;
    try {
      await authApi.resetUserTotp(id);
      loadUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleResetPasskeys = async (id: string) => {
    if (!confirm('Remove all passkeys for this user?')) return;
    try {
      await authApi.resetUserPasskeys(id);
      loadUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>User Management</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="settings-section">
            <div className="settings-section-header">
              <h3>Users</h3>
              <button className="auth-btn auth-btn-small" onClick={() => setShowCreate(true)}>Add user</button>
            </div>

            {showCreate && (
              <form className="settings-form" onSubmit={handleCreate}>
                <input placeholder="Username" value={newUser.username}
                  onChange={e => setNewUser({ ...newUser, username: e.target.value })} required />
                <input placeholder="Display name" value={newUser.display_name}
                  onChange={e => setNewUser({ ...newUser, display_name: e.target.value })} required />
                <select value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })}>
                  <option value="basic">Basic</option>
                  <option value="admin">Admin</option>
                </select>
                <input type="password" placeholder="Password (min 8)" value={newUser.password}
                  onChange={e => setNewUser({ ...newUser, password: e.target.value })} required minLength={8} />
                {error && <div className="auth-error">{error}</div>}
                <div className="settings-form-actions">
                  <button type="button" className="auth-btn auth-btn-secondary auth-btn-small" onClick={() => setShowCreate(false)}>Cancel</button>
                  <button type="submit" className="auth-btn auth-btn-small" disabled={loading}>Create</button>
                </div>
              </form>
            )}

            <table className="users-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Display name</th>
                  <th>Role</th>
                  <th>MFA</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td>{u.username}</td>
                    <td>{u.display_name}</td>
                    <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                    <td>
                      {u.hasTOTP && <span className="mfa-badge" title="TOTP enabled">TOTP</span>}
                      {u.passkeyCount > 0 && <span className="mfa-badge" title={`${u.passkeyCount} passkey(s)`}>PK</span>}
                      {!u.hasTOTP && u.passkeyCount === 0 && <span className="mfa-none">-</span>}
                    </td>
                    <td className="user-actions">
                      <button className="action-btn" onClick={() => { setResetPwUser(u.id); setNewPassword(''); }}>Reset pw</button>
                      {u.hasTOTP && <button className="action-btn" onClick={() => handleResetTotp(u.id)}>Reset TOTP</button>}
                      {u.passkeyCount > 0 && <button className="action-btn" onClick={() => handleResetPasskeys(u.id)}>Reset PK</button>}
                      <button className="action-btn action-btn-danger" onClick={() => handleDelete(u.id, u.username)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {resetPwUser && (
              <form className="settings-form" onSubmit={handleResetPassword}>
                <h4>Reset password</h4>
                <input type="password" placeholder="New password (min 8)" value={newPassword}
                  onChange={e => setNewPassword(e.target.value)} required minLength={8} autoFocus />
                <div className="settings-form-actions">
                  <button type="button" className="auth-btn auth-btn-secondary auth-btn-small" onClick={() => setResetPwUser(null)}>Cancel</button>
                  <button type="submit" className="auth-btn auth-btn-small">Reset</button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
