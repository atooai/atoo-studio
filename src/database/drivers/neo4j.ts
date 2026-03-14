import neo4j from 'neo4j-driver';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

function serializeValue(val: any): any {
  if (val === null || val === undefined) return val;
  if (neo4j.isInt(val)) return val.toNumber();
  if (val instanceof neo4j.types.Node) {
    return { labels: val.labels, properties: serializeRecord(val.properties) };
  }
  if (val instanceof neo4j.types.Relationship) {
    return { type: val.type, properties: serializeRecord(val.properties) };
  }
  if (val instanceof neo4j.types.Path) {
    const segments = val.segments.map((s: any) =>
      `(${s.start.labels.join(':')})-[:${s.relationship.type}]->(${s.end.labels.join(':')})`
    );
    return segments.join('');
  }
  if (Array.isArray(val)) return val.map(serializeValue);
  if (typeof val === 'object') return serializeRecord(val);
  return val;
}

function serializeRecord(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = serializeValue(v);
  }
  return out;
}

function inferType(val: any): string {
  if (val === null || val === undefined) return 'unknown';
  if (neo4j.isInt(val)) return 'integer';
  if (typeof val === 'number') return 'float';
  if (typeof val === 'boolean') return 'boolean';
  if (typeof val === 'string') return 'string';
  if (Array.isArray(val)) return 'list';
  if (val instanceof Date) return 'datetime';
  if (typeof val === 'object') return 'map';
  return typeof val;
}

export class Neo4jDriver implements DatabaseDriver {
  private driver: any = null;

  async connect(params: ConnectionParams): Promise<void> {
    const host = params.host || 'localhost';
    const port = params.port || 7687;
    const uri = params.connection_string || `bolt://${host}:${port}`;

    const auth = params.username
      ? neo4j.auth.basic(params.username, params.password || '')
      : undefined;

    this.driver = neo4j.driver(uri, auth);
    await this.driver.verifyConnectivity();
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  isConnected(): boolean {
    return this.driver !== null;
  }

  async query(cypher: string, limit?: number): Promise<QueryResult> {
    if (!this.driver) throw new Error('Not connected');
    const session = this.driver.session();
    const start = Date.now();

    try {
      const result = await session.run(cypher);
      const elapsed = Date.now() - start;

      const rows = result.records.map((record: any) => {
        const obj: Record<string, any> = {};
        for (const key of record.keys) {
          obj[key as string] = serializeValue(record.get(key as string));
        }
        return obj;
      });

      const columns = result.records.length > 0
        ? (result.records[0].keys as string[])
        : [];

      const truncated = limit !== undefined && rows.length >= limit;
      const sliced = limit !== undefined ? rows.slice(0, limit) : rows;

      return {
        columns,
        rows: sliced,
        row_count: sliced.length,
        execution_time_ms: elapsed,
        truncated,
      };
    } finally {
      await session.close();
    }
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.driver) throw new Error('Not connected');
    const session = this.driver.session();

    try {
      const tables: TableInfo[] = [];

      const labelsResult = await session.run('CALL db.labels()');
      for (const record of labelsResult.records) {
        tables.push({ name: record.get('label'), type: 'label' });
      }

      const relsResult = await session.run('CALL db.relationshipTypes()');
      for (const record of relsResult.records) {
        tables.push({ name: record.get('relationshipType'), type: 'relationship' });
      }

      return tables.sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      await session.close();
    }
  }

  async describeTable(label: string): Promise<SchemaInfo> {
    if (!this.driver) throw new Error('Not connected');
    const session = this.driver.session();

    try {
      const result = await session.run(
        `MATCH (n:\`${label}\`) WITH n LIMIT 50 UNWIND keys(n) AS key RETURN DISTINCT key, head(collect(n[key])) AS sample`
      );

      const columns: ColumnInfo[] = result.records.map((record: any) => {
        const name = record.get('key') as string;
        const sample = record.get('sample');
        return {
          name,
          type: inferType(sample),
          nullable: true,
        };
      });

      return { table: label, columns, indexes: [], foreign_keys: [] };
    } finally {
      await session.close();
    }
  }

  async getDatabases(): Promise<string[]> {
    if (!this.driver) throw new Error('Not connected');
    const session = this.driver.session();

    try {
      const result = await session.run('SHOW DATABASES');
      return result.records.map((record: any) => record.get('name') as string);
    } catch {
      return ['neo4j'];
    } finally {
      await session.close();
    }
  }
}
