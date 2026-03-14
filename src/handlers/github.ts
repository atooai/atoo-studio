import { Router } from 'express';
import { db } from '../state/db.js';
import * as githubOps from '../services/github-ops.js';

export const githubRouter = Router();

// Helper: get project cwd for local projects only (gh CLI doesn't work over SSH)
function getProjectCwd(req: any, res: any): string | null {
  const project = db.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  if (project.ssh_connection_id) {
    res.status(400).json({ error: 'GitHub integration not available for remote projects' });
    return null;
  }
  return project.path;
}

// ─── GitHub status (detection + auth) ───

githubRouter.get('/api/projects/:id/github/status', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const status = await githubOps.getGitHubStatus(cwd);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Force-refresh status cache
githubRouter.post('/api/projects/:id/github/status/refresh', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    githubOps.clearStatusCache(cwd);
    const status = await githubOps.getGitHubStatus(cwd);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Issues ───

githubRouter.get('/api/projects/:id/github/issues', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const state = (req.query.state as string) || 'open';
    const search = req.query.search as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const result = await githubOps.listIssues(cwd, { state, search, limit });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Single issue detail (body + comments)
githubRouter.get('/api/projects/:id/github/issues/:number', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const num = parseInt(req.params.number);
    const detail = await githubOps.getIssueDetail(cwd, num);
    res.json(detail);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

githubRouter.post('/api/projects/:id/github/issues/:number/state', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const num = parseInt(req.params.number);
    const action = req.body.action as 'close' | 'reopen';
    if (!action || !['close', 'reopen'].includes(action)) {
      return res.status(400).json({ error: 'action must be "close" or "reopen"' });
    }
    await githubOps.updateIssueState(cwd, num, action);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Pull Requests ───

githubRouter.get('/api/projects/:id/github/pulls', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const state = (req.query.state as string) || 'open';
    const search = req.query.search as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const result = await githubOps.listPulls(cwd, { state, search, limit });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Single PR detail (body + comments)
githubRouter.get('/api/projects/:id/github/pulls/:number', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const num = parseInt(req.params.number);
    const detail = await githubOps.getPullDetail(cwd, num);
    res.json(detail);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

githubRouter.post('/api/projects/:id/github/pulls/:number/state', async (req, res) => {
  const cwd = getProjectCwd(req, res);
  if (!cwd) return;
  try {
    const num = parseInt(req.params.number);
    const action = req.body.action as 'close' | 'reopen';
    if (!action || !['close', 'reopen'].includes(action)) {
      return res.status(400).json({ error: 'action must be "close" or "reopen"' });
    }
    await githubOps.updatePullState(cwd, num, action);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
