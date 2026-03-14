import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { DiscoveredDatabase, DbType, ConnectionParams } from '../types.js';

// ---------------------------------------------------------------------------
// Connection-string parser
// ---------------------------------------------------------------------------

const SCHEME_TO_DB: Record<string, DbType> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mongodb: 'mongodb',
  'mongodb+srv': 'mongodb',
  redis: 'redis',
  rediss: 'redis',
  cockroachdb: 'cockroachdb',
  clickhouse: 'clickhouse',
};

export function parseConnectionString(
  url: string,
): { db_type: DbType; params: ConnectionParams } | null {
  try {
    const match = url.match(/^([a-z+]+):\/\//i);
    if (!match) return null;

    const scheme = match[1].toLowerCase();
    const dbType = SCHEME_TO_DB[scheme];
    if (!dbType) return null;

    // Use URL parser for everything after the scheme
    // Normalise the scheme to 'http' so the built-in URL class works
    const asHttp = url.replace(/^[a-z+]+:\/\//i, 'http://');
    const parsed = new URL(asHttp);

    const params: ConnectionParams = {
      connection_string: url,
    };
    if (parsed.hostname) params.host = decodeURIComponent(parsed.hostname);
    if (parsed.port) params.port = parseInt(parsed.port, 10);
    if (parsed.username) params.username = decodeURIComponent(parsed.username);
    if (parsed.password) params.password = decodeURIComponent(parsed.password);
    // Remove leading slash
    const db = decodeURIComponent(parsed.pathname).replace(/^\//, '');
    if (db) params.database = db;

    return { db_type: dbType, params };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// .env file parser
// ---------------------------------------------------------------------------

/** Known env var names that carry database URLs. */
const URL_VARS: Record<string, DbType | null> = {
  DATABASE_URL: null, // infer from scheme
  REDIS_URL: 'redis',
  MONGODB_URI: 'mongodb',
  MONGO_URL: 'mongodb',
  MYSQL_URL: 'mysql',
  PG_CONNECTION_STRING: 'postgresql',
  POSTGRES_URL: 'postgresql',
};

/** Discrete credential env vars (host/port/user/pass/name). */
const DISCRETE_VARS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
] as const;

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production'];

function parseEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function makeId(): string {
  return randomUUID();
}

function discoverFromSingleEnv(
  projectDir: string,
  envFileName: string,
): DiscoveredDatabase[] {
  const filePath = join(projectDir, envFileName);
  if (!existsSync(filePath)) return [];

  const results: DiscoveredDatabase[] = [];
  const vars = parseEnvFile(filePath);

  // --- URL-style vars ---
  for (const [varName, hintType] of Object.entries(URL_VARS)) {
    const value = vars[varName];
    if (!value) continue;
    const parsed = parseConnectionString(value);
    if (parsed) {
      const dbType = hintType ?? parsed.db_type;
      results.push({
        id: makeId(),
        name: `${dbType}${parsed.params.database ? ':' + parsed.params.database : ''} (${envFileName})`,
        db_type: dbType,
        source: 'manual',
        source_detail: `${envFileName} -> ${varName}`,
        params: parsed.params,
      });
    }
  }

  // --- Discrete vars (DB_HOST etc.) ---
  const dbHost = vars['DB_HOST'];
  if (dbHost) {
    const params: ConnectionParams = {
      host: dbHost,
    };
    if (vars['DB_PORT']) params.port = parseInt(vars['DB_PORT'], 10);
    if (vars['DB_USER']) params.username = vars['DB_USER'];
    if (vars['DB_PASSWORD']) params.password = vars['DB_PASSWORD'];
    if (vars['DB_NAME']) params.database = vars['DB_NAME'];

    // Try to guess the type from the port or default to postgresql
    let dbType: DbType = 'postgresql';
    if (params.port === 3306) dbType = 'mysql';
    else if (params.port === 27017) dbType = 'mongodb';
    else if (params.port === 6379) dbType = 'redis';

    results.push({
      id: makeId(),
      name: `${dbType}${params.database ? ':' + params.database : ''}@${dbHost} (${envFileName})`,
      db_type: dbType,
      source: 'manual',
      source_detail: `${envFileName} -> DB_HOST/DB_PORT/...`,
      params,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Framework config parsers
// ---------------------------------------------------------------------------

function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract URLs from a text blob using a broad regex.
 * Returns all database-like connection strings found.
 */
function extractUrls(text: string): string[] {
  const urlPattern = /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|cockroachdb|clickhouse):\/\/[^\s"'`,;)}\]]+/gi;
  return [...text.matchAll(urlPattern)].map((m) => m[0]);
}

function discoverPrisma(projectDir: string): DiscoveredDatabase[] {
  const schemaPath = join(projectDir, 'prisma', 'schema.prisma');
  const content = readFileIfExists(schemaPath);
  if (!content) return [];

  const results: DiscoveredDatabase[] = [];

  // Look for datasource block
  const datasourceMatch = content.match(
    /datasource\s+\w+\s*\{([\s\S]*?)\}/,
  );
  if (!datasourceMatch) return [];

  const block = datasourceMatch[1];

  // Check for env("SOME_VAR") reference
  const envRef = block.match(/url\s*=\s*env\(\s*"([^"]+)"\s*\)/);
  if (envRef) {
    // The actual URL will be found from .env files; just note the reference.
    // But we still report it so the caller knows Prisma is configured.
    // We don't duplicate if the .env parser already found it.
  }

  // Check for direct URL in url = "..."
  const directUrl = block.match(/url\s*=\s*"([^"]+)"/);
  if (directUrl) {
    const parsed = parseConnectionString(directUrl[1]);
    if (parsed) {
      results.push({
        id: makeId(),
        name: `${parsed.db_type}${parsed.params.database ? ':' + parsed.params.database : ''} (prisma/schema.prisma)`,
        db_type: parsed.db_type,
        source: 'manual',
        source_detail: 'prisma/schema.prisma -> datasource url',
        params: parsed.params,
      });
    }
  }

  return results;
}

function discoverRailsDatabase(projectDir: string): DiscoveredDatabase[] {
  const ymlPath = join(projectDir, 'config', 'database.yml');
  const content = readFileIfExists(ymlPath);
  if (!content) return [];

  const results: DiscoveredDatabase[] = [];

  // Extract URLs from the YAML content
  const urls = extractUrls(content);
  for (const url of urls) {
    const parsed = parseConnectionString(url);
    if (parsed) {
      results.push({
        id: makeId(),
        name: `${parsed.db_type}${parsed.params.database ? ':' + parsed.params.database : ''} (config/database.yml)`,
        db_type: parsed.db_type,
        source: 'manual',
        source_detail: 'config/database.yml',
        params: parsed.params,
      });
    }
  }

  // Look for adapter/host/port/database/username/password via simple regex
  // Match development/production/test sections
  const sections = content.split(/\n(?=\w+:)/);
  for (const section of sections) {
    const sectionName = section.match(/^(\w+):/)?.[1];
    if (!sectionName) continue;

    const adapter = section.match(/adapter:\s*(\S+)/)?.[1];
    const host = section.match(/host:\s*(\S+)/)?.[1];
    const database = section.match(/database:\s*(\S+)/)?.[1];

    if (!adapter && !host) continue;

    let dbType: DbType = 'postgresql';
    if (adapter === 'mysql2' || adapter === 'mysql') dbType = 'mysql';
    else if (adapter === 'sqlite3') dbType = 'sqlite';
    else if (adapter === 'postgresql' || adapter === 'postgres') dbType = 'postgresql';
    else continue; // unknown adapter

    if (dbType === 'sqlite' && database) {
      results.push({
        id: makeId(),
        name: `sqlite:${database} (config/database.yml:${sectionName})`,
        db_type: 'sqlite',
        source: 'manual',
        source_detail: `config/database.yml -> ${sectionName}`,
        params: { filename: database },
      });
      continue;
    }

    if (!host) continue;

    const params: ConnectionParams = { host };
    const port = section.match(/port:\s*(\d+)/)?.[1];
    const username = section.match(/username:\s*(\S+)/)?.[1];
    const password = section.match(/password:\s*(\S+)/)?.[1];
    if (port) params.port = parseInt(port, 10);
    if (username) params.username = username;
    if (password) params.password = password;
    if (database) params.database = database;

    results.push({
      id: makeId(),
      name: `${dbType}${database ? ':' + database : ''}@${host} (config/database.yml:${sectionName})`,
      db_type: dbType,
      source: 'manual',
      source_detail: `config/database.yml -> ${sectionName}`,
      params,
    });
  }

  return results;
}

function discoverKnex(projectDir: string): DiscoveredDatabase[] {
  const results: DiscoveredDatabase[] = [];

  for (const filename of ['knexfile.js', 'knexfile.ts']) {
    const filePath = join(projectDir, filename);
    const content = readFileIfExists(filePath);
    if (!content) continue;

    const urls = extractUrls(content);
    for (const url of urls) {
      const parsed = parseConnectionString(url);
      if (parsed) {
        results.push({
          id: makeId(),
          name: `${parsed.db_type}${parsed.params.database ? ':' + parsed.params.database : ''} (${filename})`,
          db_type: parsed.db_type,
          source: 'manual',
          source_detail: filename,
          params: parsed.params,
        });
      }
    }
  }

  return results;
}

function discoverDjango(projectDir: string): DiscoveredDatabase[] {
  const settingsPath = join(projectDir, 'settings.py');
  const content = readFileIfExists(settingsPath);
  if (!content) return [];

  const results: DiscoveredDatabase[] = [];

  // Extract any connection URLs
  const urls = extractUrls(content);
  for (const url of urls) {
    const parsed = parseConnectionString(url);
    if (parsed) {
      results.push({
        id: makeId(),
        name: `${parsed.db_type}${parsed.params.database ? ':' + parsed.params.database : ''} (settings.py)`,
        db_type: parsed.db_type,
        source: 'manual',
        source_detail: 'settings.py -> DATABASES',
        params: parsed.params,
      });
    }
  }

  // Try to extract ENGINE/HOST/PORT/NAME/USER/PASSWORD from DATABASES config
  const engineMatch = content.match(/'ENGINE'\s*:\s*'([^']+)'/);
  const hostMatch = content.match(/'HOST'\s*:\s*'([^']+)'/);
  const nameMatch = content.match(/'NAME'\s*:\s*'([^']+)'/);

  if (engineMatch) {
    const engine = engineMatch[1];
    let dbType: DbType | null = null;
    if (engine.includes('postgresql') || engine.includes('psycopg'))
      dbType = 'postgresql';
    else if (engine.includes('mysql')) dbType = 'mysql';
    else if (engine.includes('sqlite')) dbType = 'sqlite';

    if (dbType === 'sqlite' && nameMatch) {
      results.push({
        id: makeId(),
        name: `sqlite:${nameMatch[1]} (settings.py)`,
        db_type: 'sqlite',
        source: 'manual',
        source_detail: 'settings.py -> DATABASES',
        params: { filename: nameMatch[1] },
      });
    } else if (dbType && hostMatch) {
      const params: ConnectionParams = { host: hostMatch[1] };
      const portMatch = content.match(/'PORT'\s*:\s*'?(\d+)'?/);
      const userMatch = content.match(/'USER'\s*:\s*'([^']+)'/);
      const passMatch = content.match(/'PASSWORD'\s*:\s*'([^']+)'/);
      if (portMatch) params.port = parseInt(portMatch[1], 10);
      if (userMatch) params.username = userMatch[1];
      if (passMatch) params.password = passMatch[1];
      if (nameMatch) params.database = nameMatch[1];

      results.push({
        id: makeId(),
        name: `${dbType}${nameMatch ? ':' + nameMatch[1] : ''}@${hostMatch[1]} (settings.py)`,
        db_type: dbType,
        source: 'manual',
        source_detail: 'settings.py -> DATABASES',
        params,
      });
    }
  }

  return results;
}

function discoverLaravel(projectDir: string): DiscoveredDatabase[] {
  const phpPath = join(projectDir, 'database.php');
  const configPhpPath = join(projectDir, 'config', 'database.php');
  const content = readFileIfExists(phpPath) ?? readFileIfExists(configPhpPath);
  if (!content) return [];

  const results: DiscoveredDatabase[] = [];
  const sourceName = existsSync(phpPath) ? 'database.php' : 'config/database.php';

  // Extract URLs
  const urls = extractUrls(content);
  for (const url of urls) {
    const parsed = parseConnectionString(url);
    if (parsed) {
      results.push({
        id: makeId(),
        name: `${parsed.db_type}${parsed.params.database ? ':' + parsed.params.database : ''} (${sourceName})`,
        db_type: parsed.db_type,
        source: 'manual',
        source_detail: sourceName,
        params: parsed.params,
      });
    }
  }

  return results;
}

function discoverSequelize(projectDir: string): DiscoveredDatabase[] {
  const results: DiscoveredDatabase[] = [];

  const candidates = [
    join(projectDir, '.sequelizerc'),
    join(projectDir, 'config', 'config.json'),
  ];

  for (const filePath of candidates) {
    const content = readFileIfExists(filePath);
    if (!content) continue;

    const sourceName = filePath.startsWith(join(projectDir, 'config'))
      ? 'config/config.json'
      : '.sequelizerc';

    // Extract URLs
    const urls = extractUrls(content);
    for (const url of urls) {
      const parsed = parseConnectionString(url);
      if (parsed) {
        results.push({
          id: makeId(),
          name: `${parsed.db_type}${parsed.params.database ? ':' + parsed.params.database : ''} (${sourceName})`,
          db_type: parsed.db_type,
          source: 'manual',
          source_detail: sourceName,
          params: parsed.params,
        });
      }
    }

    // For config.json, try to extract host/port/database/username/password/dialect
    if (sourceName === 'config/config.json') {
      try {
        const json = JSON.parse(content);
        for (const env of ['development', 'test', 'production']) {
          const cfg = json[env];
          if (!cfg || typeof cfg !== 'object') continue;

          let dbType: DbType | null = null;
          if (cfg.dialect === 'postgres' || cfg.dialect === 'postgresql')
            dbType = 'postgresql';
          else if (cfg.dialect === 'mysql') dbType = 'mysql';
          else if (cfg.dialect === 'mariadb') dbType = 'mariadb';
          else if (cfg.dialect === 'sqlite') dbType = 'sqlite';
          else continue;

          if (dbType === 'sqlite' && cfg.storage) {
            results.push({
              id: makeId(),
              name: `sqlite:${cfg.storage} (config/config.json:${env})`,
              db_type: 'sqlite',
              source: 'manual',
              source_detail: `config/config.json -> ${env}`,
              params: { filename: cfg.storage },
            });
            continue;
          }

          if (!cfg.host) continue;
          const params: ConnectionParams = { host: cfg.host };
          if (cfg.port) params.port = parseInt(String(cfg.port), 10);
          if (cfg.username) params.username = cfg.username;
          if (cfg.password) params.password = cfg.password;
          if (cfg.database) params.database = cfg.database;

          results.push({
            id: makeId(),
            name: `${dbType}${cfg.database ? ':' + cfg.database : ''}@${cfg.host} (config/config.json:${env})`,
            db_type: dbType,
            source: 'manual',
            source_detail: `config/config.json -> ${env}`,
            params,
          });
        }
      } catch {
        // Not valid JSON; URL extraction above is the fallback
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse .env files and framework config files to discover database credentials.
 */
export function discoverFromEnvFiles(
  projectDir: string,
): DiscoveredDatabase[] {
  if (!projectDir || !existsSync(projectDir)) return [];

  const results: DiscoveredDatabase[] = [];

  // 1. .env files
  for (const envFile of ENV_FILES) {
    results.push(...discoverFromSingleEnv(projectDir, envFile));
  }

  // 2. Framework config files
  results.push(...discoverPrisma(projectDir));
  results.push(...discoverRailsDatabase(projectDir));
  results.push(...discoverKnex(projectDir));
  results.push(...discoverDjango(projectDir));
  results.push(...discoverLaravel(projectDir));
  results.push(...discoverSequelize(projectDir));

  // Deduplicate by connection string when available
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.params.connection_string
      ?? `${r.db_type}://${r.params.host ?? ''}:${r.params.port ?? ''}/${r.params.database ?? r.params.filename ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
