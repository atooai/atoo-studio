import { Client } from 'cassandra-driver';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class CassandraDriver implements DatabaseDriver {
  private client: Client | null = null;
  private keyspace: string = '';

  async connect(params: ConnectionParams): Promise<void> {
    const host = params.host || 'localhost';
    const port = params.port || 9042;
    this.keyspace = params.database || '';

    const opts: any = {
      contactPoints: [`${host}:${port}`],
      localDataCenter: 'datacenter1',
    };

    if (this.keyspace) {
      opts.keyspace = this.keyspace;
    }

    if (params.username && params.password) {
      opts.credentials = { username: params.username, password: params.password };
    }

    this.client = new Client(opts);
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.shutdown();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async query(cql: string, limit = 100): Promise<QueryResult> {
    if (!this.client) throw new Error('Not connected');
    const start = Date.now();

    const result = await this.client.execute(cql);
    const elapsed = Date.now() - start;

    const columns = result.columns ? result.columns.map((c: any) => c.name) : [];
    const rows = (result.rows || []).slice(0, limit).map((row: any) => {
      const obj: Record<string, any> = {};
      for (const col of columns) {
        obj[col] = row[col];
      }
      return obj;
    });

    return {
      columns,
      rows,
      row_count: rows.length,
      execution_time_ms: elapsed,
      truncated: (result.rows || []).length > limit,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.client) throw new Error('Not connected');

    const keyspace = this.keyspace || this.client.keyspace;
    if (!keyspace) throw new Error('No keyspace selected');

    const result = await this.client.execute(
      'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
      [keyspace],
    );

    return (result.rows || []).map((row: any) => ({
      name: row.table_name,
      type: 'table',
    }));
  }

  async describeTable(table: string): Promise<SchemaInfo> {
    if (!this.client) throw new Error('Not connected');

    const keyspace = this.keyspace || this.client.keyspace;
    if (!keyspace) throw new Error('No keyspace selected');

    const result = await this.client.execute(
      'SELECT column_name, type, kind FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
      [keyspace, table],
    );

    const columns: ColumnInfo[] = (result.rows || []).map((row: any) => ({
      name: row.column_name,
      type: row.type,
      nullable: row.kind !== 'partition_key' && row.kind !== 'clustering',
      primary_key: row.kind === 'partition_key' || row.kind === 'clustering',
    }));

    return {
      table,
      columns,
      indexes: [],
      foreign_keys: [],
    };
  }

  async getDatabases(): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');

    const result = await this.client.execute('SELECT keyspace_name FROM system_schema.keyspaces');
    return (result.rows || []).map((row: any) => row.keyspace_name);
  }
}
