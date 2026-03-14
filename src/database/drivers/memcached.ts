import memjs from 'memjs';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class MemcachedDriver implements DatabaseDriver {
  private client: any = null;

  async connect(params: ConnectionParams): Promise<void> {
    const host = params.host || 'localhost';
    const port = params.port || 11211;
    this.client = memjs.Client.create(`${host}:${port}`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async query(command: string, limit = 100): Promise<QueryResult> {
    if (!this.client) throw new Error('Not connected');
    const start = Date.now();

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    let columns: string[] = [];
    let rows: Record<string, any>[] = [];

    switch (cmd) {
      case 'get': {
        if (!parts[1]) throw new Error('Usage: get <key>');
        const key = parts[1];
        const result = await this.client.get(key);
        columns = ['key', 'value'];
        const value = result.value ? result.value.toString() : '(nil)';
        rows = [{ key, value }];
        break;
      }

      case 'set': {
        if (!parts[1] || !parts[2]) throw new Error('Usage: set <key> <value>');
        const key = parts[1];
        const value = parts.slice(2).join(' ');
        await this.client.set(key, value);
        columns = ['result'];
        rows = [{ result: 'STORED' }];
        break;
      }

      case 'delete': {
        if (!parts[1]) throw new Error('Usage: delete <key>');
        const key = parts[1];
        const success = await this.client.delete(key);
        columns = ['result'];
        rows = [{ result: success ? 'DELETED' : 'NOT_FOUND' }];
        break;
      }

      case 'stats': {
        const stats = await new Promise<any>((resolve, reject) => {
          this.client.stats((err: any, _server: any, stats: any) => {
            if (err) return reject(err);
            resolve(stats || {});
          });
        }).catch(() => ({}));
        columns = ['stat', 'value'];
        for (const [stat, value] of Object.entries(stats)) {
          rows.push({ stat, value: String(value) });
        }
        rows = rows.slice(0, limit);
        break;
      }

      case 'flush_all': {
        await new Promise<void>((resolve) => {
          this.client.flush(() => resolve());
        });
        columns = ['result'];
        rows = [{ result: 'OK' }];
        break;
      }

      default:
        throw new Error(`Unsupported command: ${cmd}. Supported: get, set, delete, stats, flush_all`);
    }

    return {
      columns,
      rows,
      row_count: rows.length,
      execution_time_ms: Date.now() - start,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.client) throw new Error('Not connected');

    try {
      const stats = await new Promise<any>((resolve, reject) => {
        this.client.stats((err: any, _server: any, s: any) => {
          if (err) return reject(err);
          resolve(s || {});
        });
      });
      return [{ name: 'memcached', type: 'server', row_count: Object.keys(stats).length }];
    } catch {
      return [{ name: 'memcached', type: 'server' }];
    }
  }

  async describeTable(_table: string): Promise<SchemaInfo> {
    return {
      table: _table,
      columns: [],
      indexes: [],
      foreign_keys: [],
    };
  }

  async getDatabases(): Promise<string[]> {
    return [];
  }
}
