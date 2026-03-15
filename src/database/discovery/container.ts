import { execFile } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DiscoveredDatabase, DbType, ConnectionParams } from '../types.js';

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  ports: { host: number; container: number }[];
  env: Record<string, string>;
  state: string;
}

const IMAGE_DB_MAP: Record<string, DbType> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  redis: 'redis',
  mongo: 'mongodb',
  mongodb: 'mongodb',
  clickhouse: 'clickhouse',
  neo4j: 'neo4j',
  influxdb: 'influxdb',
  elasticsearch: 'elasticsearch',
  opensearch: 'opensearch',
  cassandra: 'cassandra',
  scylladb: 'scylladb',
  cockroachdb: 'cockroachdb',
  cockroach: 'cockroachdb',
  memcached: 'memcached',
};

const DEFAULT_PORTS: Partial<Record<DbType, number>> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  mongodb: 27017,
  elasticsearch: 9200,
  opensearch: 9200,
  clickhouse: 8123,
  neo4j: 7687,
  influxdb: 8086,
  cassandra: 9042,
  cockroachdb: 26257,
  memcached: 11211,
};

function execCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function detectDbType(image: string): DbType | null {
  const imgLower = image.toLowerCase();
  for (const [keyword, dbType] of Object.entries(IMAGE_DB_MAP)) {
    if (imgLower.includes(keyword)) return dbType;
  }
  return null;
}

function extractCredentials(dbType: DbType, env: Record<string, string>): ConnectionParams {
  const params: ConnectionParams = {};
  switch (dbType) {
    case 'postgresql':
    case 'cockroachdb':
      params.username = env.POSTGRES_USER || 'postgres';
      params.password = env.POSTGRES_PASSWORD || '';
      params.database = env.POSTGRES_DB || env.POSTGRES_USER || 'postgres';
      break;
    case 'mysql':
    case 'mariadb':
      params.username = env.MYSQL_USER || 'root';
      params.password = env.MYSQL_ROOT_PASSWORD || env.MYSQL_PASSWORD || '';
      params.database = env.MYSQL_DATABASE;
      break;
    case 'mongodb':
      params.username = env.MONGO_INITDB_ROOT_USERNAME;
      params.password = env.MONGO_INITDB_ROOT_PASSWORD;
      params.database = env.MONGO_INITDB_DATABASE || 'test';
      break;
    case 'redis':
      params.password = env.REDIS_PASSWORD;
      break;
  }
  return params;
}

async function getDockerContainers(runtime: 'docker' | 'podman'): Promise<ContainerInfo[]> {
  try {
    const out = await execCmd(runtime, ['ps', '--format', '{{.ID}}']);
    const ids = out.trim().split('\n').filter(Boolean);
    if (!ids.length) return [];

    const inspectOut = await execCmd(runtime, ['inspect', ...ids]);
    const data = JSON.parse(inspectOut);

    return data.map((c: any) => {
      const ports: { host: number; container: number }[] = [];
      const portBindings = c.HostConfig?.PortBindings || c.NetworkSettings?.Ports || {};
      for (const [containerPort, bindings] of Object.entries(portBindings)) {
        const cp = parseInt(containerPort);
        if (bindings && Array.isArray(bindings)) {
          for (const b of bindings as any[]) {
            if (b.HostPort) ports.push({ host: parseInt(b.HostPort), container: cp });
          }
        }
      }

      const env: Record<string, string> = {};
      for (const e of (c.Config?.Env || [])) {
        const eq = e.indexOf('=');
        if (eq > 0) env[e.substring(0, eq)] = e.substring(eq + 1);
      }

      return {
        id: c.Id?.substring(0, 12) || '',
        name: (c.Name || '').replace(/^\//, ''),
        image: c.Config?.Image || '',
        ports,
        env,
        state: c.State?.Status || c.State?.Running ? 'running' : 'stopped',
      };
    });
  } catch {
    return [];
  }
}

export async function discoverContainerDatabases(): Promise<DiscoveredDatabase[]> {
  const results: DiscoveredDatabase[] = [];

  for (const runtime of ['docker', 'podman'] as const) {
    let containers: ContainerInfo[];
    try {
      containers = await getDockerContainers(runtime);
    } catch {
      continue;
    }

    for (const container of containers) {
      if (container.state !== 'running') continue;
      const dbType = detectDbType(container.image);
      if (!dbType) continue;

      const defaultPort = DEFAULT_PORTS[dbType];
      const portMapping = container.ports.find(p => p.container === defaultPort);
      const hostPort = portMapping?.host || defaultPort;

      const creds = extractCredentials(dbType, container.env);

      results.push({
        id: `container:${runtime}:${container.id}`,
        name: `${container.name} (${dbType})`,
        db_type: dbType,
        source: 'container',
        params: {
          host: 'localhost',
          port: hostPort,
          ...creds,
        },
        source_detail: `${runtime}: ${container.name} [${container.image}]`,
      });
    }
  }

  return results;
}

/**
 * Parse docker-compose.yml for database services (without running containers).
 */
export function parseComposeFile(projectDir: string): DiscoveredDatabase[] {
  const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  let composePath: string | null = null;
  for (const name of candidates) {
    const p = join(projectDir, name);
    if (existsSync(p)) { composePath = p; break; }
  }
  if (!composePath) return [];

  try {
    const content = readFileSync(composePath, 'utf-8');
    const results: DiscoveredDatabase[] = [];

    // Simple YAML parsing for services with known DB images
    // We use regex since we don't want to add a YAML parser dependency
    const serviceRegex = /^\s{2}(\w[\w-]*)\s*:/gm;
    let match;
    while ((match = serviceRegex.exec(content)) !== null) {
      const serviceName = match[1];
      const serviceStart = match.index;
      // Find the next service or end
      const nextService = content.indexOf('\n  ', serviceStart + match[0].length + 1);
      const serviceBlock = content.substring(serviceStart, nextService > 0 ? nextService : undefined);

      // Extract image
      const imageMatch = serviceBlock.match(/image:\s*["']?([^\s"']+)/);
      if (!imageMatch) continue;

      const dbType = detectDbType(imageMatch[1]);
      if (!dbType) continue;

      // Extract environment variables
      const env: Record<string, string> = {};
      const envBlock = serviceBlock.match(/environment:\s*\n((?:\s{6,}-?\s*.+\n?)*)/);
      if (envBlock) {
        const lines = envBlock[1].split('\n');
        for (const line of lines) {
          const kv = line.trim().replace(/^-\s*/, '').match(/^(\w+)\s*[:=]\s*(.+)/);
          if (kv) env[kv[1]] = kv[2].replace(/["']/g, '').trim();
        }
      }

      // Extract port mappings
      const portMatch = serviceBlock.match(/ports:\s*\n((?:\s+-\s*.+\n?)*)/);
      let hostPort = DEFAULT_PORTS[dbType];
      if (portMatch) {
        const portLine = portMatch[1].match(/["']?(\d+):(\d+)/);
        if (portLine) hostPort = parseInt(portLine[1]);
      }

      const creds = extractCredentials(dbType, env);
      results.push({
        id: `compose:${serviceName}`,
        name: `${serviceName} (${dbType})`,
        db_type: dbType,
        source: 'container',
        params: { host: 'localhost', port: hostPort, ...creds },
        source_detail: `compose: ${serviceName} [${imageMatch[1]}]`,
      });
    }

    return results;
  } catch {
    return [];
  }
}
