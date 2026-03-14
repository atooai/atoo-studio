import { v4 as uuidv4 } from 'uuid';
import type { ConnectionParams, DatabaseDriver, DbType, DiscoveredDatabase, QueryResult, SchemaInfo, TableInfo } from './types.js';
// Tier 1 drivers — always available (deps already in package.json)
import { PostgreSQLDriver } from './drivers/postgresql.js';
import { SQLiteDriver } from './drivers/sqlite.js';
import { MySQLDriver } from './drivers/mysql.js';
import { RedisDriver } from './drivers/redis.js';
import { MongoDBDriver } from './drivers/mongodb.js';
import { sshManager } from '../services/ssh-manager.js';

// Tier 2+3 drivers — loaded lazily so missing npm packages don't crash the server
async function loadDriver(name: string): Promise<{ new(): DatabaseDriver }> {
  try {
    switch (name) {
      case 'duckdb': return (await import('./drivers/duckdb.js')).DuckDBDriver;
      case 'elasticsearch': return (await import('./drivers/elasticsearch.js')).ElasticsearchDriver;
      case 'clickhouse': return (await import('./drivers/clickhouse.js')).ClickHouseDriver;
      case 'neo4j': return (await import('./drivers/neo4j.js')).Neo4jDriver;
      case 'influxdb': return (await import('./drivers/influxdb.js')).InfluxDBDriver;
      case 'cassandra': return (await import('./drivers/cassandra.js')).CassandraDriver;
      case 'memcached': return (await import('./drivers/memcached.js')).MemcachedDriver;
      default: throw new Error(`Unknown driver: ${name}`);
    }
  } catch (err: any) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
      throw new Error(`Driver for ${name} is not installed. Run: npm install ${getPackageName(name)}`);
    }
    throw err;
  }
}

function getPackageName(driver: string): string {
  const map: Record<string, string> = {
    duckdb: 'duckdb', elasticsearch: '@elastic/elasticsearch',
    clickhouse: '@clickhouse/client', neo4j: 'neo4j-driver',
    influxdb: '@influxdata/influxdb-client', cassandra: 'cassandra-driver',
    memcached: 'memjs',
  };
  return map[driver] || driver;
}

interface ManagedConnection {
  id: string;
  db_type: DbType;
  driver: DatabaseDriver;
  params: ConnectionParams;
  name: string;
  readonly: boolean;
  created_at: number;
  last_used: number;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Statements that modify data — blocked in readonly mode. */
const WRITE_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE)\b/i;

async function createDriver(dbType: DbType): Promise<DatabaseDriver> {
  // Tier 1 — always available
  switch (dbType) {
    case 'postgresql':
    case 'cockroachdb':
      return new PostgreSQLDriver();
    case 'sqlite':
      return new SQLiteDriver();
    case 'mysql':
    case 'mariadb':
      return new MySQLDriver();
    case 'redis':
      return new RedisDriver();
    case 'mongodb':
      return new MongoDBDriver();
  }
  // Tier 2+3 — lazy loaded
  const driverMap: Record<string, string> = {
    duckdb: 'duckdb', elasticsearch: 'elasticsearch', opensearch: 'elasticsearch',
    clickhouse: 'clickhouse', neo4j: 'neo4j', influxdb: 'influxdb',
    cassandra: 'cassandra', scylladb: 'cassandra', memcached: 'memcached',
  };
  const driverName = driverMap[dbType];
  if (!driverName) throw new Error(`Unsupported database type: ${dbType}`);
  const DriverClass = await loadDriver(driverName);
  return new DriverClass();
}

class ConnectionManager {
  private connections = new Map<string, ManagedConnection>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupIdle(), 60_000);
  }

  async connect(dbType: DbType, params: ConnectionParams, name?: string, readonly = false): Promise<string> {
    const driver = await createDriver(dbType);

    // SSH tunnel: if ssh_connection_id is specified, create a local port forward
    let effectiveParams = { ...params };
    if (params.ssh_connection_id) {
      if (!sshManager.isConnected(params.ssh_connection_id)) {
        throw new Error('SSH connection is not active. Connect to the SSH host first.');
      }
      const remotePort = params.ssh_remote_port || params.port || this.getDefaultPort(dbType);
      const localPort = await sshManager.getOrCreateForwardTunnel(params.ssh_connection_id, remotePort);
      // Override host/port to go through the tunnel
      effectiveParams = { ...params, host: '127.0.0.1', port: localPort };
      // Clear connection_string since we're routing through tunnel
      delete effectiveParams.connection_string;
    }

    // For SQLite, enforce readonly at the driver level
    if (readonly && dbType === 'sqlite') {
      effectiveParams = { ...effectiveParams, _readonly: true } as any;
    }

    await driver.connect(effectiveParams);

    // For PostgreSQL/CockroachDB, set default transaction read-only
    if (readonly && (dbType === 'postgresql' || dbType === 'cockroachdb')) {
      try {
        await driver.query('SET default_transaction_read_only = ON');
      } catch {}
    }

    // For MySQL/MariaDB, set read-only session variable
    if (readonly && (dbType === 'mysql' || dbType === 'mariadb')) {
      try {
        await driver.query('SET SESSION TRANSACTION READ ONLY');
      } catch {}
    }

    const id = uuidv4();
    this.connections.set(id, {
      id,
      db_type: dbType,
      driver,
      params,
      name: name || `${dbType}@${params.host || params.filename || 'localhost'}`,
      readonly,
      created_at: Date.now(),
      last_used: Date.now(),
    });
    return id;
  }

  async disconnect(connectionId: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    await conn.driver.disconnect();
    this.connections.delete(connectionId);
  }

  async query(connectionId: string, sql: string, limit = 100, timeoutMs?: number): Promise<QueryResult> {
    const conn = this.getConn(connectionId);
    conn.last_used = Date.now();

    // Enforce readonly at the application level as an extra safeguard
    if (conn.readonly && WRITE_PATTERN.test(sql)) {
      throw new Error('Connection is read-only. Write operations are not allowed.');
    }

    // Apply timeout if specified
    if (timeoutMs && timeoutMs > 0) {
      return Promise.race([
        conn.driver.query(sql, limit),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Query timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
    }

    return conn.driver.query(sql, limit);
  }

  async getTables(connectionId: string): Promise<TableInfo[]> {
    const conn = this.getConn(connectionId);
    conn.last_used = Date.now();
    return conn.driver.getTables();
  }

  async describeTable(connectionId: string, table: string): Promise<SchemaInfo> {
    const conn = this.getConn(connectionId);
    conn.last_used = Date.now();
    return conn.driver.describeTable(table);
  }

  async getDatabases(connectionId: string): Promise<string[]> {
    const conn = this.getConn(connectionId);
    conn.last_used = Date.now();
    if (conn.driver.getDatabases) return conn.driver.getDatabases();
    return [];
  }

  getActiveConnections(): Array<{ id: string; name: string; db_type: DbType; connected: boolean; readonly: boolean }> {
    return [...this.connections.values()].map(c => ({
      id: c.id,
      name: c.name,
      db_type: c.db_type,
      connected: c.driver.isConnected(),
      readonly: c.readonly,
    }));
  }

  private getDefaultPort(dbType: DbType): number {
    const ports: Partial<Record<DbType, number>> = {
      postgresql: 5432, cockroachdb: 26257, mysql: 3306, mariadb: 3306,
      redis: 6379, mongodb: 27017, elasticsearch: 9200, opensearch: 9200,
      clickhouse: 8123, neo4j: 7687, influxdb: 8086, cassandra: 9042,
      scylladb: 9042, memcached: 11211,
    };
    return ports[dbType] || 5432;
  }

  private getConn(id: string): ManagedConnection {
    const conn = this.connections.get(id);
    if (!conn) throw new Error('Connection not found');
    if (!conn.driver.isConnected()) throw new Error('Connection is closed');
    return conn;
  }

  private async cleanupIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, conn] of this.connections) {
      if (now - conn.last_used > IDLE_TIMEOUT_MS) {
        try { await conn.driver.disconnect(); } catch {}
        this.connections.delete(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupInterval);
    for (const conn of this.connections.values()) {
      try { await conn.driver.disconnect(); } catch {}
    }
    this.connections.clear();
  }
}

export const connectionManager = new ConnectionManager();
