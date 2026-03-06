import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { vccDb } from '../state/db.js';
import { getFileTree, readFileContent, isBinaryFile } from '../services/fs-browser.js';
import mime from 'mime-types';
import { getRemoteFileTree, readRemoteFileContent } from '../services/remote-fs-browser.js';
import * as gitOps from '../services/git-ops.js';
import * as remoteGitOps from '../services/remote-git-ops.js';
import { sshManager } from '../services/ssh-manager.js';
import { store } from '../state/store.js';

export const projectsRouter = Router();

// Helper: get project context (local or remote)
function getProjectContext(projectId: string): { cwd: string; connectionId?: string } | null {
  const project = vccDb.getProject(projectId);
  if (!project) return null;
  if (project.ssh_connection_id) {
    return { cwd: project.remote_path || project.path, connectionId: project.ssh_connection_id };
  }
  return { cwd: project.path };
}

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

// Get environments a project is linked to
projectsRouter.get('/api/projects/:id/environments', (req, res) => {
  const project = vccDb.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const envs = vccDb.getEnvironmentsForProject(req.params.id);
  res.json(envs);
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
    .map(s => {
      const initEvent = s.events.find((e: any) => e.type === 'system' && e.subtype === 'init');
      const ctxUsage = store.contextUsages.get(s.id);
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        agent_status: store.getAgentStatus(s.id),
        created_at: s.createdAt.toISOString(),
        event_count: s.events.length,
        model: initEvent?.model || ctxUsage?.model || null,
        permission_mode: initEvent?.permissionMode || s.permissionMode || null,
      };
    });

  res.json(sessions);
});

// ═══════════════════════════════════════════════════
// FILE ENDPOINTS
// ═══════════════════════════════════════════════════

projectsRouter.get('/api/projects/:id/files', async (req, res) => {
  const ctx = getProjectContext(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Project not found' });

  try {
    const rootPath = (req.query.rootPath as string) || ctx.cwd;
    if (ctx.connectionId) {
      const tree = await getRemoteFileTree(ctx.connectionId, rootPath);
      res.json(tree);
    } else {
      const tree = getFileTree(rootPath);
      res.json(tree);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/files', async (req, res) => {
  const filePath = req.query.path as string;
  const connId = req.query.ssh_connection_id as string;
  if (!filePath) return res.status(400).json({ error: 'path query parameter required' });

  try {
    if (connId) {
      const { content, lang } = await readRemoteFileContent(connId, filePath);
      res.json({ content, lang, path: filePath });
    } else {
      const resolved = path.resolve(filePath);
      const result = readFileContent(resolved);
      res.json({ content: result.content, lang: result.lang, path: resolved, isBinary: result.isBinary, size: result.size });
    }
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Serve raw file bytes (for images, hex view, etc.)
projectsRouter.get('/api/files/raw', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'not found' });
    const stat = fs.statSync(resolved);

    // For hex view: support range requests for chunked loading
    const offset = parseInt(req.query.offset as string) || 0;
    const length = parseInt(req.query.length as string) || 0;
    if (length > 0) {
      // Return a chunk as base64 for hex viewer
      const fd = fs.openSync(resolved, 'r');
      const buf = Buffer.alloc(Math.min(length, 1024 * 1024)); // cap at 1MB per chunk
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      return res.json({ data: buf.subarray(0, bytesRead).toString('base64'), size: stat.size, bytesRead });
    }

    // Stream full file with correct content type
    const ct = mime.lookup(resolved) || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(resolved).pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.put('/api/files', async (req, res) => {
  const { path: filePath, content, ssh_connection_id } = req.body;
  if (!filePath || typeof content !== 'string') {
    return res.status(400).json({ error: 'path and content are required' });
  }
  try {
    if (ssh_connection_id) {
      await sshManager.sftpWriteFile(ssh_connection_id, filePath, content);
      res.json({ success: true, path: filePath });
    } else {
      const resolved = path.resolve(filePath);
      fs.writeFileSync(resolved, content, 'utf-8');
      res.json({ success: true, path: resolved });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/files/rename', async (req, res) => {
  const { from, to, ssh_connection_id } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    if (ssh_connection_id) {
      await sshManager.sftpRename(ssh_connection_id, from, to);
    } else {
      fs.renameSync(path.resolve(from), path.resolve(to));
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/files/create', async (req, res) => {
  const { path: filePath, type, ssh_connection_id } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  try {
    if (ssh_connection_id) {
      if (type === 'dir') {
        await sshManager.exec(ssh_connection_id, `mkdir -p '${filePath.replace(/'/g, "'\\''")}'`);
      } else {
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir) await sshManager.exec(ssh_connection_id, `mkdir -p '${dir.replace(/'/g, "'\\''")}'`);
        await sshManager.sftpWriteFile(ssh_connection_id, filePath, '');
      }
    } else {
      const resolved = path.resolve(filePath);
      if (type === 'dir') {
        fs.mkdirSync(resolved, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, '');
      }
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.delete('/api/files', async (req, res) => {
  const filePath = req.query.path as string;
  const connId = req.query.ssh_connection_id as string;
  if (!filePath) return res.status(400).json({ error: 'path query parameter required' });

  try {
    if (connId) {
      await sshManager.exec(connId, `rm -rf '${filePath.replace(/'/g, "'\\''")}'`);
    } else {
      const resolved = path.resolve(filePath);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/files/move', async (req, res) => {
  const { from, to, ssh_connection_id } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    if (ssh_connection_id) {
      await sshManager.sftpRename(ssh_connection_id, from, to);
    } else {
      fs.renameSync(path.resolve(from), path.resolve(to));
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Binary file save (for screenshots etc.)
projectsRouter.post('/api/files/binary', async (req, res) => {
  const { path: filePath, data, ssh_connection_id } = req.body;
  if (!filePath || !data) {
    return res.status(400).json({ error: 'path and data (base64) are required' });
  }
  try {
    const buf = Buffer.from(data, 'base64');
    if (ssh_connection_id) {
      await sshManager.sftpWriteFile(ssh_connection_id, filePath, buf.toString('binary'));
    } else {
      const resolved = path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, buf);
    }
    res.json({ success: true, path: filePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Screenshot via Puppeteer
let screenshotBrowser: any = null;

projectsRouter.post('/api/screenshot', async (req, res) => {
  const { url, width = 1280, height = 720, fullPage = false } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const puppeteer = await import('puppeteer');
    if (!screenshotBrowser) {
      screenshotBrowser = await puppeteer.default.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    }

    const page = await screenshotBrowser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const image = await page.screenshot({ fullPage, encoding: 'base64', type: 'png' }) as string;
    await page.close();

    res.json({ image, width, height });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// GIT ENDPOINTS (scoped to project cwd)
// ═══════════════════════════════════════════════════

function getProjectCwd(req: any, res: any): { cwd: string; connectionId?: string } | null {
  const project = vccDb.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  const cwd = (req.query.cwd as string) || (project.ssh_connection_id ? (project.remote_path || project.path) : project.path);
  if (project.ssh_connection_id) {
    return { cwd, connectionId: project.ssh_connection_id };
  }
  return { cwd };
}

projectsRouter.get('/api/projects/:id/git/status', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const status = ctx.connectionId
      ? await remoteGitOps.gitStatus(ctx.connectionId, ctx.cwd)
      : await gitOps.gitStatus(ctx.cwd);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/log', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const branch = req.query.branch as string | undefined;
    const count = parseInt(req.query.count as string) || 30;
    const log = ctx.connectionId
      ? await remoteGitOps.gitLog(ctx.connectionId, ctx.cwd, branch, count)
      : await gitOps.gitLog(ctx.cwd, branch, count);
    res.json(log);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/commit-files', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const hash = req.query.hash as string;
    if (!hash) return res.status(400).json({ error: 'hash query parameter required' });
    const files = ctx.connectionId
      ? await remoteGitOps.gitCommitFiles(ctx.connectionId, ctx.cwd, hash)
      : await gitOps.gitCommitFiles(ctx.cwd, hash);
    res.json(files);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/branches', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const result = ctx.connectionId
      ? await remoteGitOps.gitBranches(ctx.connectionId, ctx.cwd)
      : await gitOps.gitBranches(ctx.cwd);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/remotes', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const remotes = ctx.connectionId
      ? await remoteGitOps.gitRemotes(ctx.connectionId, ctx.cwd)
      : await gitOps.gitRemotes(ctx.cwd);
    res.json(remotes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/stash', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const stashes = ctx.connectionId
      ? await remoteGitOps.gitStashList(ctx.connectionId, ctx.cwd)
      : await gitOps.gitStashList(ctx.cwd);
    res.json(stashes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/show', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const file = req.query.file as string;
    const ref = (req.query.ref as string) || 'HEAD';
    if (!file) return res.status(400).json({ error: 'file parameter required' });
    const content = ctx.connectionId
      ? await remoteGitOps.gitShowFile(ctx.connectionId, ctx.cwd, file, ref)
      : await gitOps.gitShowFile(ctx.cwd, file, ref);
    res.json({ content });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/diff', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const file = req.query.file as string | undefined;
    const diff = ctx.connectionId
      ? await remoteGitOps.gitDiff(ctx.connectionId, ctx.cwd, file)
      : await gitOps.gitDiff(ctx.cwd, file);
    res.json({ diff });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/blame', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const file = req.query.file as string;
    if (!file) return res.status(400).json({ error: 'file parameter required' });
    const blame = ctx.connectionId
      ? await remoteGitOps.gitBlame(ctx.connectionId, ctx.cwd, file)
      : await gitOps.gitBlame(ctx.cwd, file);
    res.json({ blame });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/file-log', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const file = req.query.file as string;
    if (!file) return res.status(400).json({ error: 'file parameter required' });
    const log = ctx.connectionId
      ? await remoteGitOps.gitFileLog(ctx.connectionId, ctx.cwd, file)
      : await gitOps.gitFileLog(ctx.cwd, file);
    res.json(log);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/checkout', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { branch } = req.body;
    if (!branch) return res.status(400).json({ error: 'branch is required' });
    ctx.connectionId
      ? await remoteGitOps.gitCheckout(ctx.connectionId, ctx.cwd, branch)
      : await gitOps.gitCheckout(ctx.cwd, branch);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/commit', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    ctx.connectionId
      ? await remoteGitOps.gitCommit(ctx.connectionId, ctx.cwd, message)
      : await gitOps.gitCommit(ctx.cwd, message);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/push', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    ctx.connectionId
      ? await remoteGitOps.gitPush(ctx.connectionId, ctx.cwd)
      : await gitOps.gitPush(ctx.cwd);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stash', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    ctx.connectionId
      ? await remoteGitOps.gitStash(ctx.connectionId, ctx.cwd)
      : await gitOps.gitStash(ctx.cwd);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stash/apply', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    ctx.connectionId
      ? await remoteGitOps.gitStashApply(ctx.connectionId, ctx.cwd, id)
      : await gitOps.gitStashApply(ctx.cwd, id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stash/drop', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    ctx.connectionId
      ? await remoteGitOps.gitStashDrop(ctx.connectionId, ctx.cwd, id)
      : await gitOps.gitStashDrop(ctx.cwd, id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/branch', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    ctx.connectionId
      ? await remoteGitOps.gitCreateBranch(ctx.connectionId, ctx.cwd, name)
      : await gitOps.gitCreateBranch(ctx.cwd, name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/fetch', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    ctx.connectionId
      ? await remoteGitOps.gitFetch(ctx.connectionId, ctx.cwd)
      : await gitOps.gitFetch(ctx.cwd);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/remotes', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    ctx.connectionId
      ? await remoteGitOps.gitAddRemote(ctx.connectionId, ctx.cwd, name, url)
      : await gitOps.gitAddRemote(ctx.cwd, name, url);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.delete('/api/projects/:id/git/remotes/:name', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    ctx.connectionId
      ? await remoteGitOps.gitRemoveRemote(ctx.connectionId, ctx.cwd, req.params.name)
      : await gitOps.gitRemoveRemote(ctx.cwd, req.params.name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.put('/api/projects/:id/git/remotes/:name', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    ctx.connectionId
      ? await remoteGitOps.gitEditRemote(ctx.connectionId, ctx.cwd, req.params.name, url)
      : await gitOps.gitEditRemote(ctx.cwd, req.params.name, url);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/revert', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { file } = req.body;
    ctx.connectionId
      ? await remoteGitOps.gitRevert(ctx.connectionId, ctx.cwd, file)
      : await gitOps.gitRevert(ctx.cwd, file);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/stage', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file is required' });
    ctx.connectionId
      ? await remoteGitOps.gitStageFile(ctx.connectionId, ctx.cwd, file)
      : await gitOps.gitStageFile(ctx.cwd, file);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/unstage', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file is required' });
    ctx.connectionId
      ? await remoteGitOps.gitUnstageFile(ctx.connectionId, ctx.cwd, file)
      : await gitOps.gitUnstageFile(ctx.cwd, file);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/api/projects/:id/git/worktrees', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const worktrees = ctx.connectionId
      ? await remoteGitOps.gitWorktreeList(ctx.connectionId, ctx.cwd)
      : await gitOps.gitWorktreeList(ctx.cwd);
    res.json(worktrees);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.post('/api/projects/:id/git/worktrees', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const { path, branch, newBranch } = req.body;
    if (!path) return res.status(400).json({ error: 'path is required' });
    ctx.connectionId
      ? await remoteGitOps.gitWorktreeAdd(ctx.connectionId, ctx.cwd, path, branch, newBranch)
      : await gitOps.gitWorktreeAdd(ctx.cwd, path, branch, newBranch);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.delete('/api/projects/:id/git/worktrees', async (req, res) => {
  const ctx = getProjectCwd(req, res);
  if (!ctx) return;
  try {
    const worktreePath = req.query.path as string;
    if (!worktreePath) return res.status(400).json({ error: 'path query parameter required' });
    ctx.connectionId
      ? await remoteGitOps.gitWorktreeRemove(ctx.connectionId, ctx.cwd, worktreePath)
      : await gitOps.gitWorktreeRemove(ctx.cwd, worktreePath);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
