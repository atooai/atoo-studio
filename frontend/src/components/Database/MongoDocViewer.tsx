import React from 'react';
import { api } from '../../api';

interface Props {
  connectionId: string;
  selectedCollection: string | null;
}

interface CollectionInfo {
  name: string;
  type?: string;
  row_count?: number;
}

// --- JSON Tree Viewer ---

const typeColors: Record<string, string> = {
  string: '#a8d4a0',
  number: '#6cb6ff',
  boolean: '#e0a060',
  null: '#888',
  key: '#ccc',
  bracket: '#999',
  id: '#e0c080',
};

interface JsonNodeProps {
  name: string | null;
  value: any;
  depth: number;
  defaultExpanded?: boolean;
  isIdField?: boolean;
}

function JsonNode({ name, value, depth, defaultExpanded = false, isIdField = false }: JsonNodeProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const indent = depth * 16;

  if (value === null || value === undefined) {
    return (
      <div style={{ paddingLeft: indent, lineHeight: '22px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {name != null && (
          <span style={{ color: isIdField ? typeColors.id : typeColors.key }}>
            {isIdField ? <strong>{name}</strong> : name}
            <span style={{ color: typeColors.bracket }}>: </span>
          </span>
        )}
        <span style={{ color: typeColors.null, fontStyle: 'italic' }}>null</span>
      </div>
    );
  }

  if (typeof value === 'string') {
    return (
      <div style={{ paddingLeft: indent, lineHeight: '22px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {name != null && (
          <span style={{ color: isIdField ? typeColors.id : typeColors.key }}>
            {isIdField ? <strong>{name}</strong> : name}
            <span style={{ color: typeColors.bracket }}>: </span>
          </span>
        )}
        <span style={{ color: typeColors.string }}>"{value.length > 200 ? value.substring(0, 200) + '...' : value}"</span>
      </div>
    );
  }

  if (typeof value === 'number') {
    return (
      <div style={{ paddingLeft: indent, lineHeight: '22px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {name != null && (
          <span style={{ color: isIdField ? typeColors.id : typeColors.key }}>
            {isIdField ? <strong>{name}</strong> : name}
            <span style={{ color: typeColors.bracket }}>: </span>
          </span>
        )}
        <span style={{ color: typeColors.number }}>{value}</span>
      </div>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <div style={{ paddingLeft: indent, lineHeight: '22px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {name != null && (
          <span style={{ color: isIdField ? typeColors.id : typeColors.key }}>
            {isIdField ? <strong>{name}</strong> : name}
            <span style={{ color: typeColors.bracket }}>: </span>
          </span>
        )}
        <span style={{ color: typeColors.boolean }}>{String(value)}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? value.map((v: any, i: number) => [String(i), v] as [string, any])
    : Object.entries(value);
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';
  const summary = isArray ? `${value.length} items` : `${Object.keys(value).length} fields`;

  return (
    <div>
      <div
        style={{
          paddingLeft: indent,
          lineHeight: '22px',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 12,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ color: typeColors.bracket, display: 'inline-block', width: 14, textAlign: 'center' }}>
          {expanded ? '\u25BE' : '\u25B8'}
        </span>
        {name != null && (
          <span style={{ color: isIdField ? typeColors.id : typeColors.key }}>
            {isIdField ? <strong>{name}</strong> : name}
            <span style={{ color: typeColors.bracket }}>: </span>
          </span>
        )}
        <span style={{ color: typeColors.bracket }}>{openBracket}</span>
        {!expanded && (
          <span style={{ color: '#666', fontSize: 11 }}> {summary} {closeBracket}</span>
        )}
      </div>
      {expanded && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              name={isArray ? k : k}
              value={v}
              depth={depth + 1}
              defaultExpanded={k === '_id'}
              isIdField={k === '_id'}
            />
          ))}
          <div style={{ paddingLeft: indent, lineHeight: '22px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            <span style={{ display: 'inline-block', width: 14 }} />
            <span style={{ color: typeColors.bracket }}>{closeBracket}</span>
          </div>
        </>
      )}
    </div>
  );
}

// --- Main Component ---

export function MongoDocViewer({ connectionId, selectedCollection }: Props) {
  const [collections, setCollections] = React.useState<CollectionInfo[]>([]);
  const [activeCollection, setActiveCollection] = React.useState<string | null>(selectedCollection);
  const [documents, setDocuments] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadingCollections, setLoadingCollections] = React.useState(false);
  const [error, setError] = React.useState('');
  const [filterText, setFilterText] = React.useState('');
  const [viewMode, setViewMode] = React.useState<'tree' | 'raw'>('tree');
  const [expandedDocs, setExpandedDocs] = React.useState<Set<number>>(new Set());
  const [collectionFilter, setCollectionFilter] = React.useState('');

  // Sync prop changes
  React.useEffect(() => {
    setActiveCollection(selectedCollection);
  }, [selectedCollection]);

  // Load collections when no collection is selected
  React.useEffect(() => {
    if (activeCollection) return;
    setLoadingCollections(true);
    api('GET', `/api/databases/${connectionId}/tables`)
      .then((data: CollectionInfo[]) => setCollections(data))
      .catch(() => setCollections([]))
      .finally(() => setLoadingCollections(false));
  }, [connectionId, activeCollection]);

  // Load documents when a collection is selected
  React.useEffect(() => {
    if (!activeCollection) {
      setDocuments([]);
      return;
    }
    fetchDocuments(activeCollection, filterText);
  }, [activeCollection, connectionId]);

  const fetchDocuments = React.useCallback(async (collection: string, filter: string) => {
    setLoading(true);
    setError('');
    try {
      let filterPart = '{}';
      if (filter.trim()) {
        // Validate JSON
        try {
          JSON.parse(filter.trim());
          filterPart = filter.trim();
        } catch {
          setError('Invalid JSON filter');
          setLoading(false);
          return;
        }
      }
      const query = `${collection}.find(${filterPart})`;
      const data = await api('POST', '/api/databases/query', {
        connection_id: connectionId,
        query,
      });
      setDocuments(data.rows || []);
    } catch (e: any) {
      setError(e.message);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  const handleApplyFilter = () => {
    if (activeCollection) {
      fetchDocuments(activeCollection, filterText);
    }
  };

  const handleFilterKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyFilter();
    }
  };

  const toggleDoc = (idx: number) => {
    setExpandedDocs(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedDocs(new Set(documents.map((_, i) => i)));
  };

  const collapseAll = () => {
    setExpandedDocs(new Set());
  };

  const getDocId = (doc: any): string => {
    if (doc._id != null) {
      if (typeof doc._id === 'object' && doc._id.$oid) return doc._id.$oid;
      return String(doc._id);
    }
    return '';
  };

  // Collection selector
  if (!activeCollection) {
    const filtered = collectionFilter
      ? collections.filter(c => c.name.toLowerCase().includes(collectionFilter.toLowerCase()))
      : collections;

    return (
      <div className="database-table-list" style={{ height: '100%' }}>
        <div className="database-table-list-header">
          <span className="database-table-list-title">Collections ({collections.length})</span>
        </div>
        <input
          className="database-table-filter"
          type="text"
          placeholder="Filter collections..."
          value={collectionFilter}
          onChange={e => setCollectionFilter(e.target.value)}
        />
        <div className="database-table-list-items">
          {loadingCollections && <div className="database-explorer-empty-hint">Loading...</div>}
          {!loadingCollections && filtered.length === 0 && (
            <div className="database-explorer-empty-hint">
              {collections.length === 0 ? 'No collections' : 'No matches'}
            </div>
          )}
          {filtered.map(c => (
            <div
              key={c.name}
              className="database-table-item"
              onClick={() => setActiveCollection(c.name)}
            >
              <span className="database-table-icon">{'\u{1F4C4}'}</span>
              <span className="database-table-name">{c.name}</span>
              {c.row_count != null && (
                <span className="database-table-count">{formatCount(c.row_count)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Document viewer
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-color, #333)',
        flexShrink: 0,
      }}>
        {!selectedCollection && (
          <button
            className="database-query-export-btn"
            onClick={() => setActiveCollection(null)}
            title="Back to collections"
          >
            &larr; Back
          </button>
        )}
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary, #eee)' }}>
          {activeCollection}
        </span>
        <span style={{ color: '#888', fontSize: 12 }}>
          {documents.length} document{documents.length !== 1 ? 's' : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className={`database-query-export-btn ${viewMode === 'tree' ? 'active' : ''}`}
          onClick={() => setViewMode('tree')}
        >
          Tree
        </button>
        <button
          className={`database-query-export-btn ${viewMode === 'raw' ? 'active' : ''}`}
          onClick={() => setViewMode('raw')}
        >
          Raw
        </button>
        <button className="database-query-export-btn" onClick={expandAll}>Expand All</button>
        <button className="database-query-export-btn" onClick={collapseAll}>Collapse All</button>
      </div>

      {/* Filter bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderBottom: '1px solid var(--border-color, #333)',
        flexShrink: 0,
      }}>
        <span style={{ color: '#888', fontSize: 12, whiteSpace: 'nowrap' }}>Filter:</span>
        <input
          className="database-table-filter"
          type="text"
          placeholder='{"status": "active"}'
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          onKeyDown={handleFilterKeyDown}
          style={{ flex: 1, margin: 0 }}
        />
        <button
          className="database-query-run-btn"
          onClick={handleApplyFilter}
          disabled={loading}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          {loading ? '...' : 'Apply'}
        </button>
      </div>

      {/* Error */}
      {error && <div className="database-query-error">{error}</div>}

      {/* Loading */}
      {loading && (
        <div className="database-explorer-empty-hint" style={{ padding: 20 }}>Loading documents...</div>
      )}

      {/* Documents */}
      {!loading && documents.length === 0 && !error && (
        <div className="database-explorer-placeholder">
          No documents found. Adjust the filter or select a different collection.
        </div>
      )}

      {!loading && documents.length > 0 && (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
          {documents.map((doc, idx) => {
            const docId = getDocId(doc);
            const isExpanded = expandedDocs.has(idx);

            return (
              <div
                key={idx}
                style={{
                  margin: '0 12px 6px 12px',
                  border: '1px solid var(--border-color, #333)',
                  borderRadius: 4,
                  background: 'var(--bg-secondary, #1a1a1a)',
                  overflow: 'hidden',
                }}
              >
                {/* Document header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    cursor: 'pointer',
                    borderBottom: isExpanded ? '1px solid var(--border-color, #333)' : 'none',
                    background: 'var(--bg-tertiary, #222)',
                    userSelect: 'none',
                  }}
                  onClick={() => toggleDoc(idx)}
                >
                  <span style={{ color: typeColors.bracket, fontSize: 12, width: 14, textAlign: 'center' }}>
                    {isExpanded ? '\u25BE' : '\u25B8'}
                  </span>
                  <span style={{ color: '#888', fontSize: 11 }}>#{idx + 1}</span>
                  {docId && (
                    <span style={{
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 11,
                      color: typeColors.id,
                      fontWeight: 600,
                    }}>
                      _id: {docId.length > 30 ? docId.substring(0, 30) + '...' : docId}
                    </span>
                  )}
                  <span style={{ color: '#666', fontSize: 11, marginLeft: 'auto' }}>
                    {Object.keys(doc).length} field{Object.keys(doc).length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Document body */}
                {isExpanded && (
                  <div style={{ padding: '6px 4px' }}>
                    {viewMode === 'tree' ? (
                      <JsonNode name={null} value={doc} depth={0} defaultExpanded />
                    ) : (
                      <pre style={{
                        margin: 0,
                        padding: '8px 12px',
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: 12,
                        lineHeight: '20px',
                        color: 'var(--text-primary, #eee)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}>
                        {JSON.stringify(doc, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
