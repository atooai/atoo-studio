import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

const STORE_DIR = path.join(os.homedir(), '.ccproxy');
const DB_PATH = path.join(STORE_DIR, 'vcc.db');
const OLD_PROJECTS_FILE = path.join(STORE_DIR, 'projects.json');

export interface VccEnvironment {
  id: string;
  name: string;
  created_at: string;
  project_count?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: string;
  isGit?: boolean;
  ssh_connection_id?: string;
  remote_path?: string;
  parent_project_id?: string | null;
}

export interface SshConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'privatekey' | 'systemkey';
  password_obfuscated?: string;
  private_key_obfuscated?: string;
  passphrase_obfuscated?: string;
  system_key_path?: string;
  created_at: string;
}

export interface EnvironmentSettings {
  environment_id: string;
  sidebar_width: string;
  sidebar_collapsed: number;
}

export interface ProjectSettings {
  [key: string]: any;
}

class VccDatabase {
  private db: Database.Database;

  constructor() {
    if (!fs.existsSync(STORE_DIR)) {
      fs.mkdirSync(STORE_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.initSchema();
    this.migrateProjectsSshColumns();
    this.migrateProjectsParentColumn();
    this.migrate();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vcc_environments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS project_environment (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL REFERENCES vcc_environments(id) ON DELETE CASCADE,
        linked_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (project_id, environment_id)
      );

      CREATE TABLE IF NOT EXISTS environment_settings (
        environment_id TEXT PRIMARY KEY REFERENCES vcc_environments(id) ON DELETE CASCADE,
        sidebar_width TEXT DEFAULT '260px',
        sidebar_collapsed INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS project_settings (
        pe_id TEXT PRIMARY KEY REFERENCES project_environment(id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ssh_connections (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        password_obfuscated TEXT,
        private_key_obfuscated TEXT,
        passphrase_obfuscated TEXT,
        system_key_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private migrate(): void {
    // Migrate project_environment schema: add `id` column if missing
    this.migrateProjectEnvironmentSchema();

    // Migrate from projects.json if it exists and DB is empty
    if (!fs.existsSync(OLD_PROJECTS_FILE)) return;

    const envCount = this.db.prepare('SELECT COUNT(*) as cnt FROM vcc_environments').get() as any;
    if (envCount.cnt > 0) return;

    console.log('[db] Migrating from projects.json...');
    try {
      const data = JSON.parse(fs.readFileSync(OLD_PROJECTS_FILE, 'utf-8'));
      const projects: any[] = Array.isArray(data) ? data : [];

      if (projects.length === 0) return;

      const envId = uuidv4();
      const txn = this.db.transaction(() => {
        // Create "Default" environment
        this.db.prepare('INSERT INTO vcc_environments (id, name) VALUES (?, ?)').run(envId, 'Default');
        this.db.prepare('INSERT INTO environment_settings (environment_id) VALUES (?)').run(envId);

        // Import projects
        for (const p of projects) {
          const projectId = p.id || uuidv4();
          const peId = uuidv4();
          this.db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)')
            .run(projectId, p.name, p.path, p.createdAt || new Date().toISOString());
          this.db.prepare('INSERT INTO project_environment (id, project_id, environment_id) VALUES (?, ?, ?)')
            .run(peId, projectId, envId);
        }
      });
      txn();

      // Rename old file
      fs.renameSync(OLD_PROJECTS_FILE, OLD_PROJECTS_FILE + '.bak');
      console.log(`[db] Migrated ${projects.length} projects into "Default" environment`);
    } catch (err) {
      console.error('[db] Migration failed:', err);
    }
  }

  private migrateProjectsSshColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as any[];
    const hasSshCol = columns.some((c: any) => c.name === 'ssh_connection_id');
    if (hasSshCol || columns.length === 0) return;
    this.db.exec(`
      ALTER TABLE projects ADD COLUMN ssh_connection_id TEXT REFERENCES ssh_connections(id);
      ALTER TABLE projects ADD COLUMN remote_path TEXT;
    `);
    console.log('[db] Added ssh_connection_id and remote_path columns to projects');
  }

  private migrateProjectsParentColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as any[];
    const hasParentCol = columns.some((c: any) => c.name === 'parent_project_id');
    if (hasParentCol || columns.length === 0) return;
    this.db.exec(`
      ALTER TABLE projects ADD COLUMN parent_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
    `);
    console.log('[db] Added parent_project_id column to projects');
  }

  private migrateProjectEnvironmentSchema(): void {
    // Check if project_environment table has an `id` column
    const columns = this.db.prepare("PRAGMA table_info(project_environment)").all() as any[];
    const hasId = columns.some((c: any) => c.name === 'id');
    if (hasId || columns.length === 0) return; // Already migrated or table doesn't exist yet

    console.log('[db] Migrating project_environment schema to add id column...');
    const txn = this.db.transaction(() => {
      // Read existing PE rows
      const peRows = this.db.prepare('SELECT project_id, environment_id, linked_at FROM project_environment').all() as any[];

      // Read existing project_settings rows (old composite key schema)
      let psRows: any[] = [];
      try {
        const psColumns = this.db.prepare("PRAGMA table_info(project_settings)").all() as any[];
        const hasProjectId = psColumns.some((c: any) => c.name === 'project_id');
        if (hasProjectId) {
          psRows = this.db.prepare('SELECT project_id, environment_id, settings_json, updated_at FROM project_settings').all() as any[];
        }
      } catch {}

      // Drop old tables
      this.db.exec('DROP TABLE IF EXISTS project_settings');
      this.db.exec('DROP TABLE IF EXISTS project_environment');

      // Recreate with new schema
      this.db.exec(`
        CREATE TABLE project_environment (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          environment_id TEXT NOT NULL REFERENCES vcc_environments(id) ON DELETE CASCADE,
          linked_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (project_id, environment_id)
        );
        CREATE TABLE project_settings (
          pe_id TEXT PRIMARY KEY REFERENCES project_environment(id) ON DELETE CASCADE,
          settings_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Re-insert PE rows with generated UUIDs, map old composite key to new ID
      const keyToId = new Map<string, string>();
      for (const row of peRows) {
        const peId = uuidv4();
        keyToId.set(`${row.project_id}/${row.environment_id}`, peId);
        this.db.prepare('INSERT INTO project_environment (id, project_id, environment_id, linked_at) VALUES (?, ?, ?, ?)')
          .run(peId, row.project_id, row.environment_id, row.linked_at);
      }

      // Migrate project_settings to use pe_id
      for (const ps of psRows) {
        const peId = keyToId.get(`${ps.project_id}/${ps.environment_id}`);
        if (peId) {
          this.db.prepare('INSERT INTO project_settings (pe_id, settings_json, updated_at) VALUES (?, ?, ?)')
            .run(peId, ps.settings_json, ps.updated_at);
        }
      }

      console.log(`[db] Migrated ${peRows.length} project_environment rows, ${psRows.length} project_settings rows`);
    });
    txn();
  }

  // ═══════════════════════════════════════════════════
  // ENVIRONMENTS
  // ═══════════════════════════════════════════════════

  listEnvironments(): VccEnvironment[] {
    return this.db.prepare(`
      SELECT e.id, e.name, e.created_at,
        (SELECT COUNT(*) FROM project_environment pe WHERE pe.environment_id = e.id) as project_count
      FROM vcc_environments e
      ORDER BY e.created_at
    `).all() as VccEnvironment[];
  }

  getEnvironment(id: string): VccEnvironment | undefined {
    return this.db.prepare(`
      SELECT e.id, e.name, e.created_at,
        (SELECT COUNT(*) FROM project_environment pe WHERE pe.environment_id = e.id) as project_count
      FROM vcc_environments e WHERE e.id = ?
    `).get(id) as VccEnvironment | undefined;
  }

  createEnvironment(name: string): VccEnvironment {
    const id = uuidv4();
    this.db.prepare('INSERT INTO vcc_environments (id, name) VALUES (?, ?)').run(id, name);
    this.db.prepare('INSERT INTO environment_settings (environment_id) VALUES (?)').run(id);
    return this.getEnvironment(id)!;
  }

  deleteEnvironment(id: string): boolean {
    const result = this.db.prepare('DELETE FROM vcc_environments WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ═══════════════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════════════

  getProject(id: string): Project | undefined {
    return this.db.prepare('SELECT id, name, path, created_at, ssh_connection_id, remote_path, parent_project_id FROM projects WHERE id = ?')
      .get(id) as Project | undefined;
  }

  listAllProjects(): Project[] {
    return this.db.prepare('SELECT id, name, path, created_at, ssh_connection_id, remote_path, parent_project_id FROM projects ORDER BY created_at')
      .all() as Project[];
  }

  createProject(name: string, projectPath: string, opts?: { sshConnectionId?: string; remotePath?: string; parentProjectId?: string }): Project {
    const id = uuidv4();
    const resolved = opts?.sshConnectionId ? projectPath : path.resolve(projectPath);
    this.db.prepare('INSERT INTO projects (id, name, path, ssh_connection_id, remote_path, parent_project_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, resolved, opts?.sshConnectionId || null, opts?.remotePath || null, opts?.parentProjectId || null);
    return this.getProject(id)!;
  }

  deleteProject(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getChildProjects(parentId: string): Project[] {
    return this.db.prepare('SELECT id, name, path, created_at, ssh_connection_id, remote_path, parent_project_id FROM projects WHERE parent_project_id = ? ORDER BY created_at')
      .all(parentId) as Project[];
  }

  findProjectByPath(projectPath: string): Project | undefined {
    return this.db.prepare('SELECT id, name, path, created_at, ssh_connection_id, remote_path, parent_project_id FROM projects WHERE path = ?')
      .get(projectPath) as Project | undefined;
  }

  // ═══════════════════════════════════════════════════
  // N:N LINKING
  // ═══════════════════════════════════════════════════

  getProjectsForEnvironment(envId: string): (Project & { pe_id: string })[] {
    return this.db.prepare(`
      SELECT p.id, p.name, p.path, p.created_at, p.ssh_connection_id, p.remote_path, p.parent_project_id, pe.id as pe_id
      FROM projects p
      JOIN project_environment pe ON pe.project_id = p.id
      WHERE pe.environment_id = ?
      ORDER BY pe.linked_at
    `).all(envId) as (Project & { pe_id: string })[];
  }

  getEnvironmentsForProject(projectId: string): VccEnvironment[] {
    return this.db.prepare(`
      SELECT e.id, e.name, e.created_at
      FROM vcc_environments e
      JOIN project_environment pe ON pe.environment_id = e.id
      WHERE pe.project_id = ?
    `).all(projectId) as VccEnvironment[];
  }

  linkProject(projectId: string, envId: string): string {
    const existing = this.db.prepare(
      'SELECT id FROM project_environment WHERE project_id = ? AND environment_id = ?'
    ).get(projectId, envId) as { id: string } | undefined;
    if (existing) return existing.id;

    const peId = uuidv4();
    this.db.prepare(
      'INSERT INTO project_environment (id, project_id, environment_id) VALUES (?, ?, ?)'
    ).run(peId, projectId, envId);

    // Also link child projects (worktrees) to the same environment
    const children = this.getChildProjects(projectId);
    for (const child of children) {
      this.linkProject(child.id, envId);
    }

    return peId;
  }

  unlinkProject(peId: string): void {
    const pe = this.getProjectEnvironment(peId);
    this.db.prepare('DELETE FROM project_environment WHERE id = ?').run(peId);

    // Also unlink child projects from this environment
    if (pe) {
      const children = this.getChildProjects(pe.project_id);
      for (const child of children) {
        const childPe = this.db.prepare(
          'SELECT id FROM project_environment WHERE project_id = ? AND environment_id = ?'
        ).get(child.id, pe.environment_id) as { id: string } | undefined;
        if (childPe) {
          this.unlinkProject(childPe.id);
        }
      }
    }
  }

  getProjectEnvironment(peId: string): { id: string; project_id: string; environment_id: string } | undefined {
    return this.db.prepare(
      'SELECT id, project_id, environment_id FROM project_environment WHERE id = ?'
    ).get(peId) as { id: string; project_id: string; environment_id: string } | undefined;
  }

  // ═══════════════════════════════════════════════════
  // ENVIRONMENT SETTINGS
  // ═══════════════════════════════════════════════════

  getEnvironmentSettings(envId: string): EnvironmentSettings | undefined {
    return this.db.prepare('SELECT * FROM environment_settings WHERE environment_id = ?')
      .get(envId) as EnvironmentSettings | undefined;
  }

  updateEnvironmentSettings(envId: string, partial: Partial<EnvironmentSettings>): void {
    const current = this.getEnvironmentSettings(envId);
    if (!current) return;

    const updates: string[] = [];
    const values: any[] = [];

    if (partial.sidebar_width !== undefined) {
      updates.push('sidebar_width = ?');
      values.push(partial.sidebar_width);
    }
    if (partial.sidebar_collapsed !== undefined) {
      updates.push('sidebar_collapsed = ?');
      values.push(partial.sidebar_collapsed);
    }

    if (updates.length === 0) return;
    values.push(envId);
    this.db.prepare(`UPDATE environment_settings SET ${updates.join(', ')} WHERE environment_id = ?`).run(...values);
  }

  // ═══════════════════════════════════════════════════
  // PROJECT SETTINGS (per env)
  // ═══════════════════════════════════════════════════

  getProjectSettings(peId: string): ProjectSettings {
    const row = this.db.prepare(
      'SELECT settings_json FROM project_settings WHERE pe_id = ?'
    ).get(peId) as { settings_json: string } | undefined;

    if (!row) return {};
    try {
      return JSON.parse(row.settings_json);
    } catch {
      return {};
    }
  }

  updateProjectSettings(peId: string, partial: ProjectSettings): void {
    const current = this.getProjectSettings(peId);
    const merged = { ...current, ...partial };
    const json = JSON.stringify(merged);

    this.db.prepare(`
      INSERT INTO project_settings (pe_id, settings_json, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(pe_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `).run(peId, json);
  }

  // ═══════════════════════════════════════════════════
  // SSH CONNECTIONS
  // ═══════════════════════════════════════════════════

  createSshConnection(config: Omit<SshConnection, 'id' | 'created_at'>): SshConnection {
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO ssh_connections (id, label, host, port, username, auth_method,
        password_obfuscated, private_key_obfuscated, passphrase_obfuscated, system_key_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, config.label, config.host, config.port, config.username, config.auth_method,
      config.password_obfuscated || null, config.private_key_obfuscated || null,
      config.passphrase_obfuscated || null, config.system_key_path || null);
    return this.getSshConnection(id)!;
  }

  getSshConnection(id: string): SshConnection | undefined {
    return this.db.prepare('SELECT * FROM ssh_connections WHERE id = ?')
      .get(id) as SshConnection | undefined;
  }

  listSshConnections(): SshConnection[] {
    return this.db.prepare('SELECT * FROM ssh_connections ORDER BY created_at')
      .all() as SshConnection[];
  }

  deleteSshConnection(id: string): boolean {
    const result = this.db.prepare('DELETE FROM ssh_connections WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ═══════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════

  close(): void {
    try {
      this.db.close();
      console.log('[db] Database closed');
    } catch (err) {
      console.error('[db] Error closing database:', err);
    }
  }
}

export const vccDb = new VccDatabase();
