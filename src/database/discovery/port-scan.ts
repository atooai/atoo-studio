import { createConnection } from 'net';
import type { DiscoveredDatabase, DbType } from '../types.js';

const DEFAULT_PORTS: [number, DbType, string][] = [
  [5432, 'postgresql', 'PostgreSQL'],
  [3306, 'mysql', 'MySQL'],
  [6379, 'redis', 'Redis'],
  [27017, 'mongodb', 'MongoDB'],
  [9200, 'elasticsearch', 'Elasticsearch'],
  [8123, 'clickhouse', 'ClickHouse (HTTP)'],
  [7687, 'neo4j', 'Neo4j'],
  [8086, 'influxdb', 'InfluxDB'],
  [9042, 'cassandra', 'Cassandra'],
  [26257, 'cockroachdb', 'CockroachDB'],
  [11211, 'memcached', 'Memcached'],
];

function probePort(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Probe common database ports on localhost.
 * Returns discovered databases for any open port.
 * Excludes ports already found by other discovery methods.
 */
export async function scanLocalPorts(
  excludePorts: Set<number> = new Set(),
): Promise<DiscoveredDatabase[]> {
  const results: DiscoveredDatabase[] = [];

  // Probe all ports in parallel
  const probes = DEFAULT_PORTS
    .filter(([port]) => !excludePorts.has(port))
    .map(async ([port, dbType, label]) => {
      const open = await probePort('127.0.0.1', port);
      if (open) {
        results.push({
          id: `port:${port}`,
          name: `${label} (localhost:${port})`,
          db_type: dbType,
          source: 'manual',
          params: {
            host: 'localhost',
            port,
          },
          source_detail: `Port scan: localhost:${port}`,
        });
      }
    });

  await Promise.all(probes);
  return results;
}
