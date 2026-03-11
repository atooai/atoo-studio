import React from 'react';
import { api } from '../../api';

type Runtime = 'docker' | 'podman' | 'lxc';

interface Props {
  runtime: Runtime;
  onOpenPanel: (type: 'logs' | 'shell' | 'stats', containerId: string, containerName: string) => void;
}

function getStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('running') || s.includes('up')) return 'container-status-running';
  if (s.includes('paused')) return 'container-status-paused';
  return 'container-status-stopped';
}

export function ContainerList({ runtime, onOpenPanel }: Props) {
  const [containers, setContainers] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  const fetchContainers = React.useCallback(() => {
    const url = runtime === 'lxc'
      ? '/api/containers/lxc/containers'
      : `/api/containers/${runtime}/containers`;
    setLoading(true);
    api('GET', url)
      .then(data => { setContainers(data); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runtime]);

  React.useEffect(() => { fetchContainers(); }, [fetchContainers]);

  const doAction = async (id: string, action: string) => {
    setActionLoading(`${id}-${action}`);
    try {
      const url = runtime === 'lxc'
        ? `/api/containers/lxc/containers/${encodeURIComponent(id)}/${action}`
        : `/api/containers/${runtime}/containers/${encodeURIComponent(id)}/${action}`;
      await api('POST', url);
      fetchContainers();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const doRemove = async (id: string) => {
    if (!confirm(`Remove container ${id}?`)) return;
    setActionLoading(`${id}-remove`);
    try {
      const url = runtime === 'lxc'
        ? `/api/containers/lxc/containers/${encodeURIComponent(id)}`
        : `/api/containers/${runtime}/containers/${encodeURIComponent(id)}`;
      await api('DELETE', url);
      fetchContainers();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading && containers.length === 0) {
    return <div className="container-manager-empty">Loading containers...</div>;
  }

  if (error) {
    return <div className="container-manager-error">{error}</div>;
  }

  if (containers.length === 0) {
    return <div className="container-manager-empty">No containers found</div>;
  }

  if (runtime === 'lxc') {
    return (
      <table className="container-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Type</th>
            <th>IPv4</th>
            <th>IPv6</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c: any) => {
            const name = c.name || '';
            const status = c.status || '';
            const ipv4 = (c.state?.network?.eth0?.addresses || []).find((a: any) => a.family === 'inet')?.address || '-';
            const ipv6 = (c.state?.network?.eth0?.addresses || []).find((a: any) => a.family === 'inet6')?.address || '-';
            return (
              <tr key={name}>
                <td className="container-name-cell">{name}</td>
                <td><span className={`container-status ${getStatusClass(status)}`}>{status}</span></td>
                <td>{c.type || '-'}</td>
                <td>{ipv4}</td>
                <td>{ipv6}</td>
                <td className="container-actions-cell">
                  <button className="container-action-btn" onClick={() => doAction(name, 'start')} disabled={actionLoading !== null} title="Start">▶</button>
                  <button className="container-action-btn" onClick={() => doAction(name, 'stop')} disabled={actionLoading !== null} title="Stop">■</button>
                  <button className="container-action-btn" onClick={() => doAction(name, 'restart')} disabled={actionLoading !== null} title="Restart">↻</button>
                  <button className="container-action-btn" onClick={() => onOpenPanel('logs', name, name)} title="Logs">📋</button>
                  <button className="container-action-btn" onClick={() => onOpenPanel('shell', name, name)} title="Shell">⌨</button>
                  <button className="container-action-btn danger" onClick={() => doRemove(name)} disabled={actionLoading !== null} title="Remove">✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  // Docker/Podman
  return (
    <table className="container-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Image</th>
          <th>Status</th>
          <th>Ports</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((c: any) => {
          const id = c.ID || c.Id || c.id || '';
          const name = c.Names || c.Name || c.name || id.slice(0, 12);
          const displayName = Array.isArray(name) ? name[0]?.replace(/^\//, '') : name.replace(/^\//, '');
          const image = c.Image || c.image || '-';
          const status = c.Status || c.State || c.status || '-';
          const ports = c.Ports || c.ports || '-';
          const portsStr = typeof ports === 'string' ? ports : Array.isArray(ports) ? ports.map((p: any) =>
            p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}/${p.Type || 'tcp'}` : `${p.PrivatePort}/${p.Type || 'tcp'}`
          ).join(', ') : '-';
          const created = c.CreatedAt || c.Created || c.created || '-';
          const isRunning = status.toLowerCase().includes('up') || status.toLowerCase().includes('running');
          return (
            <tr key={id}>
              <td className="container-name-cell">{displayName}</td>
              <td className="container-image-cell">{image}</td>
              <td><span className={`container-status ${getStatusClass(status)}`}>{status}</span></td>
              <td className="container-ports-cell">{portsStr}</td>
              <td className="container-created-cell">{created}</td>
              <td className="container-actions-cell">
                <button className="container-action-btn" onClick={() => doAction(id, 'start')} disabled={actionLoading !== null || isRunning} title="Start">▶</button>
                <button className="container-action-btn" onClick={() => doAction(id, 'stop')} disabled={actionLoading !== null || !isRunning} title="Stop">■</button>
                <button className="container-action-btn" onClick={() => doAction(id, 'restart')} disabled={actionLoading !== null} title="Restart">↻</button>
                <button className="container-action-btn" onClick={() => onOpenPanel('logs', id, displayName)} title="Logs">📋</button>
                <button className="container-action-btn" onClick={() => onOpenPanel('shell', id, displayName)} title="Shell">⌨</button>
                {isRunning && <button className="container-action-btn" onClick={() => onOpenPanel('stats', id, displayName)} title="Stats">📊</button>}
                <button className="container-action-btn danger" onClick={() => doRemove(id)} disabled={actionLoading !== null} title="Remove">✕</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
