import pg from 'pg';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class PostgreSQLDriver implements DatabaseDriver {
  private pool: pg.Pool | null = null;

  async connect(params: ConnectionParams): Promise<void> {
    if (params.connection_string) {
      this.pool = new pg.Pool({ connectionString: params.connection_string, max: 5 });
    } else {
      this.pool = new pg.Pool({
        host: params.host || 'localhost',
        port: params.port || 5432,
        user: params.username || 'postgres',
        password: params.password || '',
        database: params.database || 'postgres',
        max: 5,
      });
    }
    // Test connection
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  isConnected(): boolean {
    return this.pool !== null;
  }

  async query(sql: string, limit = 100): Promise<QueryResult> {
    if (!this.pool) throw new Error('Not connected');
    const start = Date.now();
    const result = await this.pool.query(sql);
    const elapsed = Date.now() - start;
    const rows = result.rows || [];
    const columns = result.fields?.map(f => f.name) || (rows.length > 0 ? Object.keys(rows[0]) : []);
    const truncated = rows.length > limit;
    return {
      columns,
      rows: rows.slice(0, limit),
      row_count: result.rowCount ?? rows.length,
      execution_time_ms: elapsed,
      truncated,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.pool) throw new Error('Not connected');
    const result = await this.pool.query(`
      SELECT
        t.table_name AS name,
        t.table_type AS type,
        pg_total_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::bigint AS size_bytes,
        s.n_live_tup AS row_count
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name AND s.schemaname = t.table_schema
      WHERE t.table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY t.table_name
    `);
    return result.rows.map(r => ({
      name: r.name,
      type: r.type === 'BASE TABLE' ? 'table' : r.type?.toLowerCase(),
      row_count: parseInt(r.row_count) || undefined,
      size_bytes: parseInt(r.size_bytes) || undefined,
    }));
  }

  async describeTable(table: string): Promise<SchemaInfo> {
    if (!this.pool) throw new Error('Not connected');
    // Columns
    const cols = await this.pool.query(`
      SELECT
        c.column_name, c.data_type, c.is_nullable, c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
        WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      WHERE c.table_name = $1 AND c.table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY c.ordinal_position
    `, [table]);

    const columns: ColumnInfo[] = cols.rows.map(r => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
      default_value: r.column_default || undefined,
      primary_key: r.is_pk,
    }));

    // Indexes
    const idxResult = await this.pool.query(`
      SELECT indexname AS name, indexdef
      FROM pg_indexes
      WHERE tablename = $1 AND schemaname NOT IN ('information_schema', 'pg_catalog')
    `, [table]);
    const indexes = idxResult.rows.map(r => ({
      name: r.name,
      columns: (r.indexdef.match(/\(([^)]+)\)/)?.[1] || '').split(',').map((s: string) => s.trim()),
      unique: /UNIQUE/i.test(r.indexdef),
    }));

    // Foreign keys
    const fkResult = await this.pool.query(`
      SELECT
        kcu.column_name AS column,
        ccu.table_name AS ref_table,
        ccu.column_name AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
    `, [table]);

    return {
      table,
      columns,
      indexes,
      foreign_keys: fkResult.rows.map(r => ({
        column: r.column,
        ref_table: r.ref_table,
        ref_column: r.ref_column,
      })),
    };
  }

  async getDatabases(): Promise<string[]> {
    if (!this.pool) throw new Error('Not connected');
    const result = await this.pool.query(`SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`);
    return result.rows.map(r => r.datname);
  }
}
