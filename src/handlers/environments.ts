import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { vccDb } from '../state/db.js';
import * as gitOps from '../services/git-ops.js';
import { watchProject } from '../services/project-watcher.js';

export const environmentsRouter = Router();

// Broadcast function — set by server.ts when /ws/settings is initialized
export let broadcastSettingsChange: (scope: string, key: string, settings: any, excludeWs?: any) => void = () => {};
export function setBroadcastSettingsChange(fn: typeof broadcastSettingsChange) {
  broadcastSettingsChange = fn;
}

// ═══════════════════════════════════════════════════
// ENVIRONMENT ENDPOINTS
// ═══════════════════════════════════════════════════

// List all environments (with project_count)
environmentsRouter.get('/api/environments', (_req, res) => {
  const envs = vccDb.listEnvironments();
  res.json(envs);
});

// Create environment
environmentsRouter.post('/api/environments', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const env = vccDb.createEnvironment(name);
  res.json(env);
});

// Delete environment
environmentsRouter.delete('/api/environments/:id', (req, res) => {
  const deleted = vccDb.deleteEnvironment(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Environment not found' });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// PROJECTS IN ENVIRONMENT
// ═══════════════════════════════════════════════════

// Get projects in an environment (with live isGit + pe_id)
environmentsRouter.get('/api/environments/:id/projects', (req, res) => {
  const env = vccDb.getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });

  const projects = vccDb.getProjectsForEnvironment(req.params.id);
  const withGit = projects.map(p => {
    if (p.ssh_connection_id) {
      // Remote project — skip local fs checks and watching
      return { ...p, isGit: false };
    }
    let isGit = false;
    try { isGit = fs.existsSync(path.join(p.path, '.git')); } catch {}
    // Start watching this project's directory
    watchProject(p.id, p.path);
    return { ...p, isGit };
  });
  res.json(withGit);
});

// Create project + link to environment
environmentsRouter.post('/api/environments/:id/projects', async (req, res) => {
  const env = vccDb.getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });

  const { name, path: projectPath, initGit, remoteUrl, ssh_connection_id, remote_path } = req.body;
  if (!name || !projectPath) {
    return res.status(400).json({ error: 'name and path are required' });
  }

  try {
    if (ssh_connection_id) {
      // Remote project — skip local fs checks
      const { sshManager } = await import('../services/ssh-manager.js');
      const remoteGit = await import('../services/remote-git-ops.js');

      // Ensure remote directory exists
      try {
        await sshManager.exec(ssh_connection_id, `mkdir -p '${projectPath.replace(/'/g, "'\\''")}'`);
      } catch {}

      if (initGit) {
        try {
          await remoteGit.gitInit(ssh_connection_id, projectPath);
          if (remoteUrl) {
            await remoteGit.gitAddRemote(ssh_connection_id, projectPath, 'origin', remoteUrl);
          }
        } catch {}
      }

      const project = vccDb.createProject(name, projectPath, {
        sshConnectionId: ssh_connection_id,
        remotePath: remote_path || projectPath,
      });
      const peId = vccDb.linkProject(project.id, req.params.id);

      let isGit = false;
      try {
        await sshManager.exec(ssh_connection_id, `test -d '${projectPath.replace(/'/g, "'\\''")}'/.git`);
        isGit = true;
      } catch {}

      res.json({ ...project, pe_id: peId, isGit });
    } else {
      // Local project
      const resolved = path.resolve(projectPath);
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }

      if (initGit && !fs.existsSync(path.join(resolved, '.git'))) {
        await gitOps.gitInit(resolved);
        if (remoteUrl) {
          await gitOps.gitAddRemote(resolved, 'origin', remoteUrl);
        }
      }

      const project = vccDb.createProject(name, projectPath);
      const peId = vccDb.linkProject(project.id, req.params.id);

      let isGit = false;
      try { isGit = fs.existsSync(path.join(resolved, '.git')); } catch {}

      // Start watching the new project
      watchProject(project.id, resolved);

      res.json({ ...project, pe_id: peId, isGit });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Connect an existing project from another environment
environmentsRouter.post('/api/environments/:id/connect-project', (req, res) => {
  const env = vccDb.getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });

  const { project_id } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });

  const project = vccDb.getProject(project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const peId = vccDb.linkProject(project_id, req.params.id);
  res.json({ success: true, pe_id: peId });
});

// Unlink project from environment by PE ID
environmentsRouter.delete('/api/project-links/:peId', (req, res) => {
  vccDb.unlinkProject(req.params.peId);
  res.json({ success: true });
});

// Resolve a project-environment link (for URL-based routing)
environmentsRouter.get('/api/project-links/:peId', (req, res) => {
  const pe = vccDb.getProjectEnvironment(req.params.peId);
  if (!pe) return res.status(404).json({ error: 'Project link not found' });
  const project = vccDb.getProject(pe.project_id);
  const environment = vccDb.getEnvironment(pe.environment_id);
  res.json({ ...pe, project, environment });
});

// ═══════════════════════════════════════════════════
// ENVIRONMENT SETTINGS
// ═══════════════════════════════════════════════════

environmentsRouter.get('/api/environments/:id/settings', (req, res) => {
  const settings = vccDb.getEnvironmentSettings(req.params.id);
  if (!settings) return res.status(404).json({ error: 'Environment not found' });
  res.json(settings);
});

environmentsRouter.put('/api/environments/:id/settings', (req, res) => {
  vccDb.updateEnvironmentSettings(req.params.id, req.body);
  const settings = vccDb.getEnvironmentSettings(req.params.id);
  broadcastSettingsChange('environment', req.params.id, settings, (req as any)._settingsWs);
  res.json(settings);
});

// ═══════════════════════════════════════════════════
// PROJECT SETTINGS (by project-environment link ID)
// ═══════════════════════════════════════════════════

environmentsRouter.get('/api/project-links/:peId/settings', (req, res) => {
  const settings = vccDb.getProjectSettings(req.params.peId);
  res.json(settings);
});

environmentsRouter.put('/api/project-links/:peId/settings', (req, res) => {
  vccDb.updateProjectSettings(req.params.peId, req.body);
  const settings = vccDb.getProjectSettings(req.params.peId);
  broadcastSettingsChange('project', req.params.peId, settings, (req as any)._settingsWs);
  res.json(settings);
});
