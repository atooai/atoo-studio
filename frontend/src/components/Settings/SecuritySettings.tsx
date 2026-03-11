import React, { useState, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { useAuthStore } from '../../state/auth-store';
import * as authApi from '../../api/auth';

interface Props {
  onClose: () => void;
}

const isIpHost = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) || location.hostname.includes(':');

export function SecuritySettings({ onClose }: Props) {
  const { user, hasTOTP, passkeyCount, refreshMe } = useAuthStore();
  const [tab, setTab] = useState<'password' | 'totp' | 'passkeys'>('password');

  // Password state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);

  // TOTP state
  const [totpQr, setTotpQr] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState('');
  const [totpSetupActive, setTotpSetupActive] = useState(false);

  // Passkey state
  const [passkeys, setPasskeys] = useState<any[]>([]);
  const [pkName, setPkName] = useState('');
  const [pkError, setPkError] = useState('');

  useEffect(() => {
    if (tab === 'passkeys') loadPasskeys();
  }, [tab]);

  const loadPasskeys = async () => {
    try {
      const list = await authApi.listMyPasskeys();
      setPasskeys(list);
    } catch {}
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(''); setPwSuccess(false);
    if (newPw !== confirmPw) { setPwError('Passwords do not match'); return; }
    if (newPw.length < 8) { setPwError('Password must be at least 8 characters'); return; }
    try {
      await authApi.changePassword(currentPw, newPw);
      setPwSuccess(true);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err: any) {
      setPwError(err.message);
    }
  };

  const handleSetupTotp = async () => {
    try {
      const result = await authApi.setupTotp();
      setTotpQr(result.qrDataUrl);
      setTotpSetupActive(true);
      setTotpError('');
    } catch (err: any) {
      setTotpError(err.message);
    }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await authApi.verifyTotp(totpCode);
      setTotpSetupActive(false);
      setTotpQr('');
      setTotpCode('');
      refreshMe();
    } catch (err: any) {
      setTotpError(err.message);
    }
  };

  const handleRemoveTotp = async () => {
    if (!confirm('Remove TOTP? You will no longer need a code to sign in.')) return;
    try {
      await authApi.removeTotp();
      refreshMe();
    } catch (err: any) {
      setTotpError(err.message);
    }
  };

  const handleRegisterPasskey = async () => {
    setPkError('');
    try {
      const options = await authApi.getPasskeyRegisterOptions();
      const credential = await startRegistration({ optionsJSON: options });
      await authApi.registerPasskey(credential, pkName || undefined);
      setPkName('');
      loadPasskeys();
      refreshMe();
    } catch (err: any) {
      setPkError(err.message);
    }
  };

  const handleDeletePasskey = async (id: string) => {
    if (!confirm('Remove this passkey?')) return;
    try {
      await authApi.deleteMyPasskey(id);
      loadPasskeys();
      refreshMe();
    } catch (err: any) {
      setPkError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Security Settings</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="settings-tabs">
            <button className={tab === 'password' ? 'active' : ''} onClick={() => setTab('password')}>Password</button>
            <button className={tab === 'totp' ? 'active' : ''} onClick={() => setTab('totp')}>TOTP</button>
            <button
              className={tab === 'passkeys' ? 'active' : ''}
              onClick={() => !isIpHost && setTab('passkeys')}
              disabled={isIpHost}
              title={isIpHost ? 'Passkeys require a domain name (not an IP address). Access via a hostname to use passkeys.' : ''}
            >Passkeys</button>
          </div>

          {tab === 'password' && (
            <form className="settings-form" onSubmit={handleChangePassword}>
              <input type="password" placeholder="Current password" value={currentPw}
                onChange={e => setCurrentPw(e.target.value)} autoComplete="current-password" required />
              <input type="password" placeholder="New password (min 8)" value={newPw}
                onChange={e => setNewPw(e.target.value)} autoComplete="new-password" required />
              <input type="password" placeholder="Confirm new password" value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)} autoComplete="new-password" required />
              {pwError && <div className="auth-error">{pwError}</div>}
              {pwSuccess && <div className="auth-success">Password changed successfully</div>}
              <button type="submit" className="auth-btn auth-btn-small">Change password</button>
            </form>
          )}

          {tab === 'totp' && (
            <div className="settings-section">
              {hasTOTP && !totpSetupActive ? (
                <div>
                  <p className="settings-info">TOTP is enabled. You will be asked for a code after entering your password.</p>
                  <button className="auth-btn auth-btn-small auth-btn-danger" onClick={handleRemoveTotp}>Remove TOTP</button>
                </div>
              ) : totpSetupActive ? (
                <div>
                  <p className="settings-info">Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
                  {totpQr && <img src={totpQr} alt="TOTP QR Code" className="totp-qr" />}
                  <form className="settings-form" onSubmit={handleVerifyTotp}>
                    <input type="text" inputMode="numeric" placeholder="6-digit code" value={totpCode}
                      onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} maxLength={6} autoFocus />
                    {totpError && <div className="auth-error">{totpError}</div>}
                    <div className="settings-form-actions">
                      <button type="button" className="auth-btn auth-btn-secondary auth-btn-small" onClick={() => setTotpSetupActive(false)}>Cancel</button>
                      <button type="submit" className="auth-btn auth-btn-small" disabled={totpCode.length !== 6}>Verify & activate</button>
                    </div>
                  </form>
                </div>
              ) : (
                <div>
                  <p className="settings-info">Add a second factor to your account using an authenticator app.</p>
                  <button className="auth-btn auth-btn-small" onClick={handleSetupTotp}>Set up TOTP</button>
                </div>
              )}
            </div>
          )}

          {tab === 'passkeys' && (
            <div className="settings-section">
              <p className="settings-info">Passkeys allow passwordless sign-in using biometrics or hardware security keys.</p>

              {passkeys.length > 0 && (
                <table className="users-table">
                  <thead>
                    <tr><th>Name</th><th>Created</th><th></th></tr>
                  </thead>
                  <tbody>
                    {passkeys.map(pk => (
                      <tr key={pk.id}>
                        <td>{pk.device_name || 'Unnamed'}</td>
                        <td>{new Date(pk.created_at).toLocaleDateString()}</td>
                        <td>
                          <button className="action-btn action-btn-danger" onClick={() => handleDeletePasskey(pk.id)}>Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="settings-form">
                <input placeholder="Device name (optional)" value={pkName} onChange={e => setPkName(e.target.value)} />
                {pkError && <div className="auth-error">{pkError}</div>}
                <button className="auth-btn auth-btn-small" onClick={handleRegisterPasskey}>Register passkey</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
