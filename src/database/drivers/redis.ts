import RedisLib from 'ioredis';
const Redis = RedisLib.Redis || (RedisLib as any);
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo } from '../types.js';

export class RedisDriver implements DatabaseDriver {
  private client: any | null = null;

  async connect(params: ConnectionParams): Promise<void> {
    if (params.connection_string) {
      this.client = new Redis(params.connection_string, { lazyConnect: true });
    } else {
      this.client = new Redis({
        host: params.host || 'localhost',
        port: params.port || 6379,
        password: params.password || undefined,
        db: params.database ? parseInt(params.database) : 0,
        lazyConnect: true,
      });
    }
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }

  async query(command: string, limit = 100): Promise<QueryResult> {
    if (!this.client) throw new Error('Not connected');
    const start = Date.now();
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toUpperCase();
    const args = parts.slice(1);

    const result = await (this.client as any).call(cmd, ...args);
    const elapsed = Date.now() - start;

    // Format result based on type
    if (Array.isArray(result)) {
      // KEYS, SCAN results, etc
      const rows = result.slice(0, limit).map((v, i) => ({ index: i, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
      return { columns: ['index', 'value'], rows, row_count: result.length, execution_time_ms: elapsed, truncated: result.length > limit };
    }
    if (result !== null && typeof result === 'object') {
      const entries = Object.entries(result).slice(0, limit);
      const rows = entries.map(([k, v]) => ({ key: k, value: String(v) }));
      return { columns: ['key', 'value'], rows, row_count: entries.length, execution_time_ms: elapsed };
    }
    return {
      columns: ['result'],
      rows: [{ result: result === null ? '(nil)' : String(result) }],
      row_count: 1,
      execution_time_ms: elapsed,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const dbSize = await this.client.dbsize();
    // Get a sample of keys
    const keys = await this.client.keys('*');
    const sample = keys.slice(0, 100);
    // Group by prefix (before first :)
    const prefixes = new Map<string, number>();
    for (const key of sample) {
      const prefix = key.includes(':') ? key.split(':')[0] + ':*' : key;
      prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
    }
    return [
      { name: `(${dbSize} total keys)`, type: 'keyspace', row_count: dbSize },
      ...[...prefixes.entries()].map(([name, count]) => ({ name, type: 'pattern', row_count: count })),
    ];
  }

  async describeTable(pattern: string): Promise<SchemaInfo> {
    if (!this.client) throw new Error('Not connected');
    // For Redis, "describe" a key pattern by sampling
    const keys = await this.client.keys(pattern.replace('*', '') + '*');
    const sample = keys.slice(0, 10);
    const columns = [];
    for (const key of sample) {
      const type = await this.client.type(key);
      const ttl = await this.client.ttl(key);
      columns.push({ name: key, type: `${type} (TTL: ${ttl === -1 ? 'none' : ttl + 's'})`, nullable: false });
    }
    return { table: pattern, columns, indexes: [], foreign_keys: [] };
  }

  async getDatabases(): Promise<string[]> {
    return Array.from({ length: 16 }, (_, i) => String(i));
  }
}
