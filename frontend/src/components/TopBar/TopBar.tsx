import React from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';
import { UserMenu } from './UserMenu';
import { api } from '../../api';

function useIsStandalone() {
  return React.useMemo(() =>
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true, []);
}

function usePwaInstallPrompt() {
  const [prompt, setPrompt] = React.useState<any>(null);
  const [swReady, setSwReady] = React.useState(false);
  const isStandalone = useIsStandalone();

  React.useEffect(() => {
    if (isStandalone) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Try registering service worker to detect cert trust status
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then(() => setSwReady(true))
        .catch(() => setSwReady(false));
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [isStandalone]);

  return { prompt, swReady, isStandalone };
}

export function TopBar() {
  const {
    activeProjectId, projects, environments, activeEnvironmentId,
    setModal, reportedServices, serialRequests,
  } = useStore();

  const proj = projects.find(p => p.id === activeProjectId);
  const projectName = proj ? proj.name : 'Home';
  const breadcrumb = proj ? proj.path : '';
  const { prompt: installPrompt, swReady, isStandalone } = usePwaInstallPrompt();
  const [showCertDialog, setShowCertDialog] = React.useState(false);
  const [containerRuntimes, setContainerRuntimes] = React.useState<Record<string, { installed: boolean; accessible: boolean; error?: string }> | null>(null);
  const [updateAvailable, setUpdateAvailable] = React.useState(false);

  React.useEffect(() => {
    api('GET', '/api/containers/runtimes')
      .then(data => setContainerRuntimes(data))
      .catch(() => setContainerRuntimes(null));
    // Auto-check for updates on startup
    api('GET', '/api/check-update')
      .then(data => { if (data.updateAvailable) setUpdateAvailable(true); })
      .catch(() => {});
  }, []);

  const handleInstall = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
    } else if (swReady || window.isSecureContext) {
      // Cert is trusted (valid cert or reverse proxy), but browser hasn't offered install.
      // This can happen if the browser doesn't support PWA install or hasn't fired the event yet.
      alert('Your browser does not support app installation, or the install prompt is not available yet. Try reloading the page.');
    } else {
      // SW failed to register (likely untrusted cert) — show trust dialog
      setShowCertDialog(true);
    }
  };

  return (
    <>
      <div id="topbar">
        <span className="topbar-project-name">{projectName}</span>
        <span className="topbar-breadcrumb">{breadcrumb}</span>
        <div className="topbar-spacer"></div>
        <div className="topbar-actions">
          <EnvSelector />
          <button className="topbar-btn" onClick={() => setModal({ type: 'forwarded-connections' })} title="View forwarded TCP services and serial devices">
            ⇌ Connections{(reportedServices.length + serialRequests.length) > 0 ? ` (${reportedServices.length + serialRequests.length})` : ''}
          </button>
          <button className="topbar-btn" onClick={() => setModal({ type: 'database-explorer' })} title="Browse databases">🗄 Databases</button>
          {containerRuntimes && Object.values(containerRuntimes).some(r => r.installed) && (
            <button className="topbar-btn" onClick={() => setModal({ type: 'container-manager' })} title="Manage Docker/Podman/LXC containers">⊞ Containers</button>
          )}
          <LayoutToggle />
          <button className="topbar-btn" onClick={() => (window as any).togglePreviewPanel()} title="Toggle app preview panel">⬒ Preview</button>
          <button className="topbar-btn" onClick={() => setModal({ type: 'help' })} title="Help & keyboard shortcuts (F1)">
            ? Help
            {updateAvailable && <span className="topbar-update-dot" title="Update available" />}
          </button>
          {!isStandalone && (
            <button className="topbar-btn" onClick={handleInstall} title="Install as desktop application">
              ⤓ Install App
            </button>
          )}
          <UserMenu />
        </div>
      </div>
      {showCertDialog && <CertTrustDialog onClose={() => setShowCertDialog(false)} />}
    </>
  );
}

function CertTrustDialog({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = React.useState<string>(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (/android/.test(ua)) return 'android';
    if (/iphone|ipad/.test(ua)) return 'ios';
    if (/mac/.test(ua)) return 'macos';
    if (/linux/.test(ua)) return 'linux';
    return 'windows';
  });

  const tabs: { id: string; label: string }[] = [
    { id: 'android', label: 'Android' },
    { id: 'ios', label: 'iOS' },
    { id: 'windows', label: 'Windows' },
    { id: 'macos', label: 'macOS' },
    { id: 'linux', label: 'Linux' },
  ];

  const instructions: Record<string, string[]> = {
    android: [
      'Tap "Download Certificate" below',
      'Open Settings → Security → Encryption & credentials',
      'Tap "Install a certificate" → "CA certificate"',
      'Select the downloaded file and confirm',
      'Come back here and reload the page',
    ],
    ios: [
      'Tap "Download Certificate" below',
      'A prompt "Profile Downloaded" will appear — tap "Close"',
      'Open Settings → General → VPN & Device Management',
      'Tap the "Atoo Studio" profile → Install',
      'Go to Settings → General → About → Certificate Trust Settings',
      'Enable the Atoo Studio CA certificate',
      'Come back here and reload the page',
    ],
    windows: [
      'Click "Download Certificate" below',
      'Double-click the downloaded .crt file',
      'Click "Install Certificate" → select "Local Machine" → Next',
      'Choose "Place all certificates in the following store"',
      'Click Browse → select "Trusted Root Certification Authorities" → OK',
      'Click Next → Finish → confirm the security warning',
      'Fully close all Chrome windows (check system tray!) and reopen Chrome',
    ],
    macos: [
      'Click "Download Certificate" below',
      'Double-click the downloaded file — it opens in Keychain Access',
      'Double-click the "Atoo Studio" certificate entry',
      'Expand "Trust" → set "When using this certificate" to "Always Trust"',
      'Close the window, enter your password to confirm',
      'Reload this page',
    ],
    linux: [
      'Click "Download Certificate" below',
      'Copy the file to your system CA store:',
      '  sudo cp atoo-studio-ca.pem /usr/local/share/ca-certificates/atoo-studio-ca.crt',
      '  sudo update-ca-certificates',
      'For Chrome/Chromium, also import into NSS:',
      '  certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Atoo Studio" -i atoo-studio-ca.pem',
      'Restart your browser and reload this page',
    ],
  };

  return (
    <div className="cert-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cert-dialog">
        <div className="cert-dialog-header">
          <span className="cert-dialog-title">Install Atoo Studio as App</span>
          <button className="cert-dialog-close" onClick={onClose}>✕</button>
        </div>

        <div className="cert-dialog-body">
          <p className="cert-dialog-desc">
            Your browser needs to trust this server's certificate before the app can be installed.
            This is a <strong>one-time setup</strong>.
          </p>

          <div className="cert-dialog-step">
            <span className="cert-dialog-step-num">1</span>
            <span>Select your platform & download the certificate</span>
          </div>

          <div className="cert-dialog-tabs">
            {tabs.map(t => (
              <button
                key={t.id}
                className={`cert-dialog-tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {(() => {
            const useCrt = activeTab === 'windows' || activeTab === 'ios' || activeTab === 'android';
            const href = useCrt ? '/ca.crt' : '/ca.pem';
            const filename = useCrt ? 'atoo-studio-ca.crt' : 'atoo-studio-ca.pem';
            return (
              <a className="cert-dialog-download-btn" href={href} download={filename}>
                ⤓ Download CA Certificate ({useCrt ? '.crt' : '.pem'})
              </a>
            );
          })()}

          <div className="cert-dialog-step">
            <span className="cert-dialog-step-num">2</span>
            <span>Install it on your device</span>
          </div>

          <ol className="cert-dialog-instructions">
            {instructions[activeTab]?.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>

          <div className="cert-dialog-step">
            <span className="cert-dialog-step-num">3</span>
            <span>Reload this page and tap "Install App" again</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function EnvSelector() {
  const { environments, activeEnvironmentId } = useStore();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const activeEnv = environments.find(e => e.id === activeEnvironmentId);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <div className="env-selector" ref={ref}>
      <button className="env-selector-btn" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span className="env-selector-name">{activeEnv?.name || 'Default'}</span>
        <span className="env-selector-arrow">▾</span>
      </button>
      <div className={`env-dropdown ${open ? 'visible' : ''}`}>
        <div className="env-dropdown-list">
          {environments.map(env => (
            <div
              key={env.id}
              className={`env-dropdown-item ${env.id === activeEnvironmentId ? 'active' : ''}`}
              onClick={() => { (window as any).navigate('/env/' + env.id); setOpen(false); }}
            >
              <span className="env-dropdown-icon">◈</span>
              {env.name}
              <span className="env-dropdown-count">{env.project_count || 0}</span>
            </div>
          ))}
        </div>
        <div className="env-dropdown-sep"></div>
        <div className="env-dropdown-item env-dropdown-new" onClick={() => { setOpen(false); (window as any).createEnvironmentFromDropdown(); }}>
          <span className="env-dropdown-icon">+</span> New Environment
        </div>
      </div>
    </div>
  );
}

const LAYOUT_CYCLE: Array<{ key: 'classic' | 'carousel' | 'niri'; icon: string; label: string }> = [
  { key: 'classic', icon: '⊞', label: 'Classic' },
  { key: 'carousel', icon: '⇔', label: 'Carousel' },
  { key: 'niri', icon: '⊟', label: 'Niri' },
];

function LayoutToggle() {
  const { workspaceLayout, setWorkspaceLayout } = useStore();
  const currentIdx = LAYOUT_CYCLE.findIndex(l => l.key === workspaceLayout);
  const current = LAYOUT_CYCLE[currentIdx >= 0 ? currentIdx : 0];
  const nextIdx = (currentIdx + 1) % LAYOUT_CYCLE.length;
  const next = LAYOUT_CYCLE[nextIdx];
  return (
    <button
      className={`topbar-btn ${workspaceLayout !== 'classic' ? 'active' : ''}`}
      onClick={() => setWorkspaceLayout(next.key)}
      title={`Switch to ${next.label} layout`}
    >
      {current.icon} {current.label}
    </button>
  );
}
