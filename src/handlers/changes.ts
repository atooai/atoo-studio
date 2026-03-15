import { Router } from 'express';
import { fsMonitor } from '../fs-monitor.js';
import { store } from '../state/store.js';
import type { FileChange } from '../fs-monitor-types.js';

export const changesRouter = Router();

/**
 * Consolidate raw change events to remove artifacts from atomic write patterns.
 *
 * Claude Code does: write(tmp) → rename(tmp → final). With LD_PRELOAD we see:
 *   1. Write(tmp)                — open with O_WRONLY|O_CREAT on tmp file
 *   2. Rename(final, old=tmp)    — rename from tmp to final
 *
 * Consolidation rules:
 *   - Rename absorbs: if a Rename has old_path matching a Write/Create, remove the Write/Create
 *     (the tmp file was just an intermediate artifact) and promote the Rename.
 *   - Create + Delete cancel: if a path is Created then Deleted in the same batch, remove both.
 *   - Deduplicate: multiple writes to the same path keep only the last one.
 */
function consolidateChanges(changes: FileChange[]): FileChange[] {
  if (changes.length <= 1) return changes;

  const result = [...changes];
  const toRemove = new Set<number>();

  // Index changes by path
  const createsByPath = new Map<string, number[]>();
  const deletesByPath = new Map<string, number[]>();

  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (c.operation === 'create') {
      if (!createsByPath.has(c.path)) createsByPath.set(c.path, []);
      createsByPath.get(c.path)!.push(i);
    } else if (c.operation === 'delete') {
      if (!deletesByPath.has(c.path)) deletesByPath.set(c.path, []);
      deletesByPath.get(c.path)!.push(i);
    }
  }

  // Rule 1: Rename absorbs its old_path Create/Write (remove tmp file artifacts)
  // Promote Rename → Create/Modify
  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (c.operation === 'rename' && c.oldPath && !toRemove.has(i)) {
      const oldCreates = createsByPath.get(c.oldPath);
      if (oldCreates) {
        for (const ci of oldCreates) {
          toRemove.add(ci);
        }
        // If before_hash exists, the target file existed before → modify
        // Otherwise it's a new file → create
        const op = c.beforeHash ? 'modify' : 'create';
        result[i] = { ...c, operation: op as any, oldPath: undefined };
      }
    }
  }

  // Rule 2: Create + Delete cancel out
  for (const [, createIndices] of createsByPath) {
    const path = result[createIndices[0]]?.path;
    if (!path) continue;
    const delIndices = deletesByPath.get(path);
    if (delIndices && delIndices.length > 0) {
      let ci = 0, di = 0;
      while (ci < createIndices.length && di < delIndices.length) {
        const createIdx = createIndices[ci];
        const deleteIdx = delIndices[di];
        if (toRemove.has(createIdx)) { ci++; continue; }
        if (toRemove.has(deleteIdx)) { di++; continue; }
        if (deleteIdx > createIdx) {
          toRemove.add(createIdx);
          toRemove.add(deleteIdx);
          ci++;
          di++;
        } else {
          di++;
        }
      }
    }
  }

  // Rule 3: Deduplicate writes/creates for the same path — keep last
  const dedupByPath = new Map<string, number[]>();
  for (let i = 0; i < result.length; i++) {
    if (toRemove.has(i)) continue;
    const c = result[i];
    if (c.operation === 'create' || c.operation === 'modify') {
      if (!dedupByPath.has(c.path)) dedupByPath.set(c.path, []);
      dedupByPath.get(c.path)!.push(i);
    }
  }
  for (const [, indices] of dedupByPath) {
    if (indices.length <= 1) continue;
    const keep = indices[indices.length - 1];
    for (const i of indices) {
      if (i !== keep) toRemove.add(i);
    }
  }

  return result.filter((_, i) => !toRemove.has(i));
}

// GET /api/sessions/:id/changes — list file changes for a session
changesRouter.get('/api/sessions/:id/changes', async (req, res) => {
  const sessionId = req.params.id;
  const session = store.sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const from = req.query.from ? parseFloat(req.query.from as string) : undefined;
  const to = req.query.to ? parseFloat(req.query.to as string) : undefined;

  const changes = consolidateChanges(fsMonitor.getChangesInRange(sessionId, from, to));

  // Materialize after_hash lazily for non-delete changes
  for (const c of changes) {
    if (c.afterHash === null && c.operation !== 'delete') {
      await fsMonitor.materializeAfterHash(c);
    }
  }

  res.json({
    available: fsMonitor.isAvailable(),
    changes: changes.map(c => ({
      change_id: c.changeId,
      session_id: c.sessionId,
      timestamp: c.timestamp,
      pid: c.pid,
      operation: c.operation,
      path: c.path,
      old_path: c.oldPath || null,
      before_hash: c.beforeHash,
      after_hash: c.afterHash,
      file_size: c.fileSize,
      is_binary: c.isBinary,
    })),
  });
});

// GET /api/sessions/:id/changes/:changeId/diff — get diff data for a change
changesRouter.get('/api/sessions/:id/changes/:changeId/diff', async (req, res) => {
  const change = fsMonitor.findChange(req.params.changeId);
  if (!change) return res.status(404).json({ error: 'Change not found' });

  // Materialize after_hash if needed
  if (change.afterHash === null && change.operation !== 'delete') {
    await fsMonitor.materializeAfterHash(change);
  }

  let before: string | null = null;
  let after: string | null = null;

  if (change.beforeHash) {
    before = await fsMonitor.getFileContent(change.beforeHash);
  }
  if (change.afterHash) {
    after = await fsMonitor.getFileContent(change.afterHash);
  }

  res.json({
    operation: change.operation,
    path: change.path,
    old_path: change.oldPath || null,
    before,       // base64-encoded or null
    after,        // base64-encoded or null
    is_binary: change.isBinary,
    file_size: change.fileSize,
    before_hash: change.beforeHash,
    after_hash: change.afterHash,
    timestamp: change.timestamp,
  });
});

// POST /api/sessions/:id/changes/:changeId/revert — revert a single change
changesRouter.post('/api/sessions/:id/changes/:changeId/revert', async (req, res) => {
  const change = fsMonitor.findChange(req.params.changeId);
  if (!change) return res.status(404).json({ error: 'Change not found' });

  const result = await fsMonitor.revertChange(change);
  res.json(result);
});

// POST /api/sessions/:id/changes/revert-all — revert all changes for a session
changesRouter.post('/api/sessions/:id/changes/revert-all', async (req, res) => {
  const sessionId = req.params.id;
  const session = store.sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const result = await fsMonitor.revertAll(sessionId);
  res.json(result);
});

// GET /api/objects/:hash — download raw file content from object store
changesRouter.get('/api/objects/{*hash}', async (req, res) => {
  const hash = Array.isArray(req.params.hash) ? req.params.hash.join('/') : (req.params.hash ?? '') as string;
  if (!hash) return res.status(400).json({ error: 'Hash required' });

  const content = await fsMonitor.getFileContent(hash);
  if (!content) {
    return res.status(404).json({ error: 'Object not found' });
  }

  const buf = Buffer.from(content, 'base64');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});
