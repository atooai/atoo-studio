import React from 'react';
import { api } from '../../api';

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default_value?: string;
  primary_key?: boolean;
}

interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

interface ForeignKey {
  column: string;
  ref_table: string;
  ref_column: string;
}

interface SchemaInfo {
  table: string;
  columns: ColumnInfo[];
  indexes?: IndexInfo[];
  foreign_keys?: ForeignKey[];
}

interface Props {
  connectionId: string;
  table: string;
}

export function SchemaViewer({ connectionId, table }: Props) {
  const [schema, setSchema] = React.useState<SchemaInfo | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    setLoading(true);
    setError('');
    api('GET', `/api/databases/${connectionId}/tables/${encodeURIComponent(table)}`)
      .then(data => setSchema(data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [connectionId, table]);

  if (loading) return <div className="database-explorer-placeholder">Loading schema...</div>;
  if (error) return <div className="database-query-error">{error}</div>;
  if (!schema) return null;

  return (
    <div className="database-schema-viewer">
      <h3 className="database-schema-title">{schema.table}</h3>

      <div className="database-schema-section">
        <h4>Columns ({schema.columns.length})</h4>
        <table className="database-results-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Key</th>
            </tr>
          </thead>
          <tbody>
            {schema.columns.map(col => (
              <tr key={col.name}>
                <td><strong>{col.name}</strong></td>
                <td><code>{col.type}</code></td>
                <td>{col.nullable ? 'YES' : 'NO'}</td>
                <td>{col.default_value || '-'}</td>
                <td>{col.primary_key ? '🔑 PK' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {schema.indexes && schema.indexes.length > 0 && (
        <div className="database-schema-section">
          <h4>Indexes ({schema.indexes.length})</h4>
          <table className="database-results-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
              </tr>
            </thead>
            <tbody>
              {schema.indexes.map(idx => (
                <tr key={idx.name}>
                  <td>{idx.name}</td>
                  <td>{idx.columns.join(', ')}</td>
                  <td>{idx.unique ? 'YES' : 'NO'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {schema.foreign_keys && schema.foreign_keys.length > 0 && (
        <div className="database-schema-section">
          <h4>Foreign Keys ({schema.foreign_keys.length})</h4>
          <table className="database-results-table">
            <thead>
              <tr>
                <th>Column</th>
                <th>References</th>
              </tr>
            </thead>
            <tbody>
              {schema.foreign_keys.map((fk, i) => (
                <tr key={i}>
                  <td>{fk.column}</td>
                  <td>{fk.ref_table}.{fk.ref_column}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
