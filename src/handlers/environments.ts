import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../state/db.js';
import * as gitOps from '../services/git-ops.js';
import { watchProject } from '../services/project-watcher.js';
import { isAuthEnabled } from '../auth/middleware.js';

export const environmentsRouter = Router();

// Broadcast function — set by server.ts when /ws/settings is initialized
export let broadcastSettingsChange: (scope: string, key: string, settings: any, excludeWs?: any) => void = () => {};
export function setBroadcastSettingsChange(fn: typeof broadcastSettingsChange) {
  broadcastSettingsChange = fn;
}

// ═══════════════════════════════════════════════════
// ENVIRONMENT ENDPOINTS
// ═══════════════════════════════════════════════════

// List environments (filtered by user when auth is enabled)
environmentsRouter.get('/api/environments', (req, res) => {
  if (isAuthEnabled() && req.user) {
    const envs = db.listEnvironmentsForUser(req.user.id);
    return res.json(envs);
  }
  const envs = db.listEnvironments();
  res.json(envs);
});

// Create environment
environmentsRouter.post('/api/environments', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (isAuthEnabled() && req.user) {
    const env = db.createEnvironmentWithOwner(name, req.user.id);
    return res.json(env);
  }
  const env = db.createEnvironment(name);
  res.json(env);
});

// Delete environment (owner only when auth is enabled)
environmentsRouter.delete('/api/environments/:id', (req, res) => {
  if (isAuthEnabled() && req.user) {
    const owner = db.getEnvironmentOwner(req.params.id);
    if (owner !== req.user.id) {
      return res.status(403).json({ error: 'Only the environment owner can delete it' });
    }
  }
  const deleted = db.deleteEnvironment(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Environment not found' });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// ENVIRONMENT SHARING
// ═══════════════════════════════════════════════════

// List shares for an environment
environmentsRouter.get('/api/environments/:id/shares', (req, res) => {
  if (isAuthEnabled() && req.user) {
    if (!db.canAccessEnvironment(req.user.id, req.params.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }
  const shares = db.listEnvironmentShares(req.params.id);
  res.json(shares);
});

// Share environment with a user (owner only)
environmentsRouter.post('/api/environments/:id/shares', (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  if (isAuthEnabled() && req.user) {
    const owner = db.getEnvironmentOwner(req.params.id);
    if (owner !== req.user.id) {
      return res.status(403).json({ error: 'Only the environment owner can share it' });
    }
  }

  const targetUser = db.getUser(user_id);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  db.shareEnvironment(req.params.id, user_id, req.user?.id || 'system');
  res.json({ ok: true });
});

// Revoke share
environmentsRouter.delete('/api/environments/:id/shares/:userId', (req, res) => {
  if (isAuthEnabled() && req.user) {
    const owner = db.getEnvironmentOwner(req.params.id);
    if (owner !== req.user.id) {
      return res.status(403).json({ error: 'Only the environment owner can manage shares' });
    }
  }

  const deleted = db.unshareEnvironment(req.params.id, req.params.userId);
  if (!deleted) return res.status(404).json({ error: 'Share not found' });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
// PROJECTS IN ENVIRONMENT
// ═══════════════════════════════════════════════════

// Get projects in an environment (with live isGit + pe_id)
environmentsRouter.get('/api/environments/:id/projects', (req, res) => {
  if (isAuthEnabled() && req.user && !db.canAccessEnvironment(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const env = db.getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });

  const projects = db.getProjectsForEnvironment(req.params.id);
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
  if (isAuthEnabled() && req.user && !db.canAccessEnvironment(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const env = db.getEnvironment(req.params.id);
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

      if (initGit && remoteUrl) {
        try {
          await remoteGit.gitClone(ssh_connection_id, remoteUrl, projectPath);
        } catch {}
      } else {
        // Ensure remote directory exists
        try {
          await sshManager.exec(ssh_connection_id, `mkdir -p '${projectPath.replace(/'/g, "'\\''")}'`);
        } catch {}
        if (initGit) {
          try {
            await remoteGit.gitInit(ssh_connection_id, projectPath);
          } catch {}
        }
      }

      const project = db.createProject(name, projectPath, {
        sshConnectionId: ssh_connection_id,
        remotePath: remote_path || projectPath,
      });
      const peId = db.linkProject(project.id, req.params.id);

      let isGit = false;
      try {
        await sshManager.exec(ssh_connection_id, `test -d '${projectPath.replace(/'/g, "'\\''")}'/.git`);
        isGit = true;
      } catch {}

      res.json({ ...project, pe_id: peId, isGit });
    } else {
      // Local project
      const resolved = path.resolve(projectPath);
      if (initGit && remoteUrl && !fs.existsSync(path.join(resolved, '.git'))) {
        // Clone into target directory (git clone creates it if needed)
        await gitOps.gitClone(remoteUrl, resolved);
      } else {
        if (!fs.existsSync(resolved)) {
          fs.mkdirSync(resolved, { recursive: true });
        }
        if (initGit && !fs.existsSync(path.join(resolved, '.git'))) {
          await gitOps.gitInit(resolved);
        }
      }

      const project = db.createProject(name, projectPath);
      const peId = db.linkProject(project.id, req.params.id);

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
  const env = db.getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });

  const { project_id } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });

  const project = db.getProject(project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const peId = db.linkProject(project_id, req.params.id);
  res.json({ success: true, pe_id: peId });
});

// Unlink project from environment by PE ID
environmentsRouter.delete('/api/project-links/:peId', (req, res) => {
  const pe = db.getProjectEnvironment(req.params.peId);
  if (!pe) return res.status(404).json({ error: 'Link not found' });

  const deleteProject = req.query.deleteProject === 'true';
  const deleteFiles = req.query.deleteFiles === 'true';

  db.unlinkProject(req.params.peId);

  // Check remaining links
  const remainingEnvs = db.getEnvironmentsForProject(pe.project_id);

  if (remainingEnvs.length === 0 && deleteProject) {
    // Delete working directory if requested
    if (deleteFiles) {
      const project = db.getProject(pe.project_id);
      if (project && !project.ssh_connection_id) {
        try {
          fs.rmSync(project.path, { recursive: true, force: true });
        } catch {}
      }
    }
    db.deleteProject(pe.project_id);
  }

  res.json({ success: true, remainingLinks: remainingEnvs.length });
});

// Resolve a project-environment link (for URL-based routing)
environmentsRouter.get('/api/project-links/:peId', (req, res) => {
  const pe = db.getProjectEnvironment(req.params.peId);
  if (!pe) return res.status(404).json({ error: 'Project link not found' });
  const project = db.getProject(pe.project_id);
  const environment = db.getEnvironment(pe.environment_id);
  res.json({ ...pe, project, environment });
});

// ═══════════════════════════════════════════════════
// ENVIRONMENT SETTINGS
// ═══════════════════════════════════════════════════

environmentsRouter.get('/api/environments/:id/settings', (req, res) => {
  const settings = db.getEnvironmentSettings(req.params.id);
  if (!settings) return res.status(404).json({ error: 'Environment not found' });
  res.json(settings);
});

environmentsRouter.put('/api/environments/:id/settings', (req, res) => {
  db.updateEnvironmentSettings(req.params.id, req.body);
  const settings = db.getEnvironmentSettings(req.params.id);
  broadcastSettingsChange('environment', req.params.id, settings, (req as any)._settingsWs);
  res.json(settings);
});

// ═══════════════════════════════════════════════════
// PROJECT SETTINGS (by project-environment link ID)
// ═══════════════════════════════════════════════════

environmentsRouter.get('/api/project-links/:peId/settings', (req, res) => {
  const settings = db.getProjectSettings(req.params.peId);
  res.json(settings);
});

environmentsRouter.put('/api/project-links/:peId/settings', (req, res) => {
  db.updateProjectSettings(req.params.peId, req.body);
  const settings = db.getProjectSettings(req.params.peId);
  broadcastSettingsChange('project', req.params.peId, settings, (req as any)._settingsWs);
  res.json(settings);
});
