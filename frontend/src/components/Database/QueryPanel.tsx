import React from 'react';
import { api } from '../../api';
import { useStore } from '../../state/store';

interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  row_count: number;
  execution_time_ms: number;
  truncated?: boolean;
}

interface Props {
  connectionId: string;
  selectedTable: string | null;
  dbType?: string;
}

let monacoInstance: any = null;

function getMonaco(): Promise<any> {
  if (monacoInstance) return Promise.resolve(monacoInstance);
  return import('monaco-editor').then(m => { monacoInstance = m; return m; });
}

export function QueryPanel({ connectionId, selectedTable, dbType }: Props) {
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [error, setError] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [showHistory, setShowHistory] = React.useState(false);
  const [sortCol, setSortCol] = React.useState<string | null>(null);
  const [sortAsc, setSortAsc] = React.useState(true);
  const [columnFilters, setColumnFilters] = React.useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = React.useState(false);
  const [editingCell, setEditingCell] = React.useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [pkColumns, setPkColumns] = React.useState<string[]>([]);
  const editorRef = React.useRef<any>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const completionDisposable = React.useRef<any>(null);
  const monacoReady = useStore(s => s.monacoReady);
  const queryRef = React.useRef('');
  const schemaRef = React.useRef<{ tables: string[]; columns: Record<string, { name: string; type: string }[]> }>({ tables: [], columns: {} });

  // Fetch schema for autocomplete
  React.useEffect(() => {
    if (!connectionId) return;
    api('GET', `/api/databases/${connectionId}/tables`)
      .then(async (tables: any[]) => {
        const tableNames = tables.map(t => t.name);
        const columns: Record<string, { name: string; type: string }[]> = {};
        // Fetch columns for first 30 tables (avoid overloading)
        const batch = tableNames.slice(0, 30);
        await Promise.all(batch.map(async (tName) => {
          try {
            const schema = await api('GET', `/api/databases/${connectionId}/tables/${encodeURIComponent(tName)}`);
            columns[tName] = schema.columns.map((c: any) => ({ name: c.name, type: c.type }));
          } catch {}
        }));
        schemaRef.current = { tables: tableNames, columns };
      })
      .catch(() => {});
  }, [connectionId]);

  // Initialize Monaco editor
  React.useEffect(() => {
    if (!monacoReady || !containerRef.current) return;
    let disposed = false;

    getMonaco().then(monaco => {
      if (disposed || !containerRef.current) return;

      // Register SQL completion provider for table/column names
      if (completionDisposable.current) completionDisposable.current.dispose();
      completionDisposable.current = monaco.languages.registerCompletionItemProvider('sql', {
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions: any[] = [];
          const { tables, columns } = schemaRef.current;

          // Table name completions
          for (const table of tables) {
            suggestions.push({
              label: table,
              kind: monaco.languages.CompletionItemKind.Struct,
              insertText: `"${table}"`,
              detail: 'Table',
              range,
            });
          }

          // Column name completions from all tables
          for (const [tableName, cols] of Object.entries(columns)) {
            for (const col of cols) {
              suggestions.push({
                label: `${tableName}.${col.name}`,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: `"${col.name}"`,
                detail: `${col.type} (${tableName})`,
                range,
              });
              // Also add standalone column name
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: `"${col.name}"`,
                detail: `${col.type}`,
                range,
                sortText: `1_${col.name}`, // sort after table names
              });
            }
          }

          // SQL keyword completions
          const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
            'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'ON',
            'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'DISTINCT',
            'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
            'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN',
            'ASC', 'DESC', 'NULL', 'IS NULL', 'IS NOT NULL', 'EXISTS', 'UNION', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];
          for (const kw of keywords) {
            suggestions.push({
              label: kw,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw,
              range,
              sortText: `2_${kw}`,
            });
          }

          return { suggestions };
        },
      });

      const editor = monaco.editor.create(containerRef.current, {
        value: '',
        language: 'sql',
        theme: 'atoo-dark',
        minimap: { enabled: false },
        lineNumbers: 'on',
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
        tabSize: 2,
        renderLineHighlight: 'line',
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        padding: { top: 8, bottom: 8 },
        suggest: { showKeywords: true, showSnippets: true },
      });

      // Ctrl+Enter to execute
      editor.addAction({
        id: 'execute-query',
        label: 'Execute Query',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: () => {
          const q = editor.getValue();
          if (q.trim()) {
            queryRef.current = q;
            executeQueryFromRef();
          }
        },
      });

      editor.onDidChangeModelContent(() => {
        queryRef.current = editor.getValue();
      });

      editorRef.current = editor;
    });

    return () => {
      disposed = true;
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
      if (completionDisposable.current) {
        completionDisposable.current.dispose();
        completionDisposable.current = null;
      }
    };
  }, [monacoReady]);

  // Fetch primary key columns for inline editing
  React.useEffect(() => {
    if (!selectedTable || !connectionId) { setPkColumns([]); return; }
    api('GET', `/api/databases/${connectionId}/tables/${encodeURIComponent(selectedTable)}`)
      .then((schema: any) => {
        const pks = (schema.columns || []).filter((c: any) => c.primary_key).map((c: any) => c.name);
        setPkColumns(pks);
      })
      .catch(() => setPkColumns([]));
  }, [selectedTable, connectionId]);

  // Auto-generate query when table is selected
  React.useEffect(() => {
    if (selectedTable && editorRef.current) {
      const q = `SELECT * FROM "${selectedTable}" LIMIT 100`;
      editorRef.current.setValue(q);
      queryRef.current = q;
    }
  }, [selectedTable]);

  const executeQueryFromRef = React.useCallback(async () => {
    const query = queryRef.current.trim();
    if (!query || running) return;
    setRunning(true);
    setError('');
    setSortCol(null);

    // Try WebSocket streaming first for large results
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/database-query/${encodeURIComponent(connectionId)}`;

    try {
      const streamResult = await streamQuery(wsUrl, query, 1000);
      setResult(streamResult);
      setHistory(prev => [query, ...prev.filter(h => h !== query)].slice(0, 50));
      setHistoryIdx(-1);
    } catch {
      // Fallback to REST
      try {
        const data = await api('POST', '/api/databases/query', {
          connection_id: connectionId,
          query,
          limit: 500,
        });
        setResult(data);
        setHistory(prev => [query, ...prev.filter(h => h !== query)].slice(0, 50));
        setHistoryIdx(-1);
      } catch (e: any) {
        setError(e.message);
        setResult(null);
      }
    } finally {
      setRunning(false);
    }
  }, [connectionId, running]);

  const handleExecute = () => {
    if (editorRef.current) {
      queryRef.current = editorRef.current.getValue();
    }
    executeQueryFromRef();
  };

  const loadFromHistory = (q: string) => {
    if (editorRef.current) {
      editorRef.current.setValue(q);
      queryRef.current = q;
    }
    setShowHistory(false);
  };

  const exportData = (format: 'csv' | 'json' | 'sql') => {
    if (!result) return;
    let content: string;
    let mime: string;
    let ext: string;

    if (format === 'csv') {
      const header = result.columns.join(',');
      const rows = result.rows.map(row =>
        result.columns.map(col => {
          const val = row[col];
          if (val == null) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(',')
      );
      content = [header, ...rows].join('\n');
      mime = 'text/csv';
      ext = 'csv';
    } else if (format === 'json') {
      content = JSON.stringify(result.rows, null, 2);
      mime = 'application/json';
      ext = 'json';
    } else {
      // SQL INSERT
      const tableName = selectedTable || 'table_name';
      const inserts = result.rows.map(row => {
        const vals = result.columns.map(col => {
          const v = row[col];
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        });
        return `INSERT INTO "${tableName}" (${result.columns.map(c => `"${c}"`).join(', ')}) VALUES (${vals.join(', ')});`;
      });
      content = inserts.join('\n');
      mime = 'text/sql';
      ext = 'sql';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `query-results.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  const canEdit = selectedTable && pkColumns.length > 0;

  const startEditing = (rowIdx: number, col: string, currentValue: any) => {
    if (!canEdit) return;
    setEditingCell({ row: rowIdx, col });
    setEditValue(currentValue === null || currentValue === undefined ? '' : String(currentValue));
  };

  const cancelEditing = () => {
    setEditingCell(null);
    setEditValue('');
  };

  const saveEdit = async () => {
    if (!editingCell || !result || !selectedTable) return;
    const row = filteredAndSortedRows[editingCell.row];
    if (!row) return;

    // Build primary key object
    const pk: Record<string, any> = {};
    for (const col of pkColumns) {
      pk[col] = row[col];
    }

    const newValue = editValue === '' ? null : editValue;
    try {
      await api('POST', '/api/databases/update-cell', {
        connection_id: connectionId,
        table: selectedTable,
        primary_key: pk,
        column: editingCell.col,
        value: newValue,
      });
      // Update local state
      const origRow = result.rows.find(r => pkColumns.every(k => r[k] === row[k]));
      if (origRow) origRow[editingCell.col] = newValue;
      setResult({ ...result });
    } catch (e: any) {
      setError(e.message);
    }
    cancelEditing();
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
  };

  const filteredAndSortedRows = React.useMemo(() => {
    if (!result) return [];
    let rows = result.rows;

    // Apply column filters
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v.trim() !== '');
    if (activeFilters.length > 0) {
      rows = rows.filter(row =>
        activeFilters.every(([col, filter]) => {
          const val = row[col];
          const str = val == null ? 'NULL' : String(val);
          return str.toLowerCase().includes(filter.toLowerCase());
        })
      );
    }

    // Apply sort
    if (sortCol) {
      rows = [...rows].sort((a, b) => {
        const va = a[sortCol];
        const vb = b[sortCol];
        if (va == null && vb == null) return 0;
        if (va == null) return sortAsc ? -1 : 1;
        if (vb == null) return sortAsc ? 1 : -1;
        if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
        const cmp = String(va).localeCompare(String(vb));
        return sortAsc ? cmp : -cmp;
      });
    }
    return rows;
  }, [result, sortCol, sortAsc, columnFilters]);

  return (
    <div className="database-query-panel">
      <div className="database-query-editor">
        <div
          ref={containerRef}
          className="database-monaco-container"
          style={{ height: 120 }}
        />
        {!monacoReady && (
          <textarea
            className="database-query-input"
            placeholder="Loading editor..."
            disabled
            rows={4}
          />
        )}
        <div className="database-query-actions">
          <button
            className="database-query-run-btn"
            onClick={handleExecute}
            disabled={running}
          >
            {running ? '... Running' : '▶ Execute'}
          </button>
          {result && (
            <>
              <button className="database-query-export-btn" onClick={() => exportData('csv')} title="Export as CSV">
                CSV
              </button>
              <button className="database-query-export-btn" onClick={() => exportData('json')} title="Export as JSON">
                JSON
              </button>
              <button className="database-query-export-btn" onClick={() => exportData('sql')} title="Export as SQL INSERT">
                SQL
              </button>
            </>
          )}
          {history.length > 0 && (
            <button
              className={`database-query-export-btn ${showHistory ? 'active' : ''}`}
              onClick={() => setShowHistory(!showHistory)}
              title="Query history"
            >
              History ({history.length})
            </button>
          )}
          {result && (
            <button
              className={`database-query-export-btn ${showFilters ? 'active' : ''}`}
              onClick={() => { setShowFilters(!showFilters); if (showFilters) setColumnFilters({}); }}
              title="Toggle column filters"
            >
              Filter
            </button>
          )}
          {result && (
            <span className="database-query-stats">
              {filteredAndSortedRows.length !== result.row_count
                ? `${filteredAndSortedRows.length}/${result.row_count}`
                : result.row_count
              } row{result.row_count !== 1 ? 's' : ''}
              {result.truncated ? ' (truncated)' : ''}
              {' · '}{result.execution_time_ms}ms
            </span>
          )}
        </div>
      </div>

      {showHistory && (
        <div className="database-query-history">
          {history.map((q, i) => (
            <div key={i} className="database-query-history-item" onClick={() => loadFromHistory(q)}>
              <code>{q.length > 120 ? q.substring(0, 120) + '...' : q}</code>
            </div>
          ))}
        </div>
      )}

      {error && <div className="database-query-error">{error}</div>}

      {result && (
        <div className="database-results-container">
          <div className="database-results-table-wrapper">
            <table className="database-results-table">
              <thead>
                <tr>
                  <th className="database-results-rownum">#</th>
                  {result.columns.map(col => (
                    <th
                      key={col}
                      className="database-results-sortable"
                      onClick={() => handleSort(col)}
                    >
                      {col}
                      {sortCol === col && (
                        <span className="database-results-sort-icon">
                          {sortAsc ? ' ↑' : ' ↓'}
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
                {showFilters && (
                  <tr className="database-results-filter-row">
                    <th className="database-results-rownum"></th>
                    {result.columns.map(col => (
                      <th key={`filter-${col}`}>
                        <input
                          className="database-results-filter-input"
                          type="text"
                          placeholder="Filter..."
                          value={columnFilters[col] || ''}
                          onChange={e => setColumnFilters(prev => ({ ...prev, [col]: e.target.value }))}
                          onClick={e => e.stopPropagation()}
                        />
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {filteredAndSortedRows.map((row, i) => (
                  <tr key={i}>
                    <td className="database-results-rownum">{i + 1}</td>
                    {result.columns.map(col => {
                      const isEditing = editingCell?.row === i && editingCell?.col === col;
                      const isPk = pkColumns.includes(col);
                      return (
                        <td
                          key={col}
                          title={row[col] != null ? String(row[col]) : ''}
                          className={`${canEdit && !isPk ? 'database-results-editable' : ''}`}
                          onDoubleClick={() => !isPk && startEditing(i, col, row[col])}
                        >
                          {isEditing ? (
                            <input
                              className="database-results-edit-input"
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              onBlur={saveEdit}
                              autoFocus
                            />
                          ) : (
                            <span className={row[col] === null ? 'database-null-value' : ''}>
                              {formatCell(row[col])}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!result && !error && (
        <div className="database-explorer-placeholder">
          Write a query and press Ctrl+Enter to execute
        </div>
      )}
    </div>
  );
}

function formatCell(value: any): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  const str = String(value);
  return str.length > 200 ? str.substring(0, 200) + '...' : str;
}

function streamQuery(wsUrl: string, query: string, limit: number): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let columns: string[] = [];
    const allRows: Record<string, any>[] = [];
    let rowCount = 0;
    let executionTime = 0;
    let truncated = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket query timeout'));
    }, 30000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'query', query, limit }));
    };

    ws.onmessage = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'columns':
          columns = msg.columns;
          break;
        case 'rows':
          allRows.push(...msg.rows);
          break;
        case 'complete':
          clearTimeout(timeout);
          rowCount = msg.row_count;
          executionTime = msg.execution_time_ms;
          truncated = msg.truncated || false;
          ws.close();
          resolve({ columns, rows: allRows, row_count: rowCount, execution_time_ms: executionTime, truncated });
          break;
        case 'error':
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.message));
          break;
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket connection failed'));
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      // If we already resolved/rejected, this is a no-op
    };
  });
}
