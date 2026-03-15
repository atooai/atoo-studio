import { Router, Request, Response } from 'express';
import { execFile, execFileSync } from 'child_process';

export const containersRouter = Router();

// --- Runtime detection ---

interface RuntimeStatus {
  installed: boolean;
  accessible: boolean;
  error?: string;
}

function detectRuntime(cmd: string, versionArgs: string[], testArgs: string[]): RuntimeStatus {
  try {
    execFileSync(cmd, versionArgs, { stdio: 'ignore', timeout: 5000 });
  } catch {
    return { installed: false, accessible: false };
  }
  // Installed — now test if we actually have permission to use it
  try {
    execFileSync(cmd, testArgs, { stdio: 'pipe', timeout: 10000 });
    return { installed: true, accessible: true };
  } catch (e: any) {
    const msg = (e.stderr?.toString() || e.message || '').trim();
    const isPermission = /permission denied|access denied|connect:|dial unix|Got permission denied|cannot connect/i.test(msg);
    if (isPermission) {
      let hint: string;
      if (cmd === 'lxc') {
        hint = 'Permission denied. Run: sudo usermod -aG lxd $USER  (then re-login)';
      } else {
        hint = `Permission denied. Run: sudo usermod -aG ${cmd} $USER  (then re-login)`;
      }
      return { installed: true, accessible: false, error: hint };
    }
    // Command ran but returned non-zero for other reasons (e.g. empty list) — that's fine
    return { installed: true, accessible: true };
  }
}

function detectAllRuntimes() {
  return {
    docker: detectRuntime('docker', ['--version'], ['ps', '--format', 'json']),
    podman: detectRuntime('podman', ['--version'], ['ps', '--format', 'json']),
    lxc: detectRuntime('lxc', ['version'], ['list', '--format', 'json']),
  };
}

// Cache with TTL — re-detect every 30 seconds so permission changes take effect without restart
let runtimeCache: { docker: RuntimeStatus; podman: RuntimeStatus; lxc: RuntimeStatus } | null = null;
let runtimeCacheTime = 0;
const CACHE_TTL_MS = 30_000;

function getRuntimeStatus() {
  const now = Date.now();
  if (!runtimeCache || now - runtimeCacheTime > CACHE_TTL_MS) {
    runtimeCache = detectAllRuntimes();
    runtimeCacheTime = now;
  }
  return runtimeCache;
}

export function getContainerRuntimes() {
  return getRuntimeStatus();
}

// --- Validation ---

const VALID_RUNTIMES = ['docker', 'podman'] as const;
const ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/;
const ACTIONS = ['start', 'stop', 'restart'] as const;

function validateRuntime(runtime: string): runtime is 'docker' | 'podman' {
  return (VALID_RUNTIMES as readonly string[]).includes(runtime);
}

function validateId(id: string): boolean {
  return ID_REGEX.test(id) && id.length <= 256;
}

function execCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseJsonLines(output: string): any[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  // Some commands output a JSON array, others output one JSON object per line
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Try parsing as newline-delimited JSON
    return trimmed.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }
}

// --- Runtime availability endpoint ---

containersRouter.get('/api/containers/runtimes', (_req: Request, res: Response) => {
  res.json(getRuntimeStatus());
});

// ═══════════════════════════════════════════════════════
// LXC endpoints — MUST be before :runtime wildcard routes
// ═══════════════════════════════════════════════════════

containersRouter.get('/api/containers/lxc/containers', async (_req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  try {
    const out = await execCmd('lxc', ['list', '--format', 'json']);
    res.json(JSON.parse(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/lxc/images', async (_req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  try {
    const out = await execCmd('lxc', ['image', 'list', '--format', 'json']);
    res.json(JSON.parse(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/lxc/networks', async (_req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  try {
    const out = await execCmd('lxc', ['network', 'list', '--format', 'json']);
    res.json(JSON.parse(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/lxc/storage', async (_req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  try {
    const out = await execCmd('lxc', ['storage', 'list', '--format', 'json']);
    res.json(JSON.parse(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/lxc/storage/:name', async (req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  const name = req.params.name as string;
  if (!validateId(name)) return res.status(400).json({ error: 'Invalid storage name' });
  try {
    const out = await execCmd('lxc', ['storage', 'info', name, '--format', 'json']);
    res.json(JSON.parse(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.post('/api/containers/lxc/containers/:name/:action', async (req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  const name = req.params.name as string, action = req.params.action as string;
  if (!validateId(name)) return res.status(400).json({ error: 'Invalid container name' });
  if (!(ACTIONS as readonly string[]).includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    await execCmd('lxc', [action, name]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.delete('/api/containers/lxc/containers/:name', async (req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  const name = req.params.name as string;
  if (!validateId(name)) return res.status(400).json({ error: 'Invalid container name' });
  try {
    await execCmd('lxc', ['delete', name, '--force']);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.delete('/api/containers/lxc/images/:fingerprint', async (req: Request, res: Response) => {
  if (!getRuntimeStatus().lxc.accessible) return res.status(403).json({ error: getRuntimeStatus().lxc.error || 'lxc not available' });
  const fingerprint = req.params.fingerprint as string;
  if (!validateId(fingerprint)) return res.status(400).json({ error: 'Invalid fingerprint' });
  try {
    await execCmd('lxc', ['image', 'delete', fingerprint]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════
// Docker/Podman endpoints (parameterized :runtime)
// ═══════════════════════════════════════════════════════

containersRouter.get('/api/containers/:runtime/containers', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  try {
    const out = await execCmd(runtime, ['ps', '-a', '--format', 'json']);
    res.json(parseJsonLines(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/:runtime/images', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  try {
    const out = await execCmd(runtime, ['images', '--format', 'json']);
    res.json(parseJsonLines(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/:runtime/volumes', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  try {
    const out = await execCmd(runtime, ['volume', 'ls', '--format', 'json']);
    res.json(parseJsonLines(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/:runtime/networks', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  try {
    const out = await execCmd(runtime, ['network', 'ls', '--format', 'json']);
    res.json(parseJsonLines(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/:runtime/compose', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  try {
    const out = await execCmd(runtime, ['compose', 'ls', '--format', 'json']);
    res.json(parseJsonLines(out));
  } catch (e: any) {
    // compose might not be installed
    res.json([]);
  }
});

containersRouter.get('/api/containers/:runtime/containers/:id/inspect', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string, id = req.params.id as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  if (!validateId(id)) return res.status(400).json({ error: 'Invalid container ID' });
  try {
    const out = await execCmd(runtime, ['inspect', id]);
    res.json(JSON.parse(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/:runtime/containers/:id/stats', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string, id = req.params.id as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  if (!validateId(id)) return res.status(400).json({ error: 'Invalid container ID' });
  try {
    const out = await execCmd(runtime, ['stats', '--no-stream', '--format', 'json', id]);
    const parsed = parseJsonLines(out);
    res.json(parsed[0] || {});
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.get('/api/containers/:runtime/volumes/:name/inspect', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string, name = req.params.name as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  if (!validateId(name)) return res.status(400).json({ error: 'Invalid volume name' });
  try {
    const out = await execCmd(runtime, ['volume', 'inspect', name]);
    res.json(JSON.parse(out));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.post('/api/containers/:runtime/containers/:id/:action', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string, id = req.params.id as string, action = req.params.action as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  if (!validateId(id)) return res.status(400).json({ error: 'Invalid container ID' });
  if (!(ACTIONS as readonly string[]).includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    await execCmd(runtime, [action, id]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.delete('/api/containers/:runtime/containers/:id', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string, id = req.params.id as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  if (!validateId(id)) return res.status(400).json({ error: 'Invalid container ID' });
  try {
    await execCmd(runtime, ['rm', '-f', id]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

containersRouter.delete('/api/containers/:runtime/images/:id', async (req: Request, res: Response) => {
  const runtime = req.params.runtime as string, id = req.params.id as string;
  if (!validateRuntime(runtime)) return res.status(400).json({ error: 'Invalid runtime' });
  if (!getRuntimeStatus()[runtime].accessible) return res.status(403).json({ error: getRuntimeStatus()[runtime].error || `${runtime} not available` });
  if (!validateId(id)) return res.status(400).json({ error: 'Invalid image ID' });
  try {
    await execCmd(runtime, ['rmi', id]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
