import React from 'react';
import { api } from '../../api';
import { ContainerList } from './ContainerList';
import { ImageList } from './ImageList';
import { VolumeList } from './VolumeList';
import { NetworkList } from './NetworkList';
import { ComposeList } from './ComposeList';
import { LxcStorageList } from './LxcStorageList';
import { ContainerLogs } from './ContainerLogs';
import { ContainerShell } from './ContainerShell';
import { ContainerStats } from './ContainerStats';

type Runtime = 'docker' | 'podman' | 'lxc';
type SubTab = 'containers' | 'images' | 'volumes' | 'networks' | 'compose' | 'storage';

interface BottomPanel {
  type: 'logs' | 'shell' | 'stats';
  runtime: Runtime;
  containerId: string;
  containerName: string;
}

interface RuntimeStatus {
  installed: boolean;
  accessible: boolean;
  error?: string;
}

interface Runtimes {
  docker: RuntimeStatus;
  podman: RuntimeStatus;
  lxc: RuntimeStatus;
}

const RUNTIME_LABELS: Record<Runtime, string> = {
  docker: 'Docker',
  podman: 'Podman',
  lxc: 'LXC',
};

function getSubTabs(runtime: Runtime): { id: SubTab; label: string }[] {
  if (runtime === 'lxc') {
    return [
      { id: 'containers', label: 'Containers' },
      { id: 'images', label: 'Images' },
      { id: 'storage', label: 'Storage' },
      { id: 'networks', label: 'Networks' },
    ];
  }
  return [
    { id: 'containers', label: 'Containers' },
    { id: 'images', label: 'Images' },
    { id: 'volumes', label: 'Volumes' },
    { id: 'networks', label: 'Networks' },
    { id: 'compose', label: 'Compose Stacks' },
  ];
}

export function ContainerManager({ onClose }: { onClose: () => void }) {
  const [runtimes, setRuntimes] = React.useState<Runtimes | null>(null);
  const [activeRuntime, setActiveRuntime] = React.useState<Runtime | null>(null);
  const [activeSubTab, setActiveSubTab] = React.useState<SubTab>('containers');
  const [bottomPanel, setBottomPanel] = React.useState<BottomPanel | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    const none: RuntimeStatus = { installed: false, accessible: false };
    api('GET', '/api/containers/runtimes').then((data: Runtimes) => {
      setRuntimes(data);
      // Select first accessible runtime
      if (data.docker?.accessible) setActiveRuntime('docker');
      else if (data.podman?.accessible) setActiveRuntime('podman');
      else if (data.lxc?.accessible) setActiveRuntime('lxc');
    }).catch(() => setRuntimes({ docker: none, podman: none, lxc: none }));
  }, []);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Auto-refresh every 10s
  React.useEffect(() => {
    const interval = setInterval(() => setRefreshKey(k => k + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Reset sub-tab when switching runtime
  React.useEffect(() => {
    setActiveSubTab('containers');
    setBottomPanel(null);
  }, [activeRuntime]);

  if (!runtimes) {
    return (
      <div className="container-manager" onClick={e => e.stopPropagation()}>
        <div className="container-manager-header">
          <h2>Container Management</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="container-manager-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="text-muted">Loading...</span>
        </div>
      </div>
    );
  }

  if (!activeRuntime) {
    return (
      <div className="container-manager" onClick={e => e.stopPropagation()}>
        <div className="container-manager-header">
          <h2>Container Management</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="container-manager-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="text-muted">No container runtimes available</span>
        </div>
      </div>
    );
  }

  const subTabs = getSubTabs(activeRuntime);
  const runtimeEntries: Runtime[] = ['docker', 'podman', 'lxc'];

  const openPanel = (type: BottomPanel['type'], containerId: string, containerName: string) => {
    setBottomPanel({ type, runtime: activeRuntime, containerId, containerName });
  };

  const renderContent = () => {
    if (!activeRuntime) return null;
    const key = `${activeRuntime}-${activeSubTab}-${refreshKey}`;
    switch (activeSubTab) {
      case 'containers':
        return <ContainerList key={key} runtime={activeRuntime} onOpenPanel={openPanel} />;
      case 'images':
        return <ImageList key={key} runtime={activeRuntime} />;
      case 'volumes':
        return <VolumeList key={key} runtime={activeRuntime} />;
      case 'networks':
        return <NetworkList key={key} runtime={activeRuntime} />;
      case 'compose':
        return <ComposeList key={key} runtime={activeRuntime} />;
      case 'storage':
        return <LxcStorageList key={key} />;
      default:
        return null;
    }
  };

  return (
    <div className="container-manager" onClick={e => e.stopPropagation()}>
      <div className="container-manager-header">
        <h2>Container Management</h2>
        <div className="container-manager-tabs">
          {runtimeEntries.map(rt => {
            const status = runtimes[rt];
            const isDisabled = !status.installed || !status.accessible;
            let tooltip = '';
            if (!status.installed) tooltip = `${RUNTIME_LABELS[rt]} is not installed`;
            else if (!status.accessible) tooltip = status.error || `${RUNTIME_LABELS[rt]}: permission denied`;
            return (
              <button
                key={rt}
                className={`container-manager-tab ${activeRuntime === rt ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
                onClick={() => !isDisabled && setActiveRuntime(rt)}
                title={tooltip}
              >
                {RUNTIME_LABELS[rt]}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button className="container-manager-refresh" onClick={() => setRefreshKey(k => k + 1)} title="Refresh">
          ↻
        </button>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>
      <div className="container-manager-subtabs">
        {subTabs.map(tab => (
          <button
            key={tab.id}
            className={`container-manager-subtab ${activeSubTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveSubTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={`container-manager-body ${bottomPanel ? 'has-bottom' : ''}`}>
        <div className="container-manager-content">
          {renderContent()}
        </div>
        {bottomPanel && (
          <div className="container-manager-bottom">
            <div className="container-manager-bottom-header">
              <span className="container-manager-bottom-title">
                {bottomPanel.type === 'logs' ? 'Logs' : bottomPanel.type === 'shell' ? 'Shell' : 'Stats'}
                {' — '}
                {bottomPanel.containerName}
              </span>
              <button className="container-manager-bottom-close" onClick={() => setBottomPanel(null)}>&times;</button>
            </div>
            <div className="container-manager-bottom-content">
              {bottomPanel.type === 'logs' && (
                <ContainerLogs runtime={bottomPanel.runtime} containerId={bottomPanel.containerId} />
              )}
              {bottomPanel.type === 'shell' && (
                <ContainerShell runtime={bottomPanel.runtime} containerId={bottomPanel.containerId} />
              )}
              {bottomPanel.type === 'stats' && (
                <ContainerStats runtime={bottomPanel.runtime} containerId={bottomPanel.containerId} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
