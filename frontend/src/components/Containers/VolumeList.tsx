import React from 'react';
import { api } from '../../api';

type Runtime = 'docker' | 'podman' | 'lxc';

export function VolumeList({ runtime }: { runtime: Runtime }) {
  const [volumes, setVolumes] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [inspectData, setInspectData] = React.useState<Record<string, any>>({});
  const [expandedVolume, setExpandedVolume] = React.useState<string | null>(null);

  const fetchVolumes = React.useCallback(() => {
    setLoading(true);
    api('GET', `/api/containers/${runtime}/volumes`)
      .then(data => { setVolumes(data); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runtime]);

  React.useEffect(() => { fetchVolumes(); }, [fetchVolumes]);

  const toggleInspect = async (name: string) => {
    if (expandedVolume === name) {
      setExpandedVolume(null);
      return;
    }
    if (!inspectData[name]) {
      try {
        const data = await api('GET', `/api/containers/${runtime}/volumes/${encodeURIComponent(name)}/inspect`);
        setInspectData(prev => ({ ...prev, [name]: data }));
      } catch (e: any) {
        setError(e.message);
        return;
      }
    }
    setExpandedVolume(name);
  };

  if (loading && volumes.length === 0) return <div className="container-manager-empty">Loading volumes...</div>;
  if (error) return <div className="container-manager-error">{error}</div>;
  if (volumes.length === 0) return <div className="container-manager-empty">No volumes found</div>;

  return (
    <div>
      <table className="container-table">
        <thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th>Actions</th></tr></thead>
        <tbody>
          {volumes.map((vol: any) => {
            const name = vol.Name || vol.name || '';
            const driver = vol.Driver || vol.driver || '-';
            const mountpoint = vol.Mountpoint || vol.mountpoint || '-';
            return (
              <React.Fragment key={name}>
                <tr>
                  <td className="container-name-cell">{name}</td>
                  <td>{driver}</td>
                  <td className="container-mount-cell">{mountpoint}</td>
                  <td className="container-actions-cell">
                    <button className="container-action-btn" onClick={() => toggleInspect(name)} title="Inspect">
                      {expandedVolume === name ? '▾' : '▸'}
                    </button>
                  </td>
                </tr>
                {expandedVolume === name && inspectData[name] && (
                  <tr>
                    <td colSpan={4}>
                      <pre className="container-inspect-json">{JSON.stringify(inspectData[name], null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
