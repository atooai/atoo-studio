import React from 'react';
import { api } from '../../api';

const DB_TYPES = [
  { value: 'postgresql', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'mariadb', label: 'MariaDB', defaultPort: 3306 },
  { value: 'sqlite', label: 'SQLite', defaultPort: 0 },
  { value: 'redis', label: 'Redis', defaultPort: 6379 },
  { value: 'mongodb', label: 'MongoDB', defaultPort: 27017 },
{ value: 'elasticsearch', label: 'Elasticsearch', defaultPort: 9200 },
  { value: 'opensearch', label: 'OpenSearch', defaultPort: 9200 },
  { value: 'clickhouse', label: 'ClickHouse', defaultPort: 8123 },
  { value: 'cockroachdb', label: 'CockroachDB', defaultPort: 26257 },
  { value: 'neo4j', label: 'Neo4j', defaultPort: 7687 },
  { value: 'influxdb', label: 'InfluxDB', defaultPort: 8086 },
  { value: 'cassandra', label: 'Cassandra', defaultPort: 9042 },
  { value: 'scylladb', label: 'ScyllaDB', defaultPort: 9042 },
  { value: 'memcached', label: 'Memcached', defaultPort: 11211 },
];

interface Props {
  onConnect: (dbType: string, params: any, name: string) => Promise<void>;
  onCancel: () => void;
}

export function AddConnectionForm({ onConnect, onCancel }: Props) {
  const [dbType, setDbType] = React.useState('postgresql');
  const [host, setHost] = React.useState('localhost');
  const [port, setPort] = React.useState('5432');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [database, setDatabase] = React.useState('');
  const [filename, setFilename] = React.useState('');
  const [connectionString, setConnectionString] = React.useState('');
  const [name, setName] = React.useState('');
  const [useConnString, setUseConnString] = React.useState(false);
  const [useSshTunnel, setUseSshTunnel] = React.useState(false);
  const [sshConnections, setSshConnections] = React.useState<{ id: string; label: string; host: string; connected: boolean }[]>([]);
  const [sshConnectionId, setSshConnectionId] = React.useState('');
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState('');

  const isSqlite = dbType === 'sqlite';
  const selectedType = DB_TYPES.find(t => t.value === dbType);

  // Fetch available SSH connections
  React.useEffect(() => {
    api('GET', '/api/ssh/connections')
      .then((data: any[]) => {
        setSshConnections(data.map(c => ({ id: c.id, label: c.label, host: c.host, connected: c.status?.connected })));
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (selectedType) {
      setPort(String(selectedType.defaultPort || ''));
    }
  }, [dbType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    setError('');
    try {
      const params: any = {};
      if (useConnString && connectionString) {
        params.connection_string = connectionString;
      } else if (isSqlite) {
        params.filename = filename;
      } else {
        params.host = host;
        params.port = parseInt(port) || undefined;
        params.username = username || undefined;
        params.password = password || undefined;
        params.database = database || undefined;
      }
      if (useSshTunnel && sshConnectionId) {
        params.ssh_connection_id = sshConnectionId;
        params.ssh_remote_port = parseInt(port) || undefined;
      }
      const connName = name || `${dbType}@${isSqlite ? filename : useSshTunnel ? `ssh:${host}` : host}`;
      await onConnect(dbType, params, connName);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="database-add-connection">
      <h3>Add Database Connection</h3>
      <form onSubmit={handleSubmit} className="database-add-form">
        <div className="database-form-row">
          <label>Database Type</label>
          <select value={dbType} onChange={e => setDbType(e.target.value)} className="database-form-select">
            {DB_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="database-form-row">
          <label>Connection Name (optional)</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={`${dbType}@${isSqlite ? 'file' : host}`}
            className="database-form-input"
          />
        </div>

        {!isSqlite && (
          <div className="database-form-row">
            <label>
              <input type="checkbox" checked={useConnString} onChange={e => setUseConnString(e.target.checked)} />
              {' '}Use connection string
            </label>
          </div>
        )}

        {useConnString && !isSqlite ? (
          <div className="database-form-row">
            <label>Connection String</label>
            <input
              type="text"
              value={connectionString}
              onChange={e => setConnectionString(e.target.value)}
              placeholder={`${dbType}://user:pass@localhost:${selectedType?.defaultPort}/dbname`}
              className="database-form-input"
            />
          </div>
        ) : isSqlite ? (
          <div className="database-form-row">
            <label>Database File Path</label>
            <input
              type="text"
              value={filename}
              onChange={e => setFilename(e.target.value)}
              placeholder="/path/to/database.sqlite"
              className="database-form-input"
              required
            />
          </div>
        ) : (
          <>
            <div className="database-form-row-inline">
              <div className="database-form-row" style={{ flex: 2 }}>
                <label>Host</label>
                <input type="text" value={host} onChange={e => setHost(e.target.value)} className="database-form-input" />
              </div>
              <div className="database-form-row" style={{ flex: 1 }}>
                <label>Port</label>
                <input type="number" value={port} onChange={e => setPort(e.target.value)} className="database-form-input" />
              </div>
            </div>
            <div className="database-form-row-inline">
              <div className="database-form-row" style={{ flex: 1 }}>
                <label>Username</label>
                <input type="text" value={username} onChange={e => setUsername(e.target.value)} className="database-form-input" />
              </div>
              <div className="database-form-row" style={{ flex: 1 }}>
                <label>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="database-form-input" />
              </div>
            </div>
            <div className="database-form-row">
              <label>Database</label>
              <input type="text" value={database} onChange={e => setDatabase(e.target.value)} className="database-form-input" />
            </div>
          </>
        )}

        {/* SSH Tunnel */}
        {!isSqlite && sshConnections.length > 0 && (
          <>
            <div className="database-form-row">
              <label>
                <input type="checkbox" checked={useSshTunnel} onChange={e => setUseSshTunnel(e.target.checked)} />
                {' '}Connect through SSH tunnel
              </label>
            </div>
            {useSshTunnel && (
              <div className="database-form-row">
                <label>SSH Connection</label>
                <select
                  value={sshConnectionId}
                  onChange={e => setSshConnectionId(e.target.value)}
                  className="database-form-select"
                >
                  <option value="">Select SSH connection...</option>
                  {sshConnections.map(s => (
                    <option key={s.id} value={s.id} disabled={!s.connected}>
                      {s.label} ({s.host}) {s.connected ? '' : '- disconnected'}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        {error && <div className="database-query-error">{error}</div>}

        <div className="database-form-actions">
          <button type="button" className="database-form-cancel" onClick={onCancel}>Cancel</button>
          <button type="submit" className="database-query-run-btn" disabled={connecting}>
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}
