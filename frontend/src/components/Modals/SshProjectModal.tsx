import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';
import { RemoteFolderBrowser } from './RemoteFolderBrowser';
import { FolderBrowser } from './FolderBrowser';

interface Props {
  onClose: () => void;
}

type AuthMethod = 'password' | 'privatekey' | 'systemkey';
type Step = 'connect' | 'connected' | 'project';

export function SshProjectModal({ onClose }: Props) {
  const { activeEnvironmentId, projects, setProjects, addToast } = useStore();

  // Step
  const [step, setStep] = useState<Step>('connect');

  // Connection fields
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('systemkey');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [systemKeyPath, setSystemKeyPath] = useState('~/.ssh/id_ed25519');
  const [browsingKey, setBrowsingKey] = useState(false);
  const [generatedPubKey, setGeneratedPubKey] = useState('');

  // Connection state
  const [connectionId, setConnectionId] = useState('');
  const [connectionLabel, setConnectionLabel] = useState('');
  const [hasClaude, setHasClaude] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  // Project fields
  const [projectMode, setProjectMode] = useState<'new' | 'open'>('open');
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [initGit, setInitGit] = useState(false);

  const hostRef = useRef<HTMLInputElement>(null);

  useEffect(() => { hostRef.current?.focus(); }, []);

  const handleConnect = async () => {
    if (!host.trim() || !username.trim()) {
      setError('Host and username are required');
      return;
    }
    setConnecting(true);
    setError('');
    try {
      const body: any = {
        host: host.trim(),
        port: parseInt(port) || 22,
        username: username.trim(),
        auth_method: authMethod,
      };
      if (authMethod === 'password') body.password = password;
      if (authMethod === 'privatekey') {
        body.privateKey = privateKey;
        if (passphrase) body.passphrase = passphrase;
      }
      if (authMethod === 'systemkey') {
        body.systemKeyPath = systemKeyPath;
        if (passphrase) body.passphrase = passphrase;
      }

      const result = await api('POST', '/api/ssh/connect', body);
      setConnectionId(result.id);
      setConnectionLabel(result.label);
      setHasClaude(result.has_claude);
      setStep('connected');
    } catch (e: any) {
      setError(e.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleGenerateKeyPair = async () => {
    try {
      const result = await api('POST', '/api/ssh/generate-keypair');
      setPrivateKey(result.privateKey);
      setGeneratedPubKey(result.publicKey);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleCreateProject = async () => {
    if (!projectName.trim() || !projectPath.trim()) return;
    if (!activeEnvironmentId) return;
    try {
      const project = await api('POST', `/api/environments/${activeEnvironmentId}/projects`, {
        name: projectName.trim(),
        path: projectPath.trim(),
        initGit: projectMode === 'new' && initGit,
        ssh_connection_id: connectionId,
        remote_path: projectPath.trim(),
      });
      setProjects([...projects, {
        ...project,
        sessions: [], files: [], gitChanges: [], terminals: [], stashes: [],
        gitLog: { branches: [], currentBranch: '', commits: [], remotes: [] },
        activeSessionIdx: 0, activeTerminalIdx: 0,
      }]);
      onClose();
      addToast(projectName, projectMode === 'new' ? 'Remote project created' : 'Remote project opened', 'success');
    } catch (e: any) {
      setError(e.message);
    }
  };

  // Step 1: Connection
  if (step === 'connect') {
    return (
      <div className="modal" style={{ minWidth: 480 }}>
        <div className="modal-title">Connect Remote (SSH)</div>

        {error && <div className="modal-error" style={{ color: '#ff6b6b', marginBottom: 8, fontSize: 13 }}>{error}</div>}

        <div className="modal-field">
          <label className="modal-label">Host</label>
          <input ref={hostRef} type="text" value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.100"
            autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="modal-field" style={{ flex: 1 }}>
            <label className="modal-label">Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="user"
              autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
          </div>
          <div className="modal-field" style={{ width: 80 }}>
            <label className="modal-label">Port</label>
            <input type="text" value={port} onChange={e => setPort(e.target.value)} placeholder="22"
              autoComplete="off" data-form-type="other" />
          </div>
        </div>

        <div className="modal-field">
          <label className="modal-label">Authentication</label>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {(['systemkey', 'privatekey', 'password'] as AuthMethod[]).map(m => (
              <button key={m} className={`modal-btn ${authMethod === m ? 'confirm' : 'cancel'}`}
                style={{ flex: 1, padding: '4px 8px', fontSize: 12 }}
                onClick={() => setAuthMethod(m)}>
                {m === 'systemkey' ? 'System Key' : m === 'privatekey' ? 'Private Key' : 'Password'}
              </button>
            ))}
          </div>

          {authMethod === 'password' && (
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"
              autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
          )}

          {authMethod === 'privatekey' && (
            <>
              <textarea value={privateKey} onChange={e => setPrivateKey(e.target.value)}
                placeholder="Paste private key content..."
                style={{ width: '100%', height: 100, fontFamily: 'monospace', fontSize: 11, resize: 'vertical',
                  background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                  borderRadius: 4, padding: 6 }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)}
                  placeholder="Passphrase (optional)" style={{ flex: 1 }}
                  autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
                <button className="modal-btn cancel" style={{ fontSize: 11 }} onClick={handleGenerateKeyPair}>Generate Key Pair</button>
              </div>
              {generatedPubKey && (
                <div style={{ marginTop: 8 }}>
                  <label className="modal-label">Public Key (add to remote authorized_keys)</label>
                  <textarea readOnly value={generatedPubKey} onClick={e => (e.target as any).select()}
                    style={{ width: '100%', height: 60, fontFamily: 'monospace', fontSize: 10, resize: 'none',
                      background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
                      borderRadius: 4, padding: 6 }} />
                </div>
              )}
            </>
          )}

          {authMethod === 'systemkey' && (
            <>
              <div className="modal-path-row">
                <input type="text" value={systemKeyPath} onChange={e => setSystemKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
                <button className="modal-browse-btn" onClick={() => setBrowsingKey(!browsingKey)}>Browse</button>
              </div>
              {browsingKey && <FolderBrowser startPath={systemKeyPath} onSelect={p => { setSystemKeyPath(p); setBrowsingKey(false); }} />}
              <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)}
                placeholder="Passphrase (optional)" style={{ marginTop: 4 }}
                autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
            </>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn confirm" onClick={handleConnect} disabled={connecting}>
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Connected
  if (step === 'connected') {
    return (
      <div className="modal" style={{ minWidth: 420 }}>
        <div className="modal-title">Connected</div>

        {error && <div style={{ color: '#ff6b6b', marginBottom: 8, fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 12px',
          background: 'var(--bg-secondary)', borderRadius: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#51cf66', flexShrink: 0 }}></span>
          <span style={{ fontSize: 13 }}>{connectionLabel}</span>
        </div>

        {!hasClaude && (
          <div style={{ color: '#ffa726', fontSize: 12, marginBottom: 12, padding: '6px 10px',
            background: 'rgba(255,167,38,0.1)', borderRadius: 4 }}>
            Warning: <code>claude</code> CLI not found on remote. Install it before creating sessions.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="modal-btn confirm" style={{ flex: 1 }}
            onClick={() => { setProjectMode('new'); setStep('project'); }}>
            New Project
          </button>
          <button className="modal-btn confirm" style={{ flex: 1 }}
            onClick={() => { setProjectMode('open'); setStep('project'); }}>
            Open Existing
          </button>
        </div>

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="modal-btn cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  // Step 3: Project setup
  return (
    <div className="modal" style={{ minWidth: 480 }}>
      <div className="modal-title">{projectMode === 'new' ? 'New Remote Project' : 'Open Remote Project'}</div>

      {error && <div style={{ color: '#ff6b6b', marginBottom: 8, fontSize: 13 }}>{error}</div>}

      <div className="modal-field">
        <label className="modal-label">Project Name</label>
        <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="my-remote-project"
          autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" autoFocus />
      </div>

      <div className="modal-field">
        <label className="modal-label">Remote Path</label>
        <div className="modal-path-row">
          <input type="text" value={projectPath} onChange={e => setProjectPath(e.target.value)}
            placeholder="/home/user/projects/my-project"
            autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
          <button className="modal-browse-btn" onClick={() => setBrowsing(!browsing)}>Browse</button>
        </div>
        {browsing && <RemoteFolderBrowser connectionId={connectionId} startPath={projectPath || undefined}
          onSelect={p => { setProjectPath(p); setBrowsing(false); }} />}
      </div>

      {projectMode === 'new' && (
        <div className="modal-field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={initGit} onChange={e => setInitGit(e.target.checked)} />
            Initialize git repository
          </label>
        </div>
      )}

      <div className="modal-actions">
        <button className="modal-btn cancel" onClick={() => setStep('connected')}>Back</button>
        <button className="modal-btn confirm" onClick={handleCreateProject}>
          {projectMode === 'new' ? 'Create Project' : 'Open Project'}
        </button>
      </div>
    </div>
  );
}
