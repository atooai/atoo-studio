import { Client } from '@elastic/elasticsearch';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class ElasticsearchDriver implements DatabaseDriver {
  private client: Client | null = null;
  private connected = false;

  async connect(params: ConnectionParams): Promise<void> {
    const port = params.port || 9200;
    const node = params.connection_string || `http://${params.host || 'localhost'}:${port}`;

    const opts: Record<string, any> = { node };

    if (params.username && params.password) {
      opts.auth = { username: params.username, password: params.password };
    }

    this.client = new Client(opts);

    // Verify connectivity
    const ok = await this.client.ping();
    if (!ok) {
      this.client = null;
      throw new Error('Elasticsearch ping failed');
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.connected;
  }

  async query(queryStr: string, limit = 100): Promise<QueryResult> {
    if (!this.client) throw new Error('Not connected');
    const start = Date.now();

    const trimmed = queryStr.trim();
    let searchParams: Record<string, any>;

    if (trimmed.startsWith('{')) {
      // JSON query DSL: {"index": "my-index", "query": {"match_all": {}}}
      searchParams = JSON.parse(trimmed);
      if (!searchParams.size && limit) {
        searchParams.size = limit;
      }
    } else {
      // Simple format: index_name or index_name {"match": {"field": "value"}}
      const firstSpace = trimmed.indexOf(' ');
      let index: string;
      let queryBody: any = { match_all: {} };

      if (firstSpace === -1) {
        index = trimmed;
      } else {
        index = trimmed.substring(0, firstSpace);
        const rest = trimmed.substring(firstSpace + 1).trim();
        if (rest) {
          queryBody = JSON.parse(rest);
        }
      }

      searchParams = {
        index,
        query: queryBody,
        size: limit,
      };
    }

    const response = await this.client.search(searchParams);
    const elapsed = Date.now() - start;

    const hits = (response.hits?.hits || []) as Array<Record<string, any>>;
    const rows = hits.map(hit => {
      const source = (hit._source || {}) as Record<string, any>;
      return {
        _id: hit._id,
        _index: hit._index,
        ...source,
      };
    });

    const columns = rows.length > 0
      ? [...new Set(rows.flatMap(r => Object.keys(r)))]
      : [];

    const totalHits = typeof response.hits?.total === 'number'
      ? response.hits.total
      : (response.hits?.total as any)?.value ?? rows.length;

    return {
      columns,
      rows,
      row_count: rows.length,
      execution_time_ms: elapsed,
      truncated: totalHits > rows.length,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.client) throw new Error('Not connected');

    const indices = await this.client.cat.indices({ format: 'json' }) as Array<Record<string, any>>;

    const tables: TableInfo[] = indices.map(idx => ({
      name: idx.index,
      type: 'index',
      row_count: idx['docs.count'] != null ? parseInt(idx['docs.count'], 10) : undefined,
      size_bytes: idx['store.size'] ? parseStorageSize(idx['store.size']) : undefined,
    }));

    return tables.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTable(index: string): Promise<SchemaInfo> {
    if (!this.client) throw new Error('Not connected');

    const mappingResponse = await this.client.indices.getMapping({ index });
    const indexMapping = (mappingResponse as Record<string, any>)[index];
    const properties = indexMapping?.mappings?.properties || {};

    const columns: ColumnInfo[] = flattenMappingProperties(properties);

    return {
      table: index,
      columns,
      indexes: [],
      foreign_keys: [],
    };
  }

  async getDatabases(): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');

    const indices = await this.client.cat.indices({ format: 'json' }) as Array<Record<string, any>>;
    return indices
      .map(idx => idx.index as string)
      .filter(Boolean)
      .sort();
  }
}

/**
 * Flatten nested Elasticsearch mapping properties into a flat list of ColumnInfo.
 * Nested objects are represented with dot notation (e.g. "address.city").
 */
function flattenMappingProperties(
  properties: Record<string, any>,
  prefix = '',
): ColumnInfo[] {
  const columns: ColumnInfo[] = [];

  for (const [field, mapping] of Object.entries(properties)) {
    const fullName = prefix ? `${prefix}.${field}` : field;

    if (mapping.properties) {
      // Nested object — recurse
      columns.push(...flattenMappingProperties(mapping.properties, fullName));
    } else {
      columns.push({
        name: fullName,
        type: mapping.type || 'object',
        nullable: true, // ES fields are always optional
      });
    }
  }

  return columns;
}

/**
 * Parse Elasticsearch human-readable storage sizes (e.g. "1.2mb", "500kb") to bytes.
 */
function parseStorageSize(size: string): number | undefined {
  if (typeof size === 'number') return size;
  if (!size) return undefined;

  const match = size.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)$/i);
  if (!match) return undefined;

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };

  return Math.round(value * (multipliers[unit] || 1));
}
