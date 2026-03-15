import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { connectionManager } from '../database/connection-manager.js';
import { discoverLocalFiles } from '../database/discovery/local-files.js';
import { discoverContainerDatabases, parseComposeFile } from '../database/discovery/container.js';
import { discoverFromEnvFiles } from '../database/discovery/env-parser.js';
import { scanLocalPorts } from '../database/discovery/port-scan.js';
import { db } from '../state/db.js';
import { obfuscate, deobfuscate } from '../services/obfuscation.js';
import type { DbType, ConnectionParams, DiscoveredDatabase } from '../database/types.js';

/** Obfuscate sensitive fields before persisting */
function obfuscateParams(params: ConnectionParams): ConnectionParams {
  const p = { ...params };
  if (p.password) p.password = obfuscate(p.password);
  if (p.connection_string) p.connection_string = obfuscate(p.connection_string);
  return p;
}

/** Deobfuscate sensitive fields after loading from DB */
function deobfuscateParams(params: ConnectionParams): ConnectionParams {
  const p = { ...params };
  if (p.password) try { p.password = deobfuscate(p.password); } catch {}
  if (p.connection_string) try { p.connection_string = deobfuscate(p.connection_string); } catch {}
  return p;
}

export const databasesRouter = Router();

// --- Discovery ---

let discoveryCache: { result: DiscoveredDatabase[]; time: number } | null = null;
const DISCOVERY_CACHE_TTL = 15_000;

/** Invalidate discovery cache so next request re-scans */
function invalidateDiscoveryCache() {
  discoveryCache = null;
}

// --- Container event hooks ---
// Watch for docker/podman container start/stop to auto-invalidate discovery cache.

function startContainerWatcher() {
  for (const runtime of ['docker', 'podman'] as const) {
    try {
      const child = spawn(runtime, ['events', '--filter', 'type=container', '--filter', 'event=start', '--filter', 'event=stop', '--filter', 'event=die', '--format', '{{.Status}}'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout?.on('data', () => {
        // Any container start/stop/die event invalidates cache
        invalidateDiscoveryCache();
      });
      child.on('error', () => {}); // runtime not installed, ignore
      child.unref(); // Don't prevent process exit
    } catch {}
  }
}

// Start watching container events in background
startContainerWatcher();

async function runDiscovery(projectDir?: string): Promise<DiscoveredDatabase[]> {
  const now = Date.now();
  if (discoveryCache && now - discoveryCache.time < DISCOVERY_CACHE_TTL) {
    return discoveryCache.result;
  }

  const [localFiles, containerDbs, composeDbs, envDbs] = await Promise.all([
    Promise.resolve(projectDir ? discoverLocalFiles(projectDir) : []),
    discoverContainerDatabases(),
    Promise.resolve(projectDir ? parseComposeFile(projectDir) : []),
    Promise.resolve(projectDir ? discoverFromEnvFiles(projectDir) : []),
  ]);

  // Deduplicate compose vs running containers
  const seen = new Set(containerDbs.map(d => `${d.db_type}:${d.params.port}`));
  const uniqueCompose = composeDbs.filter(d => !seen.has(`${d.db_type}:${d.params.port}`));
  // Deduplicate env discoveries vs already-found
  for (const d of [...containerDbs, ...uniqueCompose]) seen.add(`${d.db_type}:${d.params.port}`);
  const uniqueEnv = envDbs.filter(d => !d.params.port || !seen.has(`${d.db_type}:${d.params.port}`));

  // Collect ports already found to exclude from port scanning
  const knownPorts = new Set<number>();
  for (const d of [...localFiles, ...containerDbs, ...uniqueCompose, ...uniqueEnv]) {
    if (d.params.port) knownPorts.add(d.params.port);
  }

  // Port scan as fallback
  const portResults = await scanLocalPorts(knownPorts);

  const result = [...localFiles, ...containerDbs, ...uniqueCompose, ...uniqueEnv, ...portResults];
  discoveryCache = { result, time: now };
  return result;
}

databasesRouter.get('/api/databases/discover', async (req: Request, res: Response) => {
  try {
    const projectDir = req.query.project_dir as string | undefined;
    const discovered = await runDiscovery(projectDir);
    const savedConnections = db.getSavedDbConnections().map(c => ({
      ...c,
      params: deobfuscateParams(c.params),
    }));
    // Strip passwords from the response — frontend doesn't need them for display
    const safeSaved = savedConnections.map(c => ({
      id: c.id, name: c.name, db_type: c.db_type,
      params: { ...c.params, password: c.params.password ? '••••' : undefined, connection_string: undefined },
    }));
    res.json({
      discovered,
      connections: connectionManager.getActiveConnections(),
      saved: safeSaved,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Connection management ---

databasesRouter.post('/api/databases/connect', async (req: Request, res: Response) => {
  try {
    const { db_type, connection, name, save } = req.body as {
      db_type: DbType;
      connection: ConnectionParams;
      name?: string;
      save?: boolean;
    };
    if (!db_type) return res.status(400).json({ error: 'db_type is required' });
    if (!connection) return res.status(400).json({ error: 'connection params are required' });

    const connectionId = await connectionManager.connect(db_type, connection, name);

    // Save to persistent storage if requested or always for manual connections
    if (save !== false) {
      const connName = name || `${db_type}@${connection.host || connection.filename || 'localhost'}`;
      db.saveDbConnection(connectionId, connName, db_type, obfuscateParams(connection));
    }
    db.touchDbConnection(connectionId);

    res.json({ connection_id: connectionId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

databasesRouter.post('/api/databases/disconnect', async (req: Request, res: Response) => {
  try {
    const { connection_id } = req.body;
    if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
    await connectionManager.disconnect(connection_id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Reconnect a saved connection
databasesRouter.post('/api/databases/reconnect', async (req: Request, res: Response) => {
  try {
    const { saved_id } = req.body;
    if (!saved_id) return res.status(400).json({ error: 'saved_id is required' });
    const saved = db.getSavedDbConnections().find(c => c.id === saved_id);
    if (!saved) return res.status(404).json({ error: 'Saved connection not found' });

    const connectionId = await connectionManager.connect(saved.db_type as DbType, deobfuscateParams(saved.params), saved.name);
    db.touchDbConnection(saved_id);
    res.json({ connection_id: connectionId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a saved connection
databasesRouter.delete('/api/databases/saved/:id', async (req: Request, res: Response) => {
  try {
    db.deleteDbConnection(req.params.id as string);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

databasesRouter.get('/api/databases/connections', (_req: Request, res: Response) => {
  res.json(connectionManager.getActiveConnections());
});

// --- Query & Schema ---

databasesRouter.post('/api/databases/query', async (req: Request, res: Response) => {
  try {
    const { connection_id, query, limit, timeout_ms } = req.body;
    if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
    if (!query) return res.status(400).json({ error: 'query is required' });
    const result = await connectionManager.query(connection_id, query, limit || 100, timeout_ms);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Update a single cell value (for inline editing)
databasesRouter.post('/api/databases/update-cell', async (req: Request, res: Response) => {
  try {
    const { connection_id, table, primary_key, column, value } = req.body;
    if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
    if (!table) return res.status(400).json({ error: 'table is required' });
    if (!primary_key || typeof primary_key !== 'object') return res.status(400).json({ error: 'primary_key object is required (e.g. {"id": 1})' });
    if (!column) return res.status(400).json({ error: 'column is required' });

    // Build WHERE clause from primary key
    const pkEntries = Object.entries(primary_key);
    if (pkEntries.length === 0) return res.status(400).json({ error: 'primary_key must have at least one field' });

    const whereClause = pkEntries.map(([k], i) => `"${k}" = $${i + 2}`).join(' AND ');
    const sql = `UPDATE "${table}" SET "${column}" = $1 WHERE ${whereClause}`;
    const params = [value, ...pkEntries.map(([, v]) => v)];

    // Use raw query with parameterized values — for now use a simple approach
    // since our driver interface only supports string queries
    const escapedValue = value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
    const escapedWhere = pkEntries.map(([k, v]) => {
      const ev = v === null ? 'IS NULL' : typeof v === 'number' ? `= ${v}` : `= '${String(v).replace(/'/g, "''")}'`;
      return `"${k}" ${ev}`;
    }).join(' AND ');
    const rawSql = `UPDATE "${table}" SET "${column}" = ${escapedValue} WHERE ${escapedWhere}`;

    const result = await connectionManager.query(connection_id, rawSql, 1);
    res.json({ ok: true, affected: result.row_count });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

databasesRouter.get('/api/databases/:connectionId/tables', async (req: Request, res: Response) => {
  try {
    const tables = await connectionManager.getTables(req.params.connectionId as string);
    res.json(tables);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

databasesRouter.get('/api/databases/:connectionId/tables/:table', async (req: Request, res: Response) => {
  try {
    const schema = await connectionManager.describeTable(req.params.connectionId as string, req.params.table as string);
    res.json(schema);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

databasesRouter.get('/api/databases/:connectionId/databases', async (req: Request, res: Response) => {
  try {
    const databases = await connectionManager.getDatabases(req.params.connectionId as string);
    res.json(databases);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- MCP endpoint (called by MCP server process) ---
// NOTE: This is exported separately and registered in server.ts BEFORE the auth
// middleware, alongside other /api/mcp/* routes. It must NOT be on databasesRouter
// because that router is mounted after requireAuth.

export async function handleMcpConnectDatabase(req: Request, res: Response) {
  try {
    const { action, db_type, connection, query, table, connection_id, options } = req.body;
    const limit = options?.limit || 100;
    const timeoutMs = options?.timeout_ms || 30000;
    const readonly = options?.readonly !== false; // default true

    switch (action) {
      case 'connect': {
        if (!db_type) return res.status(400).json({ error: 'db_type is required for connect' });
        const id = await connectionManager.connect(db_type, connection || {}, undefined, readonly);
        const tables = await connectionManager.getTables(id);
        res.json({ connection_id: id, tables, message: `Connected to ${db_type} (${readonly ? 'read-only' : 'read-write'}). ${tables.length} tables found.` });
        break;
      }
      case 'disconnect': {
        if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
        await connectionManager.disconnect(connection_id);
        res.json({ message: 'Disconnected' });
        break;
      }
      case 'query': {
        if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
        if (!query) return res.status(400).json({ error: 'query is required' });
        const result = await connectionManager.query(connection_id, query, limit, timeoutMs);
        res.json(result);
        break;
      }
      case 'tables': {
        if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
        const tables = await connectionManager.getTables(connection_id);
        res.json({ tables });
        break;
      }
      case 'describe': {
        if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
        if (!table) return res.status(400).json({ error: 'table is required' });
        const schema = await connectionManager.describeTable(connection_id, table);
        res.json(schema);
        break;
      }
      case 'schema': {
        if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
        const allTables = await connectionManager.getTables(connection_id);
        const schemas = [];
        for (const t of allTables.slice(0, 50)) {
          try {
            const s = await connectionManager.describeTable(connection_id, t.name);
            schemas.push(s);
          } catch {}
        }
        res.json({ tables: allTables, schemas });
        break;
      }
      default:
        res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
