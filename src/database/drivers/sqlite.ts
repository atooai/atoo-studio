import Database from 'better-sqlite3';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class SQLiteDriver implements DatabaseDriver {
  private db: Database.Database | null = null;

  async connect(params: ConnectionParams): Promise<void> {
    const file = params.filename || params.database;
    if (!file) throw new Error('filename is required for SQLite');
    const isReadonly = (params as any)._readonly === true;
    this.db = new Database(file, { readonly: isReadonly });
    if (!isReadonly) {
      this.db.pragma('journal_mode = WAL');
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  async query(sql: string, limit = 100): Promise<QueryResult> {
    if (!this.db) throw new Error('Not connected');
    const start = Date.now();
    const trimmed = sql.trim();
    const isSelect = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);

    if (isSelect) {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all() as Record<string, any>[];
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
      const result = this.db.prepare(sql).run();
      const elapsed = Date.now() - start;
      return {
        columns: ['changes', 'lastInsertRowid'],
        rows: [{ changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) }],
        row_count: result.changes,
        execution_time_ms: elapsed,
      };
    }
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.db) throw new Error('Not connected');
    const tables = this.db.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string; type: string }[];

    return tables.map(t => {
      let row_count: number | undefined;
      try {
        const cnt = this.db!.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as any;
        row_count = cnt?.c;
      } catch {}
      return { name: t.name, type: t.type, row_count };
    });
  }

  async describeTable(table: string): Promise<SchemaInfo> {
    if (!this.db) throw new Error('Not connected');

    const cols = this.db.prepare(`PRAGMA table_info("${table}")`).all() as any[];
    const columns: ColumnInfo[] = cols.map(c => ({
      name: c.name,
      type: c.type,
      nullable: !c.notnull,
      default_value: c.dflt_value || undefined,
      primary_key: !!c.pk,
    }));

    const idxList = this.db.prepare(`PRAGMA index_list("${table}")`).all() as any[];
    const indexes = idxList.map(idx => {
      const idxInfo = this.db!.prepare(`PRAGMA index_info("${idx.name}")`).all() as any[];
      return {
        name: idx.name,
        columns: idxInfo.map(i => i.name),
        unique: !!idx.unique,
      };
    });

    const fks = this.db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as any[];
    const foreign_keys = fks.map(fk => ({
      column: fk.from,
      ref_table: fk.table,
      ref_column: fk.to,
    }));

    return { table, columns, indexes, foreign_keys };
  }
}
