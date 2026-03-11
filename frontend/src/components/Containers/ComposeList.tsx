import React from 'react';
import { api } from '../../api';

type Runtime = 'docker' | 'podman' | 'lxc';

export function ComposeList({ runtime }: { runtime: Runtime }) {
  const [stacks, setStacks] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    setLoading(true);
    api('GET', `/api/containers/${runtime}/compose`)
      .then(data => { setStacks(data); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runtime]);

  if (loading && stacks.length === 0) return <div className="container-manager-empty">Loading compose stacks...</div>;
  if (error) return <div className="container-manager-error">{error}</div>;
  if (stacks.length === 0) return <div className="container-manager-empty">No compose stacks found</div>;

  return (
    <table className="container-table">
      <thead><tr><th>Name</th><th>Status</th><th>Config Files</th></tr></thead>
      <tbody>
        {stacks.map((stack: any, i: number) => {
          const name = stack.Name || stack.name || '-';
          const status = stack.Status || stack.status || '-';
          const configFiles = stack.ConfigFiles || stack.configFiles || '-';
          return (
            <tr key={name + i}>
              <td className="container-name-cell">{name}</td>
              <td>{status}</td>
              <td className="container-config-cell">{configFiles}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
