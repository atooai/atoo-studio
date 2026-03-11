import fs from 'fs';
import path from 'path';
import { getFileTree } from './fs-browser.js';
import * as gitOps from './git-ops.js';
import { store } from '../state/store.js';
import { db } from '../state/db.js';

// Debounce interval for filesystem events (ms)
const DEBOUNCE_MS = 500;

interface WatchEntry {
  watcher: fs.FSWatcher;
  gitWatcher: fs.FSWatcher | null;
  worktreesWatcher: fs.FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  gitDebounceTimer: ReturnType<typeof setTimeout> | null;
  worktreesDebounceTimer: ReturnType<typeof setTimeout> | null;
  projectId: string;
  projectPath: string;
}

const watches = new Map<string, WatchEntry>();

function broadcastToStatus(msg: any) {
  const data = JSON.stringify(msg);
  for (const ws of store.statusClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function handleFileChange(entry: WatchEntry) {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    try {
      const files = getFileTree(entry.projectPath);
      broadcastToStatus({
        type: 'project_files_changed',
        projectId: entry.projectId,
        projectPath: entry.projectPath,
        files,
      });
    } catch (err) {
      console.error(`[project-watcher] Error reading file tree for ${entry.projectId}:`, err);
    }
    // Also refresh git status — working tree changes affect git status
    if (entry.gitWatcher) {
      handleGitChange(entry);
    }
  }, DEBOUNCE_MS);
}

async function handleGitChange(entry: WatchEntry) {
  if (entry.gitDebounceTimer) clearTimeout(entry.gitDebounceTimer);
  entry.gitDebounceTimer = setTimeout(async () => {
    entry.gitDebounceTimer = null;
    try {
      const [status, branches, stashes, remotes] = await Promise.all([
        gitOps.gitStatus(entry.projectPath),
        gitOps.gitBranches(entry.projectPath),
        gitOps.gitStashList(entry.projectPath),
        gitOps.gitRemotes(entry.projectPath),
      ]);
      let commits: any[] = [];
      try {
        commits = await gitOps.gitLog(entry.projectPath, undefined, 30);
      } catch {}

      // Also refresh file tree — git operations (revert, checkout, stash) change working tree
      try {
        const files = getFileTree(entry.projectPath);
        broadcastToStatus({
          type: 'project_files_changed',
          projectId: entry.projectId,
          projectPath: entry.projectPath,
          files,
        });
      } catch {}

      broadcastToStatus({
        type: 'project_git_changed',
        projectId: entry.projectId,
        projectPath: entry.projectPath,
        gitChanges: status,
        gitLog: {
          branches: branches.branches,
          currentBranch: branches.currentBranch,
          remotes,
          commits,
        },
        stashes,
      });
    } catch (err) {
      console.error(`[project-watcher] Error reading git data for ${entry.projectId}:`, err);
    }
  }, DEBOUNCE_MS);
}

// Reconcile worktree-linked projects: read .git/worktrees/ subdirectories and
// ensure each worktree has a corresponding child project in the DB.
function handleWorktreesChange(entry: WatchEntry) {
  if (entry.worktreesDebounceTimer) clearTimeout(entry.worktreesDebounceTimer);
  entry.worktreesDebounceTimer = setTimeout(() => {
    entry.worktreesDebounceTimer = null;
    reconcileWorktrees(entry.projectId, entry.projectPath);
  }, DEBOUNCE_MS);
}

export function reconcileWorktrees(projectId: string, projectPath: string) {
  const worktreesDir = path.join(projectPath, '.git', 'worktrees');
  const discoveredPaths = new Map<string, string>(); // wtPath -> branch

  if (fs.existsSync(worktreesDir)) {
    try {
      const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const wtDir = path.join(worktreesDir, ent.name);
        // Read gitdir to find the worktree path
        const gitdirFile = path.join(wtDir, 'gitdir');
        if (!fs.existsSync(gitdirFile)) continue;
        try {
          const gitdirContent = fs.readFileSync(gitdirFile, 'utf8').trim();
          // gitdir points to <worktree-path>/.git — so the worktree path is the parent
          const wtPath = path.dirname(gitdirContent);
          // Read branch from HEAD
          let branch = ent.name;
          const headFile = path.join(wtDir, 'HEAD');
          if (fs.existsSync(headFile)) {
            const headContent = fs.readFileSync(headFile, 'utf8').trim();
            const match = headContent.match(/^ref: refs\/heads\/(.+)$/);
            if (match) branch = match[1];
          }
          discoveredPaths.set(wtPath, branch);
        } catch {}
      }
    } catch {}
  }

  // Get existing child projects
  const existingChildren = db.getChildProjects(projectId);
  const existingPaths = new Set(existingChildren.map(c => c.path));

  // Get environments this parent is linked to (so we can link new children too)
  const parentEnvs = db.getEnvironmentsForProject(projectId);

  // Record all discovered worktree paths in history (idempotent)
  for (const [wtPath] of discoveredPaths) {
    db.recordWorktreePath(projectId, wtPath);
  }

  // Add new worktrees as child projects
  for (const [wtPath, branch] of discoveredPaths) {
    if (existingPaths.has(wtPath)) continue;
    console.log(`[project-watcher] Discovered new worktree: ${wtPath} (${branch})`);
    const childProject = db.createProject(branch, wtPath, { parentProjectId: projectId });
    // Link to same environments as parent
    for (const env of parentEnvs) {
      db.linkProject(childProject.id, env.id);
    }
    // Start watching the child project
    watchProject(childProject.id, wtPath);
    // Notify frontend
    broadcastToStatus({ type: 'worktrees_changed', parentProjectId: projectId });
  }

  // Remove child projects whose worktree no longer exists
  for (const child of existingChildren) {
    if (!discoveredPaths.has(child.path)) {
      console.log(`[project-watcher] Worktree removed: ${child.path}`);
      unwatchProject(child.id);
      db.deleteProject(child.id);
      broadcastToStatus({ type: 'worktrees_changed', parentProjectId: projectId });
    }
  }
}

function startWorktreesWatcher(entry: WatchEntry): fs.FSWatcher | null {
  const worktreesDir = path.join(entry.projectPath, '.git', 'worktrees');
  if (!fs.existsSync(worktreesDir)) return null;
  try {
    const watcher = fs.watch(worktreesDir, (_eventType, _filename) => {
      const e = watches.get(entry.projectId);
      if (e) handleWorktreesChange(e);
    });
    watcher.on('error', () => {});
    return watcher;
  } catch {
    return null;
  }
}

export function watchProject(projectId: string, projectPath: string) {
  // Already watching
  if (watches.has(projectId)) return;

  try {
    const watcher = fs.watch(projectPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // Skip .git directory changes - handled by git watcher
      if (filename.startsWith('.git' + path.sep) || filename === '.git') return;
      const entry = watches.get(projectId);
      if (entry) handleFileChange(entry);
    });

    let gitWatcher: fs.FSWatcher | null = null;
    const gitPath = path.join(projectPath, '.git');
    if (fs.existsSync(gitPath)) {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        // Normal project with .git directory
        try {
          gitWatcher = fs.watch(gitPath, { recursive: true }, (_eventType, filename) => {
            const entry = watches.get(projectId);
            if (!entry) return;
            handleGitChange(entry);
            // If change is in the worktrees/ subdir or worktrees dir was created/removed, reconcile
            if (filename && (filename === 'worktrees' || filename.startsWith('worktrees' + path.sep))) {
              // Start worktrees watcher if it doesn't exist yet
              if (!entry.worktreesWatcher) {
                entry.worktreesWatcher = startWorktreesWatcher(entry);
              }
              handleWorktreesChange(entry);
            }
          });
          gitWatcher.on('error', () => {});
        } catch {}
      } else if (stat.isFile()) {
        // Worktree project with .git file pointing to main repo
        try {
          const content = fs.readFileSync(gitPath, 'utf8').trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (match) {
            const gitDir = path.resolve(projectPath, match[1]);
            if (fs.existsSync(gitDir)) {
              gitWatcher = fs.watch(gitDir, { recursive: true }, () => {
                const entry = watches.get(projectId);
                if (entry) handleGitChange(entry);
              });
              gitWatcher.on('error', () => {});
            }
          }
        } catch {}
      }
    }

    const entry: WatchEntry = {
      watcher,
      gitWatcher,
      worktreesWatcher: null,
      debounceTimer: null,
      gitDebounceTimer: null,
      worktreesDebounceTimer: null,
      projectId,
      projectPath,
    };
    watches.set(projectId, entry);

    // Start worktrees watcher if .git/worktrees/ already exists
    entry.worktreesWatcher = startWorktreesWatcher(entry);

    // Initial reconciliation of worktrees
    const gitPath2 = path.join(projectPath, '.git');
    if (fs.existsSync(gitPath2) && fs.statSync(gitPath2).isDirectory()) {
      reconcileWorktrees(projectId, projectPath);
    }

    watcher.on('error', () => {
      unwatchProject(projectId);
    });

    console.log(`[project-watcher] Watching ${projectPath} (project ${projectId})`);
  } catch (err) {
    console.error(`[project-watcher] Failed to watch ${projectPath}:`, err);
  }
}

export function unwatchProject(projectId: string) {
  const entry = watches.get(projectId);
  if (!entry) return;

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.gitDebounceTimer) clearTimeout(entry.gitDebounceTimer);
  if (entry.worktreesDebounceTimer) clearTimeout(entry.worktreesDebounceTimer);
  try { entry.watcher.close(); } catch {}
  try { entry.gitWatcher?.close(); } catch {}
  try { entry.worktreesWatcher?.close(); } catch {}
  watches.delete(projectId);
  console.log(`[project-watcher] Stopped watching project ${projectId}`);
}

export function watchEnvironmentProjects(envId: string) {
  const projects = db.getProjectsForEnvironment(envId);
  for (const proj of projects) {
    watchProject(proj.id, proj.path);
  }
}

export function unwatchAll() {
  for (const id of Array.from(watches.keys())) {
    unwatchProject(id);
  }
}

export function isWatching(projectId: string): boolean {
  return watches.has(projectId);
}
