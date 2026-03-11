import React, { useState } from 'react';
import { useAuthStore } from '../../state/auth-store';

export function LoginPage() {
  const { login, verifyTotp, loginWithPasskey, totpRequired, error, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await login(username, password);
    setLoading(false);
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await verifyTotp(totpCode);
    setLoading(false);
  };

  const handlePasskey = async () => {
    if (!username) {
      clearError();
      return;
    }
    setLoading(true);
    await loginWithPasskey(username);
    setLoading(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">CCProxy</h1>

        {totpRequired ? (
          <form onSubmit={handleTotp}>
            <p className="auth-subtitle">Enter your two-factor authentication code</p>
            <div className="auth-field">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={totpCode}
                onChange={e => { setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6)); clearError(); }}
                maxLength={6}
                autoFocus
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button type="submit" className="auth-btn" disabled={loading || totpCode.length !== 6}>
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        ) : (
          <>
            <form onSubmit={handleLogin}>
              <div className="auth-field">
                <input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={e => { setUsername(e.target.value); clearError(); }}
                  autoComplete="username"
                  autoFocus
                />
              </div>
              <div className="auth-field">
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); clearError(); }}
                  autoComplete="current-password"
                />
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" className="auth-btn" disabled={loading || !username || !password}>
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
            <div className="auth-divider"><span>or</span></div>
            <button
              className="auth-btn auth-btn-secondary"
              onClick={handlePasskey}
              disabled={loading || !username || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)}
              title={/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? 'Passkeys require a domain name, not an IP address' : ''}
            >
              Sign in with passkey
            </button>
          </>
        )}
      </div>
    </div>
  );
}
