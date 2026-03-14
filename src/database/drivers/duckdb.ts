import duckdb from 'duckdb';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class DuckDBDriver implements DatabaseDriver {
  private db: any = null;
  private conn: any = null;

  async connect(params: ConnectionParams): Promise<void> {
    const file = params.filename || params.database || ':memory:';
    return new Promise<void>((resolve, reject) => {
      const db = new duckdb.Database(file, (err: any) => {
        if (err) return reject(err);
        this.db = db;
        this.conn = db.connect();
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      return new Promise<void>((resolve, reject) => {
        this.db!.close((err: any) => {
          this.db = null;
          this.conn = null;
          if (err) return reject(err);
          resolve();
        });
      });
    }
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  private runAll(sql: string, params: any[] = []): Promise<Record<string, any>[]> {
    if (!this.conn) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      this.conn!.all(sql, ...params, (err: Error | null, rows: Record<string, any>[]) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  async query(sql: string, limit = 100): Promise<QueryResult> {
    if (!this.conn) throw new Error('Not connected');
    const start = Date.now();
    const trimmed = sql.trim();
    const isSelect = /^(SELECT|DESCRIBE|EXPLAIN|WITH|SHOW|FROM)\b/i.test(trimmed);

    if (isSelect) {
      const rows = await this.runAll(sql);
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
    } else {
      const rows = await this.runAll(sql);
      const elapsed = Date.now() - start;
      const changes = (rows as any)?.changes ?? 0;
      return {
        columns: ['changes'],
        rows: [{ changes }],
        row_count: changes,
        execution_time_ms: elapsed,
      };
    }
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.conn) throw new Error('Not connected');
    const tables = await this.runAll(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`
    );

    const result: TableInfo[] = [];
    for (const t of tables) {
      let row_count: number | undefined;
      try {
        const cnt = await this.runAll(`SELECT COUNT(*) as c FROM "${t.table_name}"`);
        row_count = cnt[0]?.c;
      } catch {}
      result.push({
        name: t.table_name,
        type: t.table_type === 'BASE TABLE' ? 'table' : t.table_type?.toLowerCase(),
        row_count,
      });
    }
    return result;
  }

  async describeTable(table: string): Promise<SchemaInfo> {
    if (!this.conn) throw new Error('Not connected');

    const cols = await this.runAll(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = ? AND table_schema = 'main' ORDER BY ordinal_position`,
      [table]
    );

    const columns: ColumnInfo[] = cols.map(c => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === 'YES',
      default_value: c.column_default || undefined,
    }));

    // Fetch primary key info
    try {
      const pkCols = await this.runAll(
        `SELECT column_name FROM information_schema.key_column_usage WHERE table_name = ? AND table_schema = 'main'`,
        [table]
      );
      const pkSet = new Set(pkCols.map(r => r.column_name));
      for (const col of columns) {
        if (pkSet.has(col.name)) col.primary_key = true;
      }
    } catch {}

    // Fetch indexes
    let indexes: { name: string; columns: string[]; unique: boolean }[] = [];
    try {
      const idxRows = await this.runAll(
        `SELECT index_name, column_name, is_unique FROM duckdb_indexes() WHERE table_name = ? AND schema_name = 'main'`,
        [table]
      );
      const idxMap = new Map<string, { columns: string[]; unique: boolean }>();
      for (const row of idxRows) {
        if (!idxMap.has(row.index_name)) {
          idxMap.set(row.index_name, { columns: [], unique: !!row.is_unique });
        }
        idxMap.get(row.index_name)!.columns.push(row.column_name);
      }
      indexes = Array.from(idxMap.entries()).map(([name, info]) => ({
        name,
        columns: info.columns,
        unique: info.unique,
      }));
    } catch {}

    // Fetch foreign keys
    let foreign_keys: { column: string; ref_table: string; ref_column: string }[] = [];
    try {
      const fkRows = await this.runAll(
        `SELECT rc.constraint_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu ON rc.constraint_name = kcu.constraint_name AND kcu.table_schema = 'main'
         JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name
         WHERE kcu.table_name = ? AND kcu.table_schema = 'main'`,
        [table]
      );
      foreign_keys = fkRows.map(fk => ({
        column: fk.column_name,
        ref_table: fk.ref_table,
        ref_column: fk.ref_column,
      }));
    } catch {}

    return { table, columns, indexes, foreign_keys };
  }

  async getDatabases(): Promise<string[]> {
    return ['main'];
  }
}
