export type DbType =
  | 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'redis'
  | 'mongodb' | 'duckdb' | 'elasticsearch' | 'opensearch'
  | 'clickhouse' | 'cockroachdb' | 'cassandra' | 'scylladb'
  | 'neo4j' | 'influxdb' | 'memcached';

export type DiscoverySource = 'local' | 'container' | 'manual' | 'ssh';

export interface ConnectionParams {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  filename?: string;
  connection_string?: string;
  /** SSH tunnel: Atoo Studio SSH connection ID */
  ssh_connection_id?: string;
  /** SSH tunnel: remote host (default 127.0.0.1) */
  ssh_remote_host?: string;
  /** SSH tunnel: remote port (defaults to the DB's default port) */
  ssh_remote_port?: number;
}

export interface DiscoveredDatabase {
  id: string;
  name: string;
  db_type: DbType;
  source: DiscoverySource;
  params: ConnectionParams;
  /** e.g. container name, file path */
  source_detail?: string;
  connected?: boolean;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  row_count: number;
  execution_time_ms: number;
  truncated?: boolean;
}

export interface TableInfo {
  name: string;
  type?: string; // 'table' | 'view' | 'materialized_view'
  row_count?: number;
  size_bytes?: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default_value?: string;
  primary_key?: boolean;
  comment?: string;
}

export interface SchemaInfo {
  table: string;
  columns: ColumnInfo[];
  indexes?: { name: string; columns: string[]; unique: boolean }[];
  foreign_keys?: { column: string; ref_table: string; ref_column: string }[];
}

export interface DatabaseDriver {
  connect(params: ConnectionParams): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  query(sql: string, limit?: number): Promise<QueryResult>;
  getTables(): Promise<TableInfo[]>;
  describeTable(table: string): Promise<SchemaInfo>;
  getDatabases?(): Promise<string[]>;
}
