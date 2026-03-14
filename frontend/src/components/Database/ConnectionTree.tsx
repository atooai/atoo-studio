import React from 'react';
import { api } from '../../api';
import type { DbConnection, DiscoveredDb, SavedConnection } from './DatabaseExplorer';

interface TableInfo {
  name: string;
  type?: string;
  row_count?: number;
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primary_key?: boolean;
}

interface TreeNodeState {
  expanded: boolean;
  tables?: TableInfo[];
  columns?: Record<string, ColumnInfo[]>;
  loading?: boolean;
}

interface Props {
  connections: DbConnection[];
  discovered: DiscoveredDb[];
  saved: SavedConnection[];
  activeConnectionId: string | null;
  onSelectConnection: (id: string) => void;
  onSelectTable: (connId: string, table: string) => void;
  onConnect: (db: DiscoveredDb) => void;
  onDisconnect: (connId: string) => void;
  onReconnect: (saved: SavedConnection) => void;
  onDeleteSaved: (savedId: string) => void;
  onShowAddForm: () => void;
}

export function ConnectionTree({
  connections, discovered, saved, activeConnectionId,
  onSelectConnection, onSelectTable, onConnect, onDisconnect, onReconnect, onDeleteSaved, onShowAddForm,
}: Props) {
  const [nodeState, setNodeState] = React.useState<Record<string, TreeNodeState>>({});
  const [expandedTables, setExpandedTables] = React.useState<Set<string>>(new Set());

  const toggleConnection = async (connId: string) => {
    const state = nodeState[connId];
    if (state?.expanded) {
      setNodeState(prev => ({ ...prev, [connId]: { ...prev[connId], expanded: false } }));
      return;
    }

    // Expand and load tables
    setNodeState(prev => ({ ...prev, [connId]: { expanded: true, loading: true } }));
    onSelectConnection(connId);

    try {
      const tables = await api('GET', `/api/databases/${connId}/tables`);
      setNodeState(prev => ({ ...prev, [connId]: { expanded: true, tables, loading: false } }));
    } catch {
      setNodeState(prev => ({ ...prev, [connId]: { expanded: true, tables: [], loading: false } }));
    }
  };

  const toggleTable = async (connId: string, tableName: string) => {
    const key = `${connId}:${tableName}`;
    if (expandedTables.has(key)) {
      setExpandedTables(prev => { const s = new Set(prev); s.delete(key); return s; });
      return;
    }

    setExpandedTables(prev => new Set(prev).add(key));
    onSelectTable(connId, tableName);

    // Load columns if not cached
    const state = nodeState[connId];
    if (!state?.columns?.[tableName]) {
      try {
        const schema = await api('GET', `/api/databases/${connId}/tables/${encodeURIComponent(tableName)}`);
        setNodeState(prev => ({
          ...prev,
          [connId]: {
            ...prev[connId],
            columns: { ...prev[connId]?.columns, [tableName]: schema.columns },
          },
        }));
      } catch {}
    }
  };

  // Group discovered by source
  const grouped = React.useMemo(() => {
    const groups: Record<string, DiscoveredDb[]> = { local: [], container: [], manual: [] };
    for (const db of discovered) {
      const g = groups[db.source] || (groups[db.source] = []);
      g.push(db);
    }
    return groups;
  }, [discovered]);

  return (
    <div className="database-tree">
      {/* Active Connections */}
      <div className="database-tree-section">
        <div className="database-tree-section-header">
          Active ({connections.length})
        </div>
        {connections.map(conn => {
          const state = nodeState[conn.id];
          const isActive = activeConnectionId === conn.id;
          return (
            <div key={conn.id}>
              <div
                className={`database-tree-item database-tree-connection ${isActive ? 'active' : ''}`}
                onClick={() => toggleConnection(conn.id)}
              >
                <span className="database-tree-arrow">{state?.expanded ? '▾' : '▸'}</span>
                <span className="database-tree-icon">{getDbIcon(conn.db_type)}</span>
                <span className="database-tree-label">{conn.name}</span>
                {conn.readonly && <span className="database-tree-readonly" title="Read-only">RO</span>}
                <button
                  className="database-tree-action"
                  onClick={(e) => { e.stopPropagation(); onDisconnect(conn.id); }}
                  title="Disconnect"
                >
                  ✕
                </button>
              </div>

              {state?.expanded && (
                <div className="database-tree-children">
                  {state.loading && (
                    <div className="database-tree-item database-tree-loading">Loading...</div>
                  )}
                  {state.tables?.map(table => {
                    const tKey = `${conn.id}:${table.name}`;
                    const isTableExpanded = expandedTables.has(tKey);
                    const columns = state.columns?.[table.name];
                    return (
                      <div key={table.name}>
                        <div
                          className="database-tree-item database-tree-table"
                          onClick={() => toggleTable(conn.id, table.name)}
                        >
                          <span className="database-tree-arrow">{isTableExpanded ? '▾' : '▸'}</span>
                          <span className="database-tree-icon">{table.type === 'view' ? '👁' : '▤'}</span>
                          <span className="database-tree-label">{table.name}</span>
                          {table.row_count != null && (
                            <span className="database-tree-meta">{formatCount(table.row_count)}</span>
                          )}
                        </div>

                        {isTableExpanded && columns && (
                          <div className="database-tree-children">
                            {columns.map(col => (
                              <div key={col.name} className="database-tree-item database-tree-column">
                                <span className="database-tree-icon">
                                  {col.primary_key ? '🔑' : '·'}
                                </span>
                                <span className="database-tree-label">{col.name}</span>
                                <span className="database-tree-col-type">{col.type}</span>
                                {col.nullable && <span className="database-tree-col-null">?</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {isTableExpanded && !columns && (
                          <div className="database-tree-children">
                            <div className="database-tree-item database-tree-loading">Loading...</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!state.loading && state.tables?.length === 0 && (
                    <div className="database-tree-item database-tree-loading">No tables</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Discovered — grouped by source */}
      {(['local', 'container', 'manual'] as const).map(source => {
        const items = grouped[source];
        if (!items || items.length === 0) return null;
        return (
          <div key={source} className="database-tree-section">
            <div className="database-tree-section-header">
              {source === 'local' ? 'Local Files' : source === 'container' ? 'Containers' : 'From Config'}
              <span className="database-explorer-badge">{items.length}</span>
            </div>
            {items.map(db => (
              <div key={db.id} className="database-tree-item database-tree-discovered">
                <span className="database-tree-icon">{getDbIcon(db.db_type)}</span>
                <span className="database-tree-label">{db.name}</span>
                <button
                  className="database-tree-connect-btn"
                  onClick={() => onConnect(db)}
                  title="Connect"
                >
                  →
                </button>
              </div>
            ))}
          </div>
        );
      })}

      {/* Saved connections (not currently active) */}
      {saved.filter(s => !connections.some(c => c.id === s.id)).length > 0 && (
        <div className="database-tree-section">
          <div className="database-tree-section-header">
            Saved
            <span className="database-explorer-badge">
              {saved.filter(s => !connections.some(c => c.id === s.id)).length}
            </span>
          </div>
          {saved.filter(s => !connections.some(c => c.id === s.id)).map(s => (
            <div key={s.id} className="database-tree-item database-tree-discovered">
              <span className="database-tree-icon">{getDbIcon(s.db_type)}</span>
              <span className="database-tree-label">{s.name}</span>
              <button
                className="database-tree-connect-btn"
                onClick={() => onReconnect(s)}
                title="Reconnect"
              >
                →
              </button>
              <button
                className="database-tree-action database-tree-action-visible"
                onClick={() => onDeleteSaved(s.id)}
                title="Remove saved connection"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button className="database-explorer-add-btn" onClick={onShowAddForm}>
        + Add Connection
      </button>
    </div>
  );
}

function getDbIcon(dbType: string): string {
  const icons: Record<string, string> = {
    postgresql: '🐘', mysql: '🐬', mariadb: '🐬', sqlite: '📄', redis: '🔴',
    mongodb: '🍃', duckdb: '🦆', elasticsearch: '🔍', opensearch: '🔍',
    clickhouse: '⚡', neo4j: '🔗', influxdb: '📈', cassandra: '👁',
    cockroachdb: '🪳', memcached: '💾',
  };
  return icons[dbType] || '🗄';
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
