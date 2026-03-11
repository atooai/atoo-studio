import React, { useState } from 'react';
import { useAuthStore } from '../../state/auth-store';

export function SetupPage() {
  const { setup, error, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setLocalError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters');
      return;
    }
    setLocalError('');
    setLoading(true);
    await setup(username, displayName, password);
    setLoading(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Atoo Studio</h1>
        <p className="auth-subtitle">Create your admin account to get started</p>

        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={e => { setUsername(e.target.value); clearError(); setLocalError(''); }}
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="auth-field">
            <input
              type="text"
              placeholder="Display name"
              value={displayName}
              onChange={e => { setDisplayName(e.target.value); clearError(); setLocalError(''); }}
            />
          </div>
          <div className="auth-field">
            <input
              type="password"
              placeholder="Password (min 8 characters)"
              value={password}
              onChange={e => { setPassword(e.target.value); clearError(); setLocalError(''); }}
              autoComplete="new-password"
            />
          </div>
          <div className="auth-field">
            <input
              type="password"
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); clearError(); setLocalError(''); }}
              autoComplete="new-password"
            />
          </div>
          {(error || localError) && <div className="auth-error">{localError || error}</div>}
          <button
            type="submit"
            className="auth-btn"
            disabled={loading || !username || !displayName || !password || !confirmPassword}
          >
            {loading ? 'Creating account...' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  );
}
