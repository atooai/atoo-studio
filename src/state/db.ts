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

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'basic';
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface AuthSession {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  ip_address: string;
  user_agent: string;
}

export interface TotpSecret {
  user_id: string;
  secret_encrypted: string;
  verified: number;
  created_at: string;
}

export interface Passkey {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_name: string | null;
  created_at: string;
}

export interface EnvironmentShare {
  id: string;
  environment_id: string;
  user_id: string;
  shared_by: string;
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
    this.migrateWorktreeHistory();
    this.migrate();
    this.migrateUserManagement();
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

  private migrateWorktreeHistory(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_history (
        id TEXT PRIMARY KEY,
        parent_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (parent_project_id, worktree_path)
      );
    `);
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
  // WORKTREE HISTORY (persists paths after removal)
  // ═══════════════════════════════════════════════════

  /**
   * Record a worktree path for a parent project. Idempotent — skips duplicates.
   */
  recordWorktreePath(parentProjectId: string, worktreePath: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO worktree_history (id, parent_project_id, worktree_path)
      VALUES (?, ?, ?)
    `).run(uuidv4(), parentProjectId, worktreePath);
  }

  /**
   * Get all project paths related to a given path (main project + all worktrees, current and historical).
   * Works bidirectionally: pass a main project path or a worktree path.
   */
  getAllRelatedProjectPaths(projectPath: string): string[] {
    // First, find the project by path
    const project = this.findProjectByPath(projectPath);
    if (!project) {
      // Path might be a historical worktree that's been deleted from projects table
      const hist = this.db.prepare(
        'SELECT parent_project_id FROM worktree_history WHERE worktree_path = ?'
      ).get(projectPath) as { parent_project_id: string } | undefined;
      if (!hist) return [projectPath]; // Unknown path, just return itself

      const parent = this.getProject(hist.parent_project_id);
      if (!parent) return [projectPath];
      return this.collectAllPaths(parent.id, parent.path);
    }

    // If this is a child project (worktree), resolve to parent
    const parentId = project.parent_project_id;
    if (parentId) {
      const parent = this.getProject(parentId);
      if (parent) {
        return this.collectAllPaths(parent.id, parent.path);
      }
    }

    // This is a root project — collect all its paths
    return this.collectAllPaths(project.id, project.path);
  }

  private collectAllPaths(parentProjectId: string, parentPath: string): string[] {
    const paths = new Set<string>();
    paths.add(parentPath);

    // Current child projects (active worktrees)
    const children = this.getChildProjects(parentProjectId);
    for (const child of children) {
      paths.add(child.path);
    }

    // Historical worktree paths (includes removed worktrees)
    const historical = this.db.prepare(
      'SELECT worktree_path FROM worktree_history WHERE parent_project_id = ?'
    ).all(parentProjectId) as { worktree_path: string }[];
    for (const row of historical) {
      paths.add(row.worktree_path);
    }

    return Array.from(paths);
  }

  // ═══════════════════════════════════════════════════
  // USER MANAGEMENT MIGRATION
  // ═══════════════════════════════════════════════════

  private migrateUserManagement(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'basic')),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ip_address TEXT,
        user_agent TEXT
      );

      CREATE TABLE IF NOT EXISTS totp_secrets (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret_encrypted TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        device_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS environment_shares (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES vcc_environments(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shared_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (environment_id, user_id)
      );
    `);

    // Add owner_user_id column to vcc_environments if missing
    const columns = this.db.prepare("PRAGMA table_info(vcc_environments)").all() as any[];
    const hasOwnerCol = columns.some((c: any) => c.name === 'owner_user_id');
    if (!hasOwnerCol && columns.length > 0) {
      this.db.exec('ALTER TABLE vcc_environments ADD COLUMN owner_user_id TEXT REFERENCES users(id)');
      console.log('[db] Added owner_user_id column to vcc_environments');
    }
  }

  // ═══════════════════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════════════════

  getUserCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any).cnt;
  }

  createUser(username: string, displayName: string, role: 'admin' | 'basic', passwordHash: string): User {
    const id = uuidv4();
    this.db.prepare(
      'INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)'
    ).run(id, username, displayName, role, passwordHash);
    return this.getUser(id)!;
  }

  getUser(id: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  getUserByUsername(username: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  }

  listUsers(): User[] {
    return this.db.prepare('SELECT id, username, display_name, role, created_at, updated_at FROM users ORDER BY created_at').all() as User[];
  }

  updateUser(id: string, updates: { display_name?: string; role?: 'admin' | 'basic' }): boolean {
    const parts: string[] = [];
    const values: any[] = [];
    if (updates.display_name !== undefined) { parts.push('display_name = ?'); values.push(updates.display_name); }
    if (updates.role !== undefined) { parts.push('role = ?'); values.push(updates.role); }
    if (parts.length === 0) return false;
    parts.push("updated_at = datetime('now')");
    values.push(id);
    const result = this.db.prepare(`UPDATE users SET ${parts.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  updateUserPassword(id: string, passwordHash: string): boolean {
    const result = this.db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(passwordHash, id);
    return result.changes > 0;
  }

  deleteUser(id: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ═══════════════════════════════════════════════════
  // AUTH SESSIONS
  // ═══════════════════════════════════════════════════

  createAuthSession(id: string, userId: string, expiresAt: string, ip: string, userAgent: string): void {
    this.db.prepare(
      'INSERT INTO auth_sessions (id, user_id, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)'
    ).run(id, userId, expiresAt, ip, userAgent);
  }

  getAuthSessionUser(sessionId: string): User | null {
    const row = this.db.prepare(`
      SELECT u.* FROM users u
      JOIN auth_sessions s ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).get(sessionId) as User | undefined;
    return row || null;
  }

  deleteAuthSession(sessionId: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
  }

  deleteAllUserAuthSessions(userId: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  }

  // ═══════════════════════════════════════════════════
  // TOTP SECRETS
  // ═══════════════════════════════════════════════════

  saveTotpSecret(userId: string, secretEncrypted: string): void {
    this.db.prepare(`
      INSERT INTO totp_secrets (user_id, secret_encrypted, verified)
      VALUES (?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET secret_encrypted = excluded.secret_encrypted, verified = 0
    `).run(userId, secretEncrypted);
  }

  getTotpSecret(userId: string): TotpSecret | null {
    return this.db.prepare('SELECT * FROM totp_secrets WHERE user_id = ?').get(userId) as TotpSecret || null;
  }

  markTotpVerified(userId: string): void {
    this.db.prepare('UPDATE totp_secrets SET verified = 1 WHERE user_id = ?').run(userId);
  }

  deleteTotpSecret(userId: string): void {
    this.db.prepare('DELETE FROM totp_secrets WHERE user_id = ?').run(userId);
  }

  // ═══════════════════════════════════════════════════
  // PASSKEYS
  // ═══════════════════════════════════════════════════

  createPasskey(pk: Omit<Passkey, 'created_at'>): void {
    this.db.prepare(`
      INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pk.id, pk.user_id, pk.credential_id, pk.public_key, pk.counter, pk.transports, pk.device_name);
  }

  listPasskeys(userId: string): Passkey[] {
    return this.db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as Passkey[];
  }

  findPasskeyByCredentialId(credentialId: string): Passkey | null {
    return this.db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId) as Passkey || null;
  }

  updatePasskeyCounter(id: string, counter: number): void {
    this.db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(counter, id);
  }

  deletePasskey(id: string, userId: string): boolean {
    const result = this.db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId);
    return result.changes > 0;
  }

  deleteAllUserPasskeys(userId: string): void {
    this.db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(userId);
  }

  getUserIdsWithPasskeys(): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM passkeys').all() as { user_id: string }[]).map(r => r.user_id);
  }

  // ═══════════════════════════════════════════════════
  // ENVIRONMENT OWNERSHIP & SHARING
  // ═══════════════════════════════════════════════════

  listEnvironmentsForUser(userId: string): VccEnvironment[] {
    return this.db.prepare(`
      SELECT e.id, e.name, e.created_at, e.owner_user_id,
        (SELECT COUNT(*) FROM project_environment pe WHERE pe.environment_id = e.id) as project_count
      FROM vcc_environments e
      WHERE e.owner_user_id = ?
        OR e.id IN (SELECT environment_id FROM environment_shares WHERE user_id = ?)
      ORDER BY e.created_at
    `).all(userId, userId) as VccEnvironment[];
  }

  createEnvironmentWithOwner(name: string, ownerUserId: string): VccEnvironment {
    const id = uuidv4();
    this.db.prepare('INSERT INTO vcc_environments (id, name, owner_user_id) VALUES (?, ?, ?)').run(id, name, ownerUserId);
    this.db.prepare('INSERT INTO environment_settings (environment_id) VALUES (?)').run(id);
    return this.getEnvironment(id)!;
  }

  assignUnownedEnvironments(userId: string): void {
    this.db.prepare('UPDATE vcc_environments SET owner_user_id = ? WHERE owner_user_id IS NULL').run(userId);
  }

  canAccessEnvironment(userId: string, envId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM vcc_environments
      WHERE id = ? AND (owner_user_id = ? OR id IN (SELECT environment_id FROM environment_shares WHERE user_id = ?))
    `).get(envId, userId, userId);
    return !!row;
  }

  canAccessProject(userId: string, projectId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM project_environment pe
      JOIN vcc_environments e ON e.id = pe.environment_id
      WHERE pe.project_id = ?
        AND (e.owner_user_id = ? OR e.id IN (SELECT environment_id FROM environment_shares WHERE user_id = ?))
      LIMIT 1
    `).get(projectId, userId, userId);
    return !!row;
  }

  getEnvironmentOwner(envId: string): string | null {
    const row = this.db.prepare('SELECT owner_user_id FROM vcc_environments WHERE id = ?').get(envId) as { owner_user_id: string | null } | undefined;
    return row?.owner_user_id || null;
  }

  shareEnvironment(envId: string, userId: string, sharedBy: string): void {
    const id = uuidv4();
    this.db.prepare(`
      INSERT OR IGNORE INTO environment_shares (id, environment_id, user_id, shared_by)
      VALUES (?, ?, ?, ?)
    `).run(id, envId, userId, sharedBy);
  }

  unshareEnvironment(envId: string, userId: string): boolean {
    const result = this.db.prepare('DELETE FROM environment_shares WHERE environment_id = ? AND user_id = ?').run(envId, userId);
    return result.changes > 0;
  }

  listEnvironmentShares(envId: string): (EnvironmentShare & { username: string; display_name: string })[] {
    return this.db.prepare(`
      SELECT es.*, u.username, u.display_name
      FROM environment_shares es
      JOIN users u ON u.id = es.user_id
      WHERE es.environment_id = ?
      ORDER BY es.created_at
    `).all(envId) as (EnvironmentShare & { username: string; display_name: string })[];
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
