import React from 'react';
import { api } from '../../api';

type Runtime = 'docker' | 'podman' | 'lxc';

export function ImageList({ runtime }: { runtime: Runtime }) {
  const [images, setImages] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  const fetchImages = React.useCallback(() => {
    const url = runtime === 'lxc'
      ? '/api/containers/lxc/images'
      : `/api/containers/${runtime}/images`;
    setLoading(true);
    api('GET', url)
      .then(data => { setImages(data); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runtime]);

  React.useEffect(() => { fetchImages(); }, [fetchImages]);

  const doRemove = async (id: string) => {
    if (!confirm(`Remove image ${id}?`)) return;
    try {
      const url = runtime === 'lxc'
        ? `/api/containers/lxc/images/${encodeURIComponent(id)}`
        : `/api/containers/${runtime}/images/${encodeURIComponent(id)}`;
      await api('DELETE', url);
      fetchImages();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading && images.length === 0) return <div className="container-manager-empty">Loading images...</div>;
  if (error) return <div className="container-manager-error">{error}</div>;
  if (images.length === 0) return <div className="container-manager-empty">No images found</div>;

  if (runtime === 'lxc') {
    return (
      <table className="container-table">
        <thead><tr><th>Alias</th><th>Fingerprint</th><th>Description</th><th>Size</th><th>Actions</th></tr></thead>
        <tbody>
          {images.map((img: any) => {
            const fp = img.fingerprint || '';
            const alias = (img.aliases || []).map((a: any) => a.name).join(', ') || '-';
            const desc = img.properties?.description || '-';
            const size = img.size ? `${(img.size / 1024 / 1024).toFixed(1)} MB` : '-';
            return (
              <tr key={fp}>
                <td>{alias}</td>
                <td className="container-id-cell">{fp.slice(0, 12)}</td>
                <td>{desc}</td>
                <td>{size}</td>
                <td className="container-actions-cell">
                  <button className="container-action-btn danger" onClick={() => doRemove(fp)} title="Remove">✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <table className="container-table">
      <thead><tr><th>Repository</th><th>Tag</th><th>ID</th><th>Size</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>
        {images.map((img: any, i: number) => {
          const id = img.ID || img.Id || img.id || '';
          const repo = img.Repository || img.repository || (img.RepoTags?.[0]?.split(':')[0]) || '<none>';
          const tag = img.Tag || img.tag || (img.RepoTags?.[0]?.split(':')[1]) || '<none>';
          const size = img.Size || img.size || '-';
          const created = img.CreatedAt || img.Created || img.created || '-';
          return (
            <tr key={id || i}>
              <td>{repo}</td>
              <td>{tag}</td>
              <td className="container-id-cell">{(typeof id === 'string' ? id : '').replace('sha256:', '').slice(0, 12)}</td>
              <td>{size}</td>
              <td className="container-created-cell">{created}</td>
              <td className="container-actions-cell">
                <button className="container-action-btn danger" onClick={() => doRemove(id)} title="Remove">✕</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
