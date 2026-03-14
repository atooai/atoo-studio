import React from 'react';
import { api } from '../../api';

interface Props {
  connectionId: string;
}

type RedisType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'ReJSON-RL' | 'unknown';

interface KeyInfo {
  key: string;
  type: RedisType;
  ttl: number;
}

export function RedisKeyBrowser({ connectionId }: Props) {
  const [pattern, setPattern] = React.useState('*');
  const [keys, setKeys] = React.useState<KeyInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [keyValue, setKeyValue] = React.useState<any>(null);
  const [keyType, setKeyType] = React.useState<RedisType | null>(null);
  const [valueLoading, setValueLoading] = React.useState(false);
  const [valueError, setValueError] = React.useState('');

  const runCommand = React.useCallback(async (command: string): Promise<any> => {
    const data = await api('POST', '/api/databases/query', {
      connection_id: connectionId,
      query: command,
    });
    return data;
  }, [connectionId]);

  const searchKeys = React.useCallback(async () => {
    setLoading(true);
    setError('');
    setSelectedKey(null);
    setKeyValue(null);
    setKeyType(null);

    try {
      const scanResult = await runCommand(`SCAN 0 MATCH ${pattern} COUNT 100`);
      // SCAN returns [cursor, [keys...]] — extract the keys array
      let rawKeys: string[] = [];
      if (scanResult && Array.isArray(scanResult.rows) && scanResult.rows.length > 0) {
        // REST API returns structured result; try to extract keys from it
        const firstRow = scanResult.rows[0];
        const vals = Object.values(firstRow);
        if (vals.length > 0 && Array.isArray(vals[vals.length - 1])) {
          rawKeys = vals[vals.length - 1] as string[];
        } else if (vals.length > 0) {
          rawKeys = vals.map(String);
        }
      } else if (Array.isArray(scanResult)) {
        // Direct array response — SCAN returns [cursor, keys[]]
        if (Array.isArray(scanResult[1])) {
          rawKeys = scanResult[1];
        } else {
          rawKeys = scanResult;
        }
      }

      // If SCAN didn't work well, fallback to KEYS
      if (rawKeys.length === 0) {
        const keysResult = await runCommand(`KEYS ${pattern}`);
        if (Array.isArray(keysResult)) {
          rawKeys = keysResult;
        } else if (keysResult && Array.isArray(keysResult.rows)) {
          rawKeys = keysResult.rows.map((r: any) => {
            const v = Object.values(r);
            return v[0] as string;
          });
        }
      }

      // Get type and TTL for each key (batch, limit to 200)
      const limited = rawKeys.slice(0, 200);
      const keyInfos: KeyInfo[] = await Promise.all(
        limited.map(async (key) => {
          let type: RedisType = 'unknown';
          let ttl = -1;
          try {
            const typeRes = await runCommand(`TYPE ${key}`);
            const rawType = extractScalar(typeRes);
            type = (rawType || 'unknown') as RedisType;
          } catch {}
          try {
            const ttlRes = await runCommand(`TTL ${key}`);
            const rawTtl = extractScalar(ttlRes);
            ttl = parseInt(rawTtl, 10);
            if (isNaN(ttl)) ttl = -1;
          } catch {}
          return { key, type, ttl };
        })
      );

      setKeys(keyInfos);
    } catch (e: any) {
      setError(e.message || 'Failed to scan keys');
    } finally {
      setLoading(false);
    }
  }, [pattern, runCommand]);

  const loadKeyValue = React.useCallback(async (key: string, type: RedisType) => {
    setSelectedKey(key);
    setKeyType(type);
    setValueLoading(true);
    setValueError('');
    setKeyValue(null);

    try {
      let command: string;
      switch (type) {
        case 'string':
          command = `GET ${key}`;
          break;
        case 'hash':
          command = `HGETALL ${key}`;
          break;
        case 'list':
          command = `LRANGE ${key} 0 -1`;
          break;
        case 'set':
          command = `SMEMBERS ${key}`;
          break;
        case 'zset':
          command = `ZRANGE ${key} 0 -1 WITHSCORES`;
          break;
        case 'ReJSON-RL':
          command = `JSON.GET ${key}`;
          break;
        default:
          command = `GET ${key}`;
      }

      const result = await runCommand(command);
      const value = extractValue(result, type);
      setKeyValue(value);
    } catch (e: any) {
      setValueError(e.message || 'Failed to load key value');
    } finally {
      setValueLoading(false);
    }
  }, [runCommand]);

  const handleKeySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    searchKeys();
  };

  const typeLabel = (t: RedisType) => {
    switch (t) {
      case 'string': return 'STR';
      case 'hash': return 'HASH';
      case 'list': return 'LIST';
      case 'set': return 'SET';
      case 'zset': return 'ZSET';
      case 'ReJSON-RL': return 'JSON';
      default: return t.toUpperCase();
    }
  };

  const typeColor = (t: RedisType) => {
    switch (t) {
      case 'string': return 'var(--accent-green)';
      case 'hash': return 'var(--accent-blue)';
      case 'list': return 'var(--accent-yellow, #e5c07b)';
      case 'set': return 'var(--accent-purple, #c678dd)';
      case 'zset': return 'var(--accent-orange, #d19a66)';
      case 'ReJSON-RL': return 'var(--accent-cyan, #56b6c2)';
      default: return 'var(--text-muted)';
    }
  };

  const formatTtl = (ttl: number) => {
    if (ttl === -1) return 'no expiry';
    if (ttl === -2) return 'expired';
    if (ttl < 60) return `${ttl}s`;
    if (ttl < 3600) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`;
    if (ttl < 86400) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
    return `${Math.floor(ttl / 86400)}d ${Math.floor((ttl % 86400) / 3600)}h`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Search bar */}
      <form onSubmit={handleKeySubmit} style={{ display: 'flex', gap: 8, padding: '8px 0', flexShrink: 0 }}>
        <input
          className="database-form-input"
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          placeholder="Key pattern (e.g. user:*)"
          style={{ flex: 1, margin: 0 }}
        />
        <button
          className="database-query-run-btn"
          type="submit"
          disabled={loading}
          style={{ flexShrink: 0 }}
        >
          {loading ? '... Scanning' : 'Scan Keys'}
        </button>
      </form>

      {error && <div className="database-query-error">{error}</div>}

      {/* Main content: key list + detail */}
      <div style={{ display: 'flex', flex: 1, gap: 8, overflow: 'hidden', minHeight: 0 }}>
        {/* Key list */}
        <div style={{
          width: 320,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border-subtle)',
          overflow: 'hidden',
        }}>
          <div style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            padding: '4px 0',
            flexShrink: 0,
          }}>
            {keys.length > 0 ? `${keys.length} key${keys.length !== 1 ? 's' : ''} found` : 'No keys loaded'}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {keys.map(k => (
              <div
                key={k.key}
                onClick={() => loadKeyValue(k.key, k.type)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  cursor: 'pointer',
                  borderRadius: 4,
                  fontSize: 12,
                  background: selectedKey === k.key ? 'var(--accent-blue-dim)' : 'transparent',
                  color: selectedKey === k.key ? 'var(--accent-blue)' : 'var(--text-primary)',
                }}
                onMouseEnter={e => {
                  if (selectedKey !== k.key) (e.currentTarget as HTMLElement).style.background = 'var(--bg-surface-2)';
                }}
                onMouseLeave={e => {
                  if (selectedKey !== k.key) (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                <span style={{
                  fontSize: 9,
                  fontWeight: 600,
                  padding: '1px 4px',
                  borderRadius: 3,
                  background: 'var(--bg-surface-3)',
                  color: typeColor(k.type),
                  flexShrink: 0,
                  fontFamily: 'var(--font-mono)',
                }}>
                  {typeLabel(k.type)}
                </span>
                <span style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {k.key}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {formatTtl(k.ttl)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Key detail viewer */}
        <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
          {!selectedKey && (
            <div className="database-explorer-placeholder">
              Select a key to view its value
            </div>
          )}

          {selectedKey && valueLoading && (
            <div className="database-explorer-placeholder">
              Loading value...
            </div>
          )}

          {selectedKey && valueError && (
            <div className="database-query-error">{valueError}</div>
          )}

          {selectedKey && keyValue !== null && !valueLoading && (
            <div style={{ padding: '8px 0' }}>
              <div style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <span style={{
                  fontSize: 9,
                  fontWeight: 600,
                  padding: '1px 4px',
                  borderRadius: 3,
                  background: 'var(--bg-surface-3)',
                  color: typeColor(keyType!),
                  fontFamily: 'var(--font-mono)',
                }}>
                  {typeLabel(keyType!)}
                </span>
                <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', fontSize: 12 }}>
                  {selectedKey}
                </code>
              </div>

              <KeyValueRenderer type={keyType!} value={keyValue} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyValueRenderer({ type, value }: { type: RedisType; value: any }) {
  const codeStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    background: 'var(--bg-surface-1)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 4,
    padding: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    overflowX: 'auto',
    color: 'var(--text-primary)',
  };

  switch (type) {
    case 'string':
      return <pre style={codeStyle}>{String(value)}</pre>;

    case 'hash': {
      const entries: [string, string][] = Array.isArray(value)
        ? pairUp(value)
        : Object.entries(value);
      return (
        <table className="database-results-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([field, val], i) => (
              <tr key={i}>
                <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{field}</code></td>
                <td style={{ wordBreak: 'break-all' }}>{val}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    case 'list': {
      const items: string[] = Array.isArray(value) ? value : [String(value)];
      return (
        <table className="database-results-table">
          <thead>
            <tr>
              <th style={{ width: 60 }}>#</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td className="database-results-rownum">{i}</td>
                <td style={{ wordBreak: 'break-all' }}>{item}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    case 'set': {
      const members: string[] = Array.isArray(value) ? value : [String(value)];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {members.map((m, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              padding: '4px 8px',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>*</span>
              <span style={{ wordBreak: 'break-all' }}>{m}</span>
            </div>
          ))}
        </div>
      );
    }

    case 'zset': {
      const pairs: [string, string][] = Array.isArray(value) ? pairUp(value) : Object.entries(value);
      return (
        <table className="database-results-table">
          <thead>
            <tr>
              <th>Value</th>
              <th style={{ width: 100 }}>Score</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map(([val, score], i) => (
              <tr key={i}>
                <td style={{ wordBreak: 'break-all' }}>{val}</td>
                <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{score}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    case 'ReJSON-RL': {
      let formatted: string;
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        formatted = JSON.stringify(parsed, null, 2);
      } catch {
        formatted = String(value);
      }
      return <pre style={codeStyle}>{formatted}</pre>;
    }

    default:
      return <pre style={codeStyle}>{String(value)}</pre>;
  }
}

/** Extract a scalar value from the API response */
function extractScalar(result: any): string {
  if (typeof result === 'string') return result;
  if (typeof result === 'number') return String(result);
  if (result && Array.isArray(result.rows) && result.rows.length > 0) {
    const first = result.rows[0];
    const vals = Object.values(first);
    return vals.length > 0 ? String(vals[0]) : '';
  }
  if (Array.isArray(result) && result.length > 0) {
    return String(result[0]);
  }
  return String(result);
}

/** Extract value from API response based on Redis type */
function extractValue(result: any, type: RedisType): any {
  // If it's already a plain value, return directly
  if (typeof result === 'string' || typeof result === 'number') return result;

  // Handle structured API response with rows
  if (result && Array.isArray(result.rows)) {
    if (type === 'string' || type === 'ReJSON-RL') {
      if (result.rows.length > 0) {
        const vals = Object.values(result.rows[0]);
        return vals[0];
      }
      return '';
    }
    // For collection types, extract values from rows
    if (result.rows.length > 0) {
      const firstRow = result.rows[0];
      const vals = Object.values(firstRow);
      // If single column with array, return it
      if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
      // For HGETALL / ZRANGE WITHSCORES, might come back as flat array
      if (vals.length === 1) {
        const v = vals[0];
        if (Array.isArray(v)) return v;
        return [String(v)];
      }
      // Multiple columns — return rows as flat array of values
      return result.rows.map((r: any) => Object.values(r)).flat();
    }
    return [];
  }

  // Direct array response
  if (Array.isArray(result)) return result;

  return result;
}

/** Pair up a flat array into [key, value] tuples */
function pairUp(arr: any[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < arr.length; i += 2) {
    pairs.push([String(arr[i]), String(arr[i + 1] ?? '')]);
  }
  return pairs;
}
