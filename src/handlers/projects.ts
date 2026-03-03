import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { vccDb } from '../state/db.js';
import { getFileTree, readFileContent } from '../services/fs-browser.js';
import * as gitOps from '../services/git-ops.js';
import { store } from '../state/store.js';

export const projectsRouter = Router();

// ═══════════════════════════════════════════════════
// PROJECT ENDPOINTS
// ═══════════════════════════════════════════════════

// Convenience: list all projects across all environments
projectsRouter.get('/api/projects', (_req, res) => {
  const projects = vccDb.listAllProjects();
  const withGit = projects.map(p => {
    let isGit = false;
    try { isGit = fs.existsSync(path.join(p.path, '.git')); } catch {}
    return { ...p, isGit };
  });
  res.json(withGit);
});

projectsRouter.delete('/api/projects/:id', (req, res) => {
  const deleted = vccDb.deleteProject(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Project not found' });
  res.json({ success: true });
});

// Sessions filtered by project cwd
projectsRouter.get('/api/projects/:id/sessions', (req, res) => {
  const project = vccDb.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sessions = Array.from(store.sessions.values())
    .filter(s => {
      const env = store.environments.get(s.environmentId);
      return env?.directory === project.path;
    })
    .map(s => ({
      id: s.id,
      title: s.title,
      status: s.status,
      agent_status: store.getAgentStatus(s.id),
      created_at: s.createdAt.toISOString(),
      event_count: s.events.length,
    }));

  res.json(sessions);
});

// ═══════════════════════════════════════════════════
// FILE ENDPOINTS
// ═══════════════════════════════════════════════════

projectsRouter.get('/api/projects/:id/files', (req, res) => {
  const project = vccDb.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const tree = getFileTree(project.path);
    res.json(tree);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/files', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'path query parameter required' });

  try {
    const resolved = path.resolve(filePath);
    const { content, lang } = readFileContent(resolved);
    res.json({ content, lang, path: resolved });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

projectsRouter.post('/api/files/rename', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    fs.renameSync(path.resolve(from), path.resolve(to));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/files/create', (req, res) => {
  const { path: filePath, type } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  try {
    const resolved = path.resolve(filePath);
    if (type === 'dir') {
      fs.mkdirSync(resolved, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, '');
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.delete('/api/files', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'path query parameter required' });

  try {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/files/move', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    fs.renameSync(path.resolve(from), path.resolve(to));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// GIT ENDPOINTS (scoped to project cwd)
// ═══════════════════════════════════════════════════

function getProjectCwd(req: any, res: any): string | null {
  const project = vccDb.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return project.path;
}

projectsRouter.get('/api/projects/:id/git/status', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const status = await gitOps.gitStatus(cwd);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/log', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const branch = req.query.branch as string | undefined;
    const count = parseInt(req.query.count as string) || 30;
    const log = await gitOps.gitLog(cwd, branch, count);
    res.json(log);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/commit-files', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const hash = req.query.hash as string;
    if (!hash) return res.status(400).json({ error: 'hash query parameter required' });
    const files = await gitOps.gitCommitFiles(cwd, hash);
    res.json(files);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/branches', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const result = await gitOps.gitBranches(cwd);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/remotes', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const remotes = await gitOps.gitRemotes(cwd);
    res.json(remotes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/stash', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const stashes = await gitOps.gitStashList(cwd);
    res.json(stashes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/diff', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const file = req.query.file as string | undefined;
    const diff = await gitOps.gitDiff(cwd, file);
    res.json({ diff });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/blame', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const file = req.query.file as string;
    if (!file) return res.status(400).json({ error: 'file parameter required' });
    const blame = await gitOps.gitBlame(cwd, file);
    res.json({ blame });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/file-log', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const file = req.query.file as string;
    if (!file) return res.status(400).json({ error: 'file parameter required' });
    const log = await gitOps.gitFileLog(cwd, file);
    res.json(log);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/checkout', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { branch } = req.body;
    if (!branch) return res.status(400).json({ error: 'branch is required' });
    await gitOps.gitCheckout(cwd, branch);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/commit', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    await gitOps.gitCommit(cwd, message);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/push', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    await gitOps.gitPush(cwd);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stash', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    await gitOps.gitStash(cwd);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stash/apply', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    await gitOps.gitStashApply(cwd, id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stash/drop', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    await gitOps.gitStashDrop(cwd, id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/branch', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    await gitOps.gitCreateBranch(cwd, name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/fetch', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    await gitOps.gitFetch(cwd);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/remotes', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    await gitOps.gitAddRemote(cwd, name, url);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.delete('/api/projects/:id/git/remotes/:name', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    await gitOps.gitRemoveRemote(cwd, req.params.name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.put('/api/projects/:id/git/remotes/:name', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    await gitOps.gitEditRemote(cwd, req.params.name, url);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/revert', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { file } = req.body;
    await gitOps.gitRevert(cwd, file);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stage', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file is required' });
    await gitOps.gitStageFile(cwd, file);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
