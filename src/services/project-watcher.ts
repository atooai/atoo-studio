import fs from 'fs';
import path from 'path';
import { getFileTree } from './fs-browser.js';
import * as gitOps from './git-ops.js';
import { store } from '../state/store.js';
import { vccDb } from '../state/db.js';

// Debounce interval for filesystem events (ms)
const DEBOUNCE_MS = 500;

interface WatchEntry {
  watcher: fs.FSWatcher;
  gitWatcher: fs.FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  gitDebounceTimer: ReturnType<typeof setTimeout> | null;
  projectId: string;
  projectPath: string;
}

const watches = new Map<string, WatchEntry>(); // projectId → WatchEntry

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
          files,
        });
      } catch {}

      broadcastToStatus({
        type: 'project_git_changed',
        projectId: entry.projectId,
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
    const gitDir = path.join(projectPath, '.git');
    if (fs.existsSync(gitDir)) {
      try {
        gitWatcher = fs.watch(gitDir, { recursive: true }, (_eventType, _filename) => {
          const entry = watches.get(projectId);
          if (entry) handleGitChange(entry);
        });
        gitWatcher.on('error', () => {});
      } catch {
        // .git watch failed, not critical
      }
    }

    const entry: WatchEntry = {
      watcher,
      gitWatcher,
      debounceTimer: null,
      gitDebounceTimer: null,
      projectId,
      projectPath,
    };
    watches.set(projectId, entry);

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
  try { entry.watcher.close(); } catch {}
  try { entry.gitWatcher?.close(); } catch {}
  watches.delete(projectId);
  console.log(`[project-watcher] Stopped watching project ${projectId}`);
}

export function watchEnvironmentProjects(envId: string) {
  const projects = vccDb.getProjectsForEnvironment(envId);
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
