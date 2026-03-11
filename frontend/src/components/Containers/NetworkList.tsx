import React from 'react';
import { api } from '../../api';

type Runtime = 'docker' | 'podman' | 'lxc';

export function NetworkList({ runtime }: { runtime: Runtime }) {
  const [networks, setNetworks] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const url = runtime === 'lxc'
      ? '/api/containers/lxc/networks'
      : `/api/containers/${runtime}/networks`;
    setLoading(true);
    api('GET', url)
      .then(data => { setNetworks(data); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runtime]);

  if (loading && networks.length === 0) return <div className="container-manager-empty">Loading networks...</div>;
  if (error) return <div className="container-manager-error">{error}</div>;
  if (networks.length === 0) return <div className="container-manager-empty">No networks found</div>;

  if (runtime === 'lxc') {
    return (
      <table className="container-table">
        <thead><tr><th>Name</th><th>Type</th><th>Managed</th><th>Description</th></tr></thead>
        <tbody>
          {networks.map((net: any) => (
            <tr key={net.name}>
              <td className="container-name-cell">{net.name}</td>
              <td>{net.type || '-'}</td>
              <td>{net.managed ? 'Yes' : 'No'}</td>
              <td>{net.description || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <table className="container-table">
      <thead><tr><th>Name</th><th>ID</th><th>Driver</th><th>Scope</th></tr></thead>
      <tbody>
        {networks.map((net: any) => {
          const id = net.ID || net.Id || net.id || '';
          const name = net.Name || net.name || '';
          return (
            <tr key={id || name}>
              <td className="container-name-cell">{name}</td>
              <td className="container-id-cell">{(typeof id === 'string' ? id : '').slice(0, 12)}</td>
              <td>{net.Driver || net.driver || '-'}</td>
              <td>{net.Scope || net.scope || '-'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
