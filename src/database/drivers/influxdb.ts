import { InfluxDB, QueryApi } from '@influxdata/influxdb-client';
import type { ConnectionParams, DatabaseDriver, QueryResult, TableInfo, SchemaInfo, ColumnInfo } from '../types.js';

export class InfluxDBDriver implements DatabaseDriver {
  private client: InfluxDB | null = null;
  private queryApi: QueryApi | null = null;
  private org = '';
  private bucket = '';

  async connect(params: ConnectionParams): Promise<void> {
    let url: string;
    let token: string;

    if (params.connection_string) {
      // Parse connection string: http://host:port?org=myorg&bucket=mybucket or similar
      const parsed = new URL(params.connection_string);
      url = `${parsed.protocol}//${parsed.host}`;
      token = params.password || parsed.searchParams.get('token') || '';
      this.org = parsed.searchParams.get('org') || params.database || '';
      this.bucket = parsed.searchParams.get('bucket') || '';
    } else {
      const port = params.port || 8086;
      const host = params.host || 'localhost';
      url = `http://${host}:${port}`;
      token = params.password || '';
    }

    // Handle org/bucket format in the database field
    if (params.database && !this.org) {
      if (params.database.includes('/')) {
        const parts = params.database.split('/');
        this.org = parts[0];
        this.bucket = parts[1];
      } else {
        this.org = params.database;
        this.bucket = params.database;
      }
    }

    if (!this.bucket && this.org) {
      this.bucket = this.org;
    }

    this.client = new InfluxDB({ url, token });
    this.queryApi = this.client.getQueryApi(this.org);

    // Verify connectivity by running a simple query
    try {
      await this.queryApi.collectRows('buckets() |> limit(n: 1)');
    } catch (err: any) {
      this.client = null;
      this.queryApi = null;
      throw new Error(`InfluxDB connection failed: ${err.message}`);
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.queryApi = null;
    this.org = '';
    this.bucket = '';
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async query(flux: string, limit?: number): Promise<QueryResult> {
    if (!this.queryApi) throw new Error('Not connected');
    const start = Date.now();

    let effectiveQuery = flux.trim();
    if (limit && !effectiveQuery.includes('|> limit(')) {
      effectiveQuery += ` |> limit(n: ${limit})`;
    }

    const rawRows = await this.queryApi.collectRows(effectiveQuery) as Array<Record<string, any>>;
    const elapsed = Date.now() - start;

    // Convert InfluxDB row objects — strip internal metadata prefixes
    const rows = rawRows.map(row => {
      const record: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        record[key] = value;
      }
      return record;
    });

    const columns = rows.length > 0
      ? [...new Set(rows.flatMap(r => Object.keys(r)))]
      : [];

    return {
      columns,
      rows,
      row_count: rows.length,
      execution_time_ms: elapsed,
    };
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.queryApi) throw new Error('Not connected');

    const tables: TableInfo[] = [];

    // If we have a specific bucket, list measurements within it
    if (this.bucket) {
      try {
        const flux = `import "influxdata/influxdb/schema"\nschema.measurements(bucket: "${escapeBucket(this.bucket)}")`;
        const rows = await this.queryApi.collectRows(flux) as Array<Record<string, any>>;
        for (const row of rows) {
          const name = row._value || row.name;
          if (name) {
            tables.push({ name: String(name), type: 'measurement' });
          }
        }
      } catch {
        // Fall back to listing buckets if measurement listing fails
      }
    }

    // If no measurements found, or no bucket specified, list buckets
    if (tables.length === 0) {
      const flux = 'buckets()';
      const rows = await this.queryApi.collectRows(flux) as Array<Record<string, any>>;
      for (const row of rows) {
        const name = row.name;
        if (name && !String(name).startsWith('_')) {
          tables.push({ name: String(name), type: 'bucket' });
        }
      }
    }

    return tables.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTable(measurement: string): Promise<SchemaInfo> {
    if (!this.queryApi) throw new Error('Not connected');

    const bucket = escapeBucket(this.bucket);
    const meas = escapeMeasurement(measurement);
    const columns: ColumnInfo[] = [];

    // Get field keys
    try {
      const fieldFlux = `import "influxdata/influxdb/schema"\nschema.measurementFieldKeys(bucket: "${bucket}", measurement: "${meas}")`;
      const fieldRows = await this.queryApi.collectRows(fieldFlux) as Array<Record<string, any>>;
      for (const row of fieldRows) {
        const name = row._value || row.name;
        if (name) {
          columns.push({
            name: String(name),
            type: 'field',
            nullable: true,
          });
        }
      }
    } catch {
      // Field key listing not supported on all versions
    }

    // Get tag keys
    try {
      const tagFlux = `import "influxdata/influxdb/schema"\nschema.measurementTagKeys(bucket: "${bucket}", measurement: "${meas}")`;
      const tagRows = await this.queryApi.collectRows(tagFlux) as Array<Record<string, any>>;
      for (const row of tagRows) {
        const name = row._value || row.name;
        if (name && !String(name).startsWith('_')) {
          columns.push({
            name: String(name),
            type: 'tag',
            nullable: true,
          });
        }
      }
    } catch {
      // Tag key listing not supported on all versions
    }

    // Always include the implicit _time column
    if (!columns.some(c => c.name === '_time')) {
      columns.unshift({
        name: '_time',
        type: 'timestamp',
        nullable: false,
      });
    }

    return {
      table: measurement,
      columns,
      indexes: [],
      foreign_keys: [],
    };
  }

  async getDatabases(): Promise<string[]> {
    if (!this.queryApi) throw new Error('Not connected');

    const flux = 'buckets() |> keep(columns: ["name"])';
    const rows = await this.queryApi.collectRows(flux) as Array<Record<string, any>>;

    return rows
      .map(row => String(row.name || ''))
      .filter(name => name && !name.startsWith('_'))
      .sort();
  }
}

function escapeBucket(bucket: string): string {
  return bucket.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeMeasurement(measurement: string): string {
  return measurement.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
