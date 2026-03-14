import React from 'react';
import { api } from '../../api';

interface Props {
  connectionId: string;
}

type QueryType = 'match_all' | 'match' | 'term' | 'bool' | 'range' | 'raw';

interface BoolClause {
  field: string;
  value: string;
}

interface IndexInfo {
  name: string;
  doc_count?: number;
  size?: string;
}

interface Hit {
  _id: string;
  _score: number | null;
  _source: Record<string, any>;
}

export function ElasticBrowser({ connectionId }: Props) {
  const [activeTab, setActiveTab] = React.useState<'query' | 'indices'>('query');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="container-manager-subtabs" style={{ flexShrink: 0 }}>
        <button
          className={`container-manager-subtab ${activeTab === 'query' ? 'active' : ''}`}
          onClick={() => setActiveTab('query')}
        >
          Query
        </button>
        <button
          className={`container-manager-subtab ${activeTab === 'indices' ? 'active' : ''}`}
          onClick={() => setActiveTab('indices')}
        >
          Indices
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'query' && <QueryTab connectionId={connectionId} />}
        {activeTab === 'indices' && <IndicesTab connectionId={connectionId} />}
      </div>
    </div>
  );
}

// ─── Query Tab ──────────────────────────────────────────────────────

function QueryTab({ connectionId }: { connectionId: string }) {
  const [indices, setIndices] = React.useState<IndexInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState('');
  const [queryType, setQueryType] = React.useState<QueryType>('match_all');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [hits, setHits] = React.useState<Hit[]>([]);
  const [totalHits, setTotalHits] = React.useState(0);
  const [timeTook, setTimeTook] = React.useState(0);

  // Form fields
  const [fieldName, setFieldName] = React.useState('');
  const [queryText, setQueryText] = React.useState('');
  const [rangeGte, setRangeGte] = React.useState('');
  const [rangeLte, setRangeLte] = React.useState('');
  const [rawJson, setRawJson] = React.useState('{\n  "match_all": {}\n}');
  const [boolMust, setBoolMust] = React.useState<BoolClause[]>([{ field: '', value: '' }]);
  const [boolShould, setBoolShould] = React.useState<BoolClause[]>([]);
  const [boolMustNot, setBoolMustNot] = React.useState<BoolClause[]>([]);

  // Pagination
  const [size, setSize] = React.useState(20);
  const [from, setFrom] = React.useState(0);

  React.useEffect(() => {
    api('GET', `/api/databases/${connectionId}/tables`)
      .then((tables: any[]) => {
        setIndices(tables.map(t => ({ name: t.name, doc_count: t.doc_count, size: t.size })));
        if (tables.length > 0 && !selectedIndex) {
          setSelectedIndex(tables[0].name);
        }
      })
      .catch(() => {});
  }, [connectionId]);

  const buildQuery = (): Record<string, any> => {
    switch (queryType) {
      case 'match_all':
        return { match_all: {} };
      case 'match':
        return { match: { [fieldName]: queryText } };
      case 'term':
        return { term: { [fieldName]: queryText } };
      case 'bool': {
        const boolQ: Record<string, any> = {};
        const toTerms = (clauses: BoolClause[]) =>
          clauses.filter(c => c.field && c.value).map(c => ({ match: { [c.field]: c.value } }));
        const must = toTerms(boolMust);
        const should = toTerms(boolShould);
        const mustNot = toTerms(boolMustNot);
        if (must.length > 0) boolQ.must = must;
        if (should.length > 0) boolQ.should = should;
        if (mustNot.length > 0) boolQ.must_not = mustNot;
        return { bool: boolQ };
      }
      case 'range':
        return {
          range: {
            [fieldName]: {
              ...(rangeGte ? { gte: rangeGte } : {}),
              ...(rangeLte ? { lte: rangeLte } : {}),
            },
          },
        };
      case 'raw':
        try {
          return JSON.parse(rawJson);
        } catch {
          throw new Error('Invalid JSON in raw query');
        }
    }
  };

  const handleExecute = async () => {
    if (!selectedIndex) {
      setError('Select an index first');
      return;
    }
    setLoading(true);
    setError('');
    setHits([]);

    try {
      const dsl = buildQuery();
      const payload = {
        index: selectedIndex,
        query: dsl,
        size,
        from,
      };
      const data = await api('POST', '/api/databases/query', {
        connection_id: connectionId,
        query: JSON.stringify(payload),
      });

      // Parse ES response — the data may come back in different shapes
      if (data && data.hits) {
        const esHits = data.hits.hits || [];
        setHits(esHits);
        const total = typeof data.hits.total === 'number' ? data.hits.total : data.hits.total?.value ?? 0;
        setTotalHits(total);
        setTimeTook(data.took || 0);
      } else if (data && Array.isArray(data.rows)) {
        // Normalized response from backend
        setHits(data.rows.map((r: any, i: number) => ({
          _id: r._id || String(i),
          _score: r._score ?? null,
          _source: r._source || r,
        })));
        setTotalHits(data.row_count || data.rows.length);
        setTimeTook(data.execution_time_ms || 0);
      } else {
        setHits([]);
        setTotalHits(0);
        setTimeTook(0);
      }
    } catch (e: any) {
      setError(e.message || 'Query failed');
    } finally {
      setLoading(false);
    }
  };

  const addClause = (setter: React.Dispatch<React.SetStateAction<BoolClause[]>>) => {
    setter(prev => [...prev, { field: '', value: '' }]);
  };

  const removeClause = (setter: React.Dispatch<React.SetStateAction<BoolClause[]>>, idx: number) => {
    setter(prev => prev.filter((_, i) => i !== idx));
  };

  const updateClause = (
    setter: React.Dispatch<React.SetStateAction<BoolClause[]>>,
    idx: number,
    key: 'field' | 'value',
    val: string,
  ) => {
    setter(prev => prev.map((c, i) => (i === idx ? { ...c, [key]: val } : c)));
  };

  // Flatten _source for table columns
  const allSourceKeys = React.useMemo(() => {
    const keys = new Set<string>();
    for (const hit of hits) {
      if (hit._source) {
        for (const k of Object.keys(hit._source)) {
          keys.add(k);
        }
      }
    }
    return Array.from(keys);
  }, [hits]);

  const renderBoolSection = (
    label: string,
    clauses: BoolClause[],
    setter: React.Dispatch<React.SetStateAction<BoolClause[]>>,
  ) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, minWidth: 70 }}>{label}</span>
        <button
          className="database-form-cancel"
          onClick={() => addClause(setter)}
          style={{ fontSize: 11, padding: '2px 8px' }}
        >
          + Add
        </button>
      </div>
      {clauses.map((c, i) => (
        <div key={i} className="database-form-row-inline" style={{ gap: 6, marginBottom: 4 }}>
          <input
            className="database-form-input"
            placeholder="Field"
            value={c.field}
            onChange={e => updateClause(setter, i, 'field', e.target.value)}
            style={{ flex: 1, margin: 0 }}
          />
          <input
            className="database-form-input"
            placeholder="Value"
            value={c.value}
            onChange={e => updateClause(setter, i, 'value', e.target.value)}
            style={{ flex: 1, margin: 0 }}
          />
          <button
            className="database-form-cancel"
            onClick={() => removeClause(setter, i)}
            style={{ fontSize: 11, padding: '2px 6px', color: 'var(--accent-red)' }}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Query builder form */}
      <div style={{ flexShrink: 0, padding: '8px 0' }}>
        <div className="database-form-row-inline" style={{ gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Index</label>
            <select
              className="database-form-select"
              value={selectedIndex}
              onChange={e => setSelectedIndex(e.target.value)}
              style={{ width: '100%', margin: 0 }}
            >
              <option value="">Select index...</option>
              {indices.map(idx => (
                <option key={idx.name} value={idx.name}>{idx.name}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Query Type</label>
            <select
              className="database-form-select"
              value={queryType}
              onChange={e => setQueryType(e.target.value as QueryType)}
              style={{ width: '100%', margin: 0 }}
            >
              <option value="match_all">Match All</option>
              <option value="match">Match</option>
              <option value="term">Term</option>
              <option value="bool">Bool</option>
              <option value="range">Range</option>
              <option value="raw">Raw JSON</option>
            </select>
          </div>
        </div>

        {/* Dynamic fields based on query type */}
        {(queryType === 'match' || queryType === 'term') && (
          <div className="database-form-row-inline" style={{ gap: 8, marginBottom: 8 }}>
            <input
              className="database-form-input"
              placeholder="Field name"
              value={fieldName}
              onChange={e => setFieldName(e.target.value)}
              style={{ flex: 1, margin: 0 }}
            />
            <input
              className="database-form-input"
              placeholder={queryType === 'match' ? 'Query text' : 'Value'}
              value={queryText}
              onChange={e => setQueryText(e.target.value)}
              style={{ flex: 1, margin: 0 }}
            />
          </div>
        )}

        {queryType === 'range' && (
          <div className="database-form-row-inline" style={{ gap: 8, marginBottom: 8 }}>
            <input
              className="database-form-input"
              placeholder="Field name"
              value={fieldName}
              onChange={e => setFieldName(e.target.value)}
              style={{ flex: 1, margin: 0 }}
            />
            <input
              className="database-form-input"
              placeholder="gte (from)"
              value={rangeGte}
              onChange={e => setRangeGte(e.target.value)}
              style={{ flex: 1, margin: 0 }}
            />
            <input
              className="database-form-input"
              placeholder="lte (to)"
              value={rangeLte}
              onChange={e => setRangeLte(e.target.value)}
              style={{ flex: 1, margin: 0 }}
            />
          </div>
        )}

        {queryType === 'bool' && (
          <div style={{ marginBottom: 8 }}>
            {renderBoolSection('must', boolMust, setBoolMust)}
            {renderBoolSection('should', boolShould, setBoolShould)}
            {renderBoolSection('must_not', boolMustNot, setBoolMustNot)}
          </div>
        )}

        {queryType === 'raw' && (
          <div style={{ marginBottom: 8 }}>
            <textarea
              className="database-query-input"
              value={rawJson}
              onChange={e => setRawJson(e.target.value)}
              rows={6}
              placeholder='{"match_all": {}}'
              style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
            />
          </div>
        )}

        {/* Size / From / Execute */}
        <div className="database-query-actions">
          <button
            className="database-query-run-btn"
            onClick={handleExecute}
            disabled={loading}
          >
            {loading ? '... Running' : 'Execute'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Size:</label>
            <input
              className="database-form-input"
              type="number"
              value={size}
              onChange={e => setSize(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: 60, margin: 0 }}
            />
            <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>From:</label>
            <input
              className="database-form-input"
              type="number"
              value={from}
              onChange={e => setFrom(Math.max(0, parseInt(e.target.value) || 0))}
              style={{ width: 60, margin: 0 }}
            />
          </div>
          {hits.length > 0 && (
            <span className="database-query-stats">
              {hits.length} of {totalHits} hits · {timeTook}ms
            </span>
          )}
        </div>
      </div>

      {error && <div className="database-query-error">{error}</div>}

      {/* Results */}
      {hits.length > 0 && (
        <div className="database-results-container" style={{ flex: 1, minHeight: 0 }}>
          <div className="database-results-table-wrapper">
            <table className="database-results-table">
              <thead>
                <tr>
                  <th className="database-results-rownum">#</th>
                  <th>_id</th>
                  <th>_score</th>
                  {allSourceKeys.map(k => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hits.map((hit, i) => (
                  <tr key={hit._id + '-' + i}>
                    <td className="database-results-rownum">{from + i + 1}</td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{hit._id}</code></td>
                    <td>{hit._score != null ? hit._score : '-'}</td>
                    {allSourceKeys.map(k => (
                      <td key={k} title={hit._source?.[k] != null ? String(hit._source[k]) : ''}>
                        {formatSourceValue(hit._source?.[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hits.length === 0 && !error && !loading && (
        <div className="database-explorer-placeholder">
          Build a query and click Execute to search
        </div>
      )}
    </div>
  );
}

// ─── Indices Tab ────────────────────────────────────────────────────

function IndicesTab({ connectionId }: { connectionId: string }) {
  const [indices, setIndices] = React.useState<IndexInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [mapping, setMapping] = React.useState<{ index: string; fields: Record<string, any> } | null>(null);
  const [mappingLoading, setMappingLoading] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);
  const [newIndexName, setNewIndexName] = React.useState('');
  const [createError, setCreateError] = React.useState('');
  const [refreshingIndex, setRefreshingIndex] = React.useState<string | null>(null);

  const fetchIndices = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const tables = await api('GET', `/api/databases/${connectionId}/tables`);
      setIndices(tables.map((t: any) => ({ name: t.name, doc_count: t.doc_count, size: t.size })));
    } catch (e: any) {
      setError(e.message || 'Failed to load indices');
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  React.useEffect(() => {
    fetchIndices();
  }, [fetchIndices]);

  const handleRefresh = async (indexName: string) => {
    setRefreshingIndex(indexName);
    try {
      await api('POST', '/api/databases/query', {
        connection_id: connectionId,
        query: JSON.stringify({ index: indexName, action: 'refresh' }),
      });
      await fetchIndices();
    } catch (e: any) {
      setError(e.message || 'Refresh failed');
    } finally {
      setRefreshingIndex(null);
    }
  };

  const handleViewMapping = async (indexName: string) => {
    if (mapping?.index === indexName) {
      setMapping(null);
      return;
    }
    setMappingLoading(true);
    try {
      const schema = await api('GET', `/api/databases/${connectionId}/tables/${encodeURIComponent(indexName)}`);
      const fields: Record<string, any> = {};
      if (schema.columns && Array.isArray(schema.columns)) {
        for (const col of schema.columns) {
          fields[col.name] = col.type || 'unknown';
        }
      } else if (typeof schema === 'object') {
        Object.assign(fields, schema);
      }
      setMapping({ index: indexName, fields });
    } catch (e: any) {
      setError(e.message || 'Failed to load mapping');
    } finally {
      setMappingLoading(false);
    }
  };

  const handleCreateIndex = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIndexName.trim()) return;
    setCreateError('');
    try {
      await api('POST', '/api/databases/query', {
        connection_id: connectionId,
        query: JSON.stringify({ index: newIndexName.trim(), action: 'create' }),
      });
      setNewIndexName('');
      setShowCreate(false);
      await fetchIndices();
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create index');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: '8px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 }}>
        <button className="database-query-run-btn" onClick={fetchIndices} disabled={loading} style={{ flexShrink: 0 }}>
          {loading ? '... Loading' : 'Refresh List'}
        </button>
        <button
          className="database-form-cancel"
          onClick={() => setShowCreate(!showCreate)}
          style={{ flexShrink: 0 }}
        >
          {showCreate ? 'Cancel' : '+ Create Index'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {indices.length} {indices.length === 1 ? 'index' : 'indices'}
        </span>
      </div>

      {/* Create index form */}
      {showCreate && (
        <form onSubmit={handleCreateIndex} style={{ display: 'flex', gap: 8, marginBottom: 8, flexShrink: 0 }}>
          <input
            className="database-form-input"
            placeholder="Index name"
            value={newIndexName}
            onChange={e => setNewIndexName(e.target.value)}
            style={{ flex: 1, margin: 0 }}
            autoFocus
          />
          <button className="database-query-run-btn" type="submit" style={{ flexShrink: 0 }}>
            Create
          </button>
        </form>
      )}
      {createError && <div className="database-query-error">{createError}</div>}

      {error && <div className="database-query-error">{error}</div>}

      {/* Index list table */}
      <div className="database-results-container" style={{ flex: 1, minHeight: 0 }}>
        <div className="database-results-table-wrapper">
          <table className="database-results-table">
            <thead>
              <tr>
                <th>Index Name</th>
                <th style={{ width: 100 }}>Doc Count</th>
                <th style={{ width: 100 }}>Size</th>
                <th style={{ width: 160 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {indices.map(idx => (
                <React.Fragment key={idx.name}>
                  <tr>
                    <td>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{idx.name}</code>
                    </td>
                    <td>{idx.doc_count != null ? idx.doc_count.toLocaleString() : '-'}</td>
                    <td>{idx.size || '-'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          className="database-form-cancel"
                          onClick={() => handleRefresh(idx.name)}
                          disabled={refreshingIndex === idx.name}
                          style={{ fontSize: 11, padding: '2px 8px' }}
                        >
                          {refreshingIndex === idx.name ? '...' : 'Refresh'}
                        </button>
                        <button
                          className="database-form-cancel"
                          onClick={() => handleViewMapping(idx.name)}
                          disabled={mappingLoading}
                          style={{ fontSize: 11, padding: '2px 8px' }}
                        >
                          {mapping?.index === idx.name ? 'Hide Mapping' : 'Mapping'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {mapping?.index === idx.name && (
                    <tr>
                      <td colSpan={4} style={{ padding: 0 }}>
                        <div style={{
                          background: 'var(--bg-surface-1)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 4,
                          margin: '4px 8px 8px',
                          padding: 12,
                        }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
                            Field Mappings — {idx.name}
                          </div>
                          <table className="database-results-table">
                            <thead>
                              <tr>
                                <th>Field</th>
                                <th>Type</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(mapping.fields).map(([field, type]) => (
                                <tr key={field}>
                                  <td>
                                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{field}</code>
                                  </td>
                                  <td>
                                    <span style={{
                                      fontSize: 11,
                                      padding: '1px 6px',
                                      borderRadius: 3,
                                      background: 'var(--bg-surface-3)',
                                      color: 'var(--accent-blue)',
                                      fontFamily: 'var(--font-mono)',
                                    }}>
                                      {typeof type === 'string' ? type : JSON.stringify(type)}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatSourceValue(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 200 ? json.substring(0, 200) + '...' : json;
  }
  const str = String(value);
  return str.length > 200 ? str.substring(0, 200) + '...' : str;
}
