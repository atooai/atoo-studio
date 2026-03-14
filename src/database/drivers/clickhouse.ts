import { createClient } from '@clickhouse/client';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class ClickHouseDriver implements DatabaseDriver {
  private client: ReturnType<typeof createClient> | null = null;

  async connect(params: ConnectionParams): Promise<void> {
    if (params.connection_string) {
      this.client = createClient({ url: params.connection_string });
    } else {
      const host = params.host || 'localhost';
      const port = params.port || 8123;
      this.client = createClient({
        url: `http://${host}:${port}`,
        username: params.username || 'default',
        password: params.password || '',
        database: params.database || 'default',
      });
    }
    // Test connection
    await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async query(sql: string, limit = 100): Promise<QueryResult> {
    if (!this.client) throw new Error('Not connected');
    const start = Date.now();
    const result = await this.client.query({ query: sql, format: 'JSONEachRow' });
    const rows: Record<string, any>[] = await result.json();
    const elapsed = Date.now() - start;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const truncated = rows.length > limit;
    return {
      columns,
      rows: rows.slice(0, limit),
      row_count: rows.length,
      execution_time_ms: elapsed,
      truncated,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.query({
      query: `
        SELECT
          name,
          engine AS type,
          total_rows,
          total_bytes
        FROM system.tables
        WHERE database = currentDatabase()
        ORDER BY name
      `,
      format: 'JSONEachRow',
    });
    const rows: Record<string, any>[] = await result.json();
    return rows.map(r => ({
      name: r.name,
      type: inferTableType(r.type),
      row_count: r.total_rows != null ? Number(r.total_rows) : undefined,
      size_bytes: r.total_bytes != null ? Number(r.total_bytes) : undefined,
    }));
  }

  async describeTable(table: string): Promise<SchemaInfo> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.query({
      query: `DESCRIBE TABLE ${quoteIdentifier(table)}`,
      format: 'JSONEachRow',
    });
    const rows: Record<string, any>[] = await result.json();

    const columns: ColumnInfo[] = rows.map(r => ({
      name: r.name,
      type: r.type,
      nullable: /Nullable/.test(r.type),
      default_value: r.default_expression || undefined,
      comment: r.comment || undefined,
    }));

    // Fetch primary key columns
    const pkResult = await this.client.query({
      query: `
        SELECT name, sorting_key
        FROM system.tables
        WHERE database = currentDatabase() AND name = {tableName:String}
      `,
      format: 'JSONEachRow',
      query_params: { tableName: table },
    });
    const pkRows: Record<string, any>[] = await pkResult.json();
    if (pkRows.length > 0 && pkRows[0].sorting_key) {
      const pkCols = new Set(
        (pkRows[0].sorting_key as string).split(',').map(s => s.trim()),
      );
      for (const col of columns) {
        if (pkCols.has(col.name)) {
          col.primary_key = true;
        }
      }
    }

    return { table, columns };
  }

  async getDatabases(): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.query({
      query: 'SHOW DATABASES',
      format: 'JSONEachRow',
    });
    const rows: Record<string, any>[] = await result.json();
    return rows.map(r => r.name);
  }
}

function quoteIdentifier(id: string): string {
  return `\`${id.replace(/`/g, '``')}\``;
}

function inferTableType(engine: string): string {
  if (/MaterializedView/i.test(engine)) return 'materialized_view';
  if (/View/i.test(engine)) return 'view';
  return 'table';
}
