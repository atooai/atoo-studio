import React from 'react';
import { api } from '../../api';

export function LxcStorageList() {
  const [pools, setPools] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [inspectData, setInspectData] = React.useState<Record<string, any>>({});
  const [expandedPool, setExpandedPool] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLoading(true);
    api('GET', '/api/containers/lxc/storage')
      .then(data => { setPools(data); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const toggleInspect = async (name: string) => {
    if (expandedPool === name) {
      setExpandedPool(null);
      return;
    }
    if (!inspectData[name]) {
      try {
        const data = await api('GET', `/api/containers/lxc/storage/${encodeURIComponent(name)}`);
        setInspectData(prev => ({ ...prev, [name]: data }));
      } catch (e: any) {
        setError(e.message);
        return;
      }
    }
    setExpandedPool(name);
  };

  if (loading && pools.length === 0) return <div className="container-manager-empty">Loading storage pools...</div>;
  if (error) return <div className="container-manager-error">{error}</div>;
  if (pools.length === 0) return <div className="container-manager-empty">No storage pools found</div>;

  return (
    <table className="container-table">
      <thead><tr><th>Name</th><th>Driver</th><th>Description</th><th>Actions</th></tr></thead>
      <tbody>
        {pools.map((pool: any) => {
          const name = pool.name || '';
          return (
            <React.Fragment key={name}>
              <tr>
                <td className="container-name-cell">{name}</td>
                <td>{pool.driver || '-'}</td>
                <td>{pool.description || '-'}</td>
                <td className="container-actions-cell">
                  <button className="container-action-btn" onClick={() => toggleInspect(name)} title="Inspect">
                    {expandedPool === name ? '▾' : '▸'}
                  </button>
                </td>
              </tr>
              {expandedPool === name && inspectData[name] && (
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
  );
}
