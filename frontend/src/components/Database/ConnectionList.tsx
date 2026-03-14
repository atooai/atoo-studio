import React from 'react';
import type { DbConnection } from './DatabaseExplorer';

interface Props {
  connections: DbConnection[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDisconnect: (id: string) => void;
}

export function ConnectionList({ connections, activeId, onSelect, onDisconnect }: Props) {
  if (connections.length === 0) {
    return <div className="database-explorer-empty-hint">No active connections</div>;
  }

  return (
    <div className="database-connection-list">
      {connections.map(conn => (
        <div
          key={conn.id}
          className={`database-connection-item ${activeId === conn.id ? 'active' : ''}`}
          onClick={() => onSelect(conn.id)}
        >
          <span className="database-connection-name">{conn.name}</span>
          <span className="database-connection-type">{conn.db_type}</span>
          <button
            className="database-connection-close"
            onClick={(e) => { e.stopPropagation(); onDisconnect(conn.id); }}
            title="Disconnect"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
