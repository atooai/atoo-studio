import mysql from 'mysql2/promise';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class MySQLDriver implements DatabaseDriver {
  private pool: mysql.Pool | null = null;

  async connect(params: ConnectionParams): Promise<void> {
    if (params.connection_string) {
      this.pool = mysql.createPool(params.connection_string);
    } else {
      this.pool = mysql.createPool({
        host: params.host || 'localhost',
        port: params.port || 3306,
        user: params.username || 'root',
        password: params.password || '',
        database: params.database,
        connectionLimit: 5,
      });
    }
    // Test connection
    const conn = await this.pool.getConnection();
    conn.release();
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
    const [rows, fields] = await this.pool.query(sql);
    const elapsed = Date.now() - start;
    const rowArr = Array.isArray(rows) ? rows as Record<string, any>[] : [];
    const columns = fields && Array.isArray(fields)
      ? fields.map((f: any) => f.name)
      : (rowArr.length > 0 ? Object.keys(rowArr[0]) : []);
    const truncated = rowArr.length > limit;
    return {
      columns,
      rows: rowArr.slice(0, limit),
      row_count: (rows as any).affectedRows ?? rowArr.length,
      execution_time_ms: elapsed,
      truncated,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.pool) throw new Error('Not connected');
    const [rows] = await this.pool.query(`
      SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS row_count, DATA_LENGTH AS size_bytes
      FROM information_schema.tables
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME
    `);
    return (rows as any[]).map(r => ({
      name: r.name,
      type: r.type === 'BASE TABLE' ? 'table' : r.type?.toLowerCase(),
      row_count: r.row_count != null ? parseInt(r.row_count) : undefined,
      size_bytes: r.size_bytes != null ? parseInt(r.size_bytes) : undefined,
    }));
  }

  async describeTable(table: string): Promise<SchemaInfo> {
    if (!this.pool) throw new Error('Not connected');

    const [cols] = await this.pool.query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
      FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [table]);

    const columns: ColumnInfo[] = (cols as any[]).map(c => ({
      name: c.COLUMN_NAME,
      type: c.DATA_TYPE,
      nullable: c.IS_NULLABLE === 'YES',
      default_value: c.COLUMN_DEFAULT || undefined,
      primary_key: c.COLUMN_KEY === 'PRI',
    }));

    const [idxRows] = await this.pool.query(`SHOW INDEX FROM \`${table}\``);
    const idxMap = new Map<string, { columns: string[]; unique: boolean }>();
    for (const r of idxRows as any[]) {
      if (!idxMap.has(r.Key_name)) idxMap.set(r.Key_name, { columns: [], unique: !r.Non_unique });
      idxMap.get(r.Key_name)!.columns.push(r.Column_name);
    }
    const indexes = [...idxMap.entries()].map(([name, v]) => ({ name, ...v }));

    const [fkRows] = await this.pool.query(`
      SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
    `, [table]);

    return {
      table,
      columns,
      indexes,
      foreign_keys: (fkRows as any[]).map(r => ({
        column: r.COLUMN_NAME,
        ref_table: r.REFERENCED_TABLE_NAME,
        ref_column: r.REFERENCED_COLUMN_NAME,
      })),
    };
  }

  async getDatabases(): Promise<string[]> {
    if (!this.pool) throw new Error('Not connected');
    const [rows] = await this.pool.query('SHOW DATABASES');
    return (rows as any[]).map(r => r.Database);
  }
}
