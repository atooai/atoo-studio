import React from 'react';
import { api } from '../../api';
import { ConnectionTree } from './ConnectionTree';
import { QueryPanel } from './QueryPanel';
import { SchemaViewer } from './SchemaViewer';
import { AddConnectionForm } from './AddConnectionForm';
import { RedisKeyBrowser } from './RedisKeyBrowser';
import { MongoDocViewer } from './MongoDocViewer';
import { Neo4jGraphView } from './Neo4jGraphView';
import { InfluxChart } from './InfluxChart';
import { ElasticBrowser } from './ElasticBrowser';

export interface DbConnection {
  id: string;
  name: string;
  db_type: string;
  connected: boolean;
  readonly?: boolean;
}

export interface SavedConnection {
  id: string;
  name: string;
  db_type: string;
  params: any;
}

export interface DiscoveredDb {
  id: string;
  name: string;
  db_type: string;
  source: 'local' | 'container' | 'manual';
  params: any;
  source_detail?: string;
  connected?: boolean;
}

type SubTab = 'query' | 'schema' | 'browse' | 'add-connection';

interface QueryTab {
  id: number;
  label: string;
}

let nextTabId = 1;

export function DatabaseExplorer({ onClose }: { onClose: () => void }) {
  const [discovered, setDiscovered] = React.useState<DiscoveredDb[]>([]);
  const [connections, setConnections] = React.useState<DbConnection[]>([]);
  const [savedConnections, setSavedConnections] = React.useState<SavedConnection[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [activeConnectionId, setActiveConnectionId] = React.useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = React.useState<SubTab>('query');
  const [selectedTable, setSelectedTable] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [queryTabs, setQueryTabs] = React.useState<QueryTab[]>([{ id: nextTabId++, label: 'Query 1' }]);
  const [activeTabId, setActiveTabId] = React.useState(1);

  const refresh = React.useCallback(() => {
    api('GET', '/api/databases/discover')
      .then((data: { discovered: DiscoveredDb[]; connections: DbConnection[]; saved?: SavedConnection[] }) => {
        setDiscovered(data.discovered);
        setConnections(data.connections);
        setSavedConnections(data.saved || []);
        setError('');
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { refresh(); }, [refresh, refreshKey]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Auto-refresh every 15s
  React.useEffect(() => {
    const interval = setInterval(() => setRefreshKey(k => k + 1), 15000);
    return () => clearInterval(interval);
  }, []);

  const handleConnect = async (db: DiscoveredDb) => {
    try {
      const res = await api('POST', '/api/databases/connect', {
        db_type: db.db_type,
        connection: db.params,
        name: db.name,
      });
      setActiveConnectionId(res.connection_id);
      setActiveSubTab('query');
      setSelectedTable(null);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleManualConnect = async (dbType: string, params: any, name: string) => {
    try {
      const res = await api('POST', '/api/databases/connect', {
        db_type: dbType,
        connection: params,
        name,
      });
      setActiveConnectionId(res.connection_id);
      setActiveSubTab('query');
      setSelectedTable(null);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDisconnect = async (connId: string) => {
    try {
      await api('POST', '/api/databases/disconnect', { connection_id: connId });
      if (activeConnectionId === connId) {
        setActiveConnectionId(null);
        setSelectedTable(null);
      }
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleReconnect = async (saved: SavedConnection) => {
    try {
      const res = await api('POST', '/api/databases/reconnect', { saved_id: saved.id });
      setActiveConnectionId(res.connection_id);
      setActiveSubTab('query');
      setSelectedTable(null);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDeleteSaved = async (savedId: string) => {
    try {
      await api('DELETE', `/api/databases/saved/${savedId}`);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSelectConnection = (connId: string) => {
    setActiveConnectionId(connId);
    setSelectedTable(null);
    if (activeSubTab === 'add-connection') setActiveSubTab('query');
  };

  const handleSelectTable = (connId: string, table: string) => {
    setActiveConnectionId(connId);
    setSelectedTable(table);
    if (activeSubTab === 'add-connection') setActiveSubTab('query');
  };

  const activeConn = connections.find(c => c.id === activeConnectionId);

  return (
    <div className="database-explorer" onClick={e => e.stopPropagation()}>
      <div className="database-explorer-header">
        <h2>Database Explorer</h2>
        <div style={{ flex: 1 }} />
        <button className="container-manager-refresh" onClick={() => { setRefreshKey(k => k + 1); }} title="Refresh">
          ↻
        </button>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>

      <div className="database-explorer-main">
        {/* Left sidebar — connection tree with hierarchy */}
        <div className="database-explorer-sidebar">
          <ConnectionTree
            connections={connections}
            discovered={discovered}
            saved={savedConnections}
            activeConnectionId={activeConnectionId}
            onSelectConnection={handleSelectConnection}
            onSelectTable={handleSelectTable}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onReconnect={handleReconnect}
            onDeleteSaved={handleDeleteSaved}
            onShowAddForm={() => { setActiveSubTab('add-connection'); setActiveConnectionId(null); }}
          />
        </div>

        {/* Main content */}
        <div className="database-explorer-content">
          {error && (
            <div className="database-explorer-error">
              {error}
              <button className="database-explorer-error-close" onClick={() => setError('')}>✕</button>
            </div>
          )}

          {activeSubTab === 'add-connection' && (
            <AddConnectionForm
              onConnect={handleManualConnect}
              onCancel={() => setActiveSubTab('query')}
            />
          )}

          {activeSubTab !== 'add-connection' && !activeConnectionId && (
            <div className="database-explorer-placeholder">
              {loading ? 'Discovering databases...' : 'Select a connection or add a new one to get started'}
            </div>
          )}

          {activeSubTab !== 'add-connection' && activeConnectionId && (
            <>
              <div className="database-explorer-subtabs">
                {queryTabs.map(tab => (
                  <div
                    key={tab.id}
                    className={`container-manager-subtab database-query-tab ${activeSubTab === 'query' && activeTabId === tab.id ? 'active' : ''}`}
                    onClick={() => { setActiveSubTab('query'); setActiveTabId(tab.id); }}
                  >
                    {tab.label}
                    {queryTabs.length > 1 && (
                      <span
                        className="database-query-tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQueryTabs(prev => prev.filter(t => t.id !== tab.id));
                          if (activeTabId === tab.id) {
                            const remaining = queryTabs.filter(t => t.id !== tab.id);
                            if (remaining.length) setActiveTabId(remaining[0].id);
                          }
                        }}
                      >
                        ✕
                      </span>
                    )}
                  </div>
                ))}
                <button
                  className="database-query-tab-add"
                  onClick={() => {
                    const id = nextTabId++;
                    setQueryTabs(prev => [...prev, { id, label: `Query ${id}` }]);
                    setActiveTabId(id);
                    setActiveSubTab('query');
                  }}
                  title="New query tab"
                >
                  +
                </button>
                {activeConn && getSpecializedTabLabel(activeConn.db_type) && (
                  <button
                    className={`container-manager-subtab ${activeSubTab === 'browse' ? 'active' : ''}`}
                    onClick={() => setActiveSubTab('browse')}
                  >
                    {getSpecializedTabLabel(activeConn.db_type)}
                  </button>
                )}
                <button
                  className={`container-manager-subtab ${activeSubTab === 'schema' ? 'active' : ''}`}
                  onClick={() => setActiveSubTab('schema')}
                >
                  Schema
                </button>
                {activeConn && (
                  <span className="database-explorer-conn-label">
                    {activeConn.db_type} — {activeConn.name}
                    {activeConn.readonly && <span className="database-tree-readonly" style={{ marginLeft: 6 }}>RO</span>}
                  </span>
                )}
              </div>

              <div className="database-explorer-main-panel" style={{ flex: 1, overflow: 'hidden' }}>
                {activeSubTab === 'query' && queryTabs.map(tab => (
                  <div key={tab.id} style={{ display: activeTabId === tab.id ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
                    <QueryPanel
                      connectionId={activeConnectionId}
                      selectedTable={selectedTable}
                      dbType={activeConn?.db_type}
                    />
                  </div>
                ))}
                {activeSubTab === 'browse' && activeConn?.db_type === 'redis' && (
                  <RedisKeyBrowser connectionId={activeConnectionId} />
                )}
                {activeSubTab === 'browse' && activeConn?.db_type === 'mongodb' && (
                  <MongoDocViewer connectionId={activeConnectionId} selectedCollection={selectedTable} />
                )}
                {activeSubTab === 'browse' && activeConn?.db_type === 'neo4j' && (
                  <Neo4jGraphView connectionId={activeConnectionId} />
                )}
                {activeSubTab === 'browse' && activeConn?.db_type === 'influxdb' && (
                  <InfluxChart connectionId={activeConnectionId} />
                )}
                {activeSubTab === 'browse' && (activeConn?.db_type === 'elasticsearch' || activeConn?.db_type === 'opensearch') && (
                  <ElasticBrowser connectionId={activeConnectionId} />
                )}
                {activeSubTab === 'schema' && selectedTable && (
                  <SchemaViewer connectionId={activeConnectionId} table={selectedTable} />
                )}
                {activeSubTab === 'schema' && !selectedTable && (
                  <div className="database-explorer-placeholder">Select a table from the tree to view its schema</div>
                )}
              </div>

              {/* Bottom status bar */}
              <div className="database-explorer-statusbar">
                <span className="database-explorer-status-item">
                  {activeConn?.connected ? '● Connected' : '○ Disconnected'}
                </span>
                <span className="database-explorer-status-item">
                  {activeConn?.db_type}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function getSpecializedTabLabel(dbType: string): string | null {
  switch (dbType) {
    case 'redis': return 'Keys';
    case 'mongodb': return 'Documents';
    case 'neo4j': return 'Graph';
    case 'influxdb': return 'Chart';
    case 'elasticsearch':
    case 'opensearch': return 'Browser';
    default: return null;
  }
}
