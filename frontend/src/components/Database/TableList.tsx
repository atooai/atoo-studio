import React from 'react';
import { api } from '../../api';

interface TableInfo {
  name: string;
  type?: string;
  row_count?: number;
  size_bytes?: number;
}

interface Props {
  connectionId: string;
  selectedTable: string | null;
  onSelectTable: (table: string) => void;
  refreshKey: number;
}

export function TableList({ connectionId, selectedTable, onSelectTable, refreshKey }: Props) {
  const [tables, setTables] = React.useState<TableInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState('');

  React.useEffect(() => {
    setLoading(true);
    api('GET', `/api/databases/${connectionId}/tables`)
      .then(data => setTables(data))
      .catch(() => setTables([]))
      .finally(() => setLoading(false));
  }, [connectionId, refreshKey]);

  const filtered = filter
    ? tables.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()))
    : tables;

  return (
    <div className="database-table-list">
      <div className="database-table-list-header">
        <span className="database-table-list-title">Tables ({tables.length})</span>
      </div>
      <input
        className="database-table-filter"
        type="text"
        placeholder="Filter tables..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <div className="database-table-list-items">
        {loading && <div className="database-explorer-empty-hint">Loading...</div>}
        {!loading && filtered.length === 0 && (
          <div className="database-explorer-empty-hint">
            {tables.length === 0 ? 'No tables' : 'No matches'}
          </div>
        )}
        {filtered.map(t => (
          <div
            key={t.name}
            className={`database-table-item ${selectedTable === t.name ? 'active' : ''}`}
            onClick={() => onSelectTable(t.name)}
          >
            <span className="database-table-icon">{t.type === 'view' ? '👁' : '▤'}</span>
            <span className="database-table-name">{t.name}</span>
            {t.row_count != null && (
              <span className="database-table-count">{formatCount(t.row_count)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
