import { MongoClient, Db } from 'mongodb';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class MongoDBDriver implements DatabaseDriver {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  async connect(params: ConnectionParams): Promise<void> {
    const uri = params.connection_string ||
      `mongodb://${params.username ? `${params.username}:${params.password}@` : ''}${params.host || 'localhost'}:${params.port || 27017}/${params.database || 'test'}`;
    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db(params.database || 'test');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async query(queryStr: string, limit = 100): Promise<QueryResult> {
    if (!this.db) throw new Error('Not connected');
    const start = Date.now();

    // Parse simple query format: collection.find({...}) or collection.aggregate([...])
    const match = queryStr.match(/^(\w+)\.(find|aggregate|count|countDocuments|distinct)\((.*)?\)$/s);
    if (!match) {
      throw new Error('Query format: collection.find({filter}) or collection.aggregate([pipeline])');
    }

    const [, collName, method, argsStr] = match;
    const collection = this.db.collection(collName);
    let args: any;
    try {
      args = argsStr ? JSON.parse(argsStr) : {};
    } catch {
      args = {};
    }

    let rows: Record<string, any>[];
    if (method === 'find') {
      rows = await collection.find(args).limit(limit).toArray();
    } else if (method === 'aggregate') {
      rows = await collection.aggregate(Array.isArray(args) ? args : [args]).toArray();
    } else if (method === 'countDocuments' || method === 'count') {
      const count = await collection.countDocuments(args);
      rows = [{ count }];
    } else if (method === 'distinct') {
      const values = await collection.distinct(typeof args === 'string' ? args : Object.keys(args)[0] || '_id');
      rows = values.map(v => ({ value: v }));
    } else {
      throw new Error(`Unsupported method: ${method}`);
    }

    const elapsed = Date.now() - start;
    // Serialize ObjectIds
    const serialized = rows.map(r => {
      const obj: Record<string, any> = {};
      for (const [k, v] of Object.entries(r)) {
        obj[k] = v && typeof v === 'object' && v.toString ? v.toString() : v;
      }
      return obj;
    });

    const columns = serialized.length > 0
      ? [...new Set(serialized.flatMap(r => Object.keys(r)))]
      : [];

    return {
      columns,
      rows: serialized.slice(0, limit),
      row_count: serialized.length,
      execution_time_ms: elapsed,
      truncated: rows.length >= limit,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.db) throw new Error('Not connected');
    const collections = await this.db.listCollections().toArray();
    const tables: TableInfo[] = [];
    for (const coll of collections) {
      let row_count: number | undefined;
      try {
        row_count = await this.db.collection(coll.name).estimatedDocumentCount();
      } catch {}
      tables.push({ name: coll.name, type: 'collection', row_count });
    }
    return tables.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTable(collection: string): Promise<SchemaInfo> {
    if (!this.db) throw new Error('Not connected');
    // Sample documents to infer schema
    const sample = await this.db.collection(collection).find().limit(50).toArray();
    const fieldTypes = new Map<string, Set<string>>();
    for (const doc of sample) {
      for (const [key, value] of Object.entries(doc)) {
        if (!fieldTypes.has(key)) fieldTypes.set(key, new Set());
        const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        fieldTypes.get(key)!.add(t);
      }
    }
    const columns: ColumnInfo[] = [...fieldTypes.entries()].map(([name, types]) => ({
      name,
      type: [...types].join(' | '),
      nullable: types.has('null') || types.has('undefined'),
      primary_key: name === '_id',
    }));

    // Get indexes
    const indexList = await this.db.collection(collection).indexes();
    const indexes = indexList.map(idx => ({
      name: idx.name || '',
      columns: Object.keys(idx.key || {}),
      unique: !!idx.unique,
    }));

    return { table: collection, columns, indexes, foreign_keys: [] };
  }

  async getDatabases(): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.db('admin').admin().listDatabases();
    return result.databases.map(d => d.name);
  }
}
