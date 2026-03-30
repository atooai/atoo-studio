/**
 * Session store v2 — directory-based I/O for normalized atoo-any sessions.
 *
 * File structure:
 *   {sessionUuid}/
 *     session.json       ← atomic rewrite (structure + metadata)
 *     prompts/{uuid}.jsonl  ← append-only per prompt
 *     blobs/{hash}       ← deduplicated binary attachments
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type {
  Session,
  Prompt,
  TreeNode,
  PromptEvent,
  ClientState,
  Attachment,
} from './schema-types.js';
import { createSession } from './schema-types.js';
import type { HistoricalSession } from '../types.js';

const SESSIONS_DIR_NAME = '.atoo-studio/atoo-any-sessions';

// ═══════════════════════════════════════════════════════
// Path helpers
// ═══════════════════════════════════════════════════════

export function getSessionsDir(cwd: string): string {
  return path.join(cwd, SESSIONS_DIR_NAME);
}

export function getSessionDir(cwd: string, sessionUuid: string): string {
  return path.join(getSessionsDir(cwd), sessionUuid);
}

export function getSessionJsonPath(sessionDir: string): string {
  return path.join(sessionDir, 'session.json');
}

export function getPromptsDir(sessionDir: string): string {
  return path.join(sessionDir, 'prompts');
}

export function getPromptFilePath(sessionDir: string, promptUuid: string): string {
  return path.join(sessionDir, 'prompts', `${promptUuid}.jsonl`);
}

export function getBlobsDir(sessionDir: string): string {
  return path.join(sessionDir, 'blobs');
}

export function getBlobPath(sessionDir: string, hash: string): string {
  return path.join(sessionDir, 'blobs', hash);
}

// ═══════════════════════════════════════════════════════
// Directory setup
// ═══════════════════════════════════════════════════════

export function ensureSessionDir(cwd: string, sessionUuid: string): string {
  const sessionDir = getSessionDir(cwd, sessionUuid);
  fs.mkdirSync(getPromptsDir(sessionDir), { recursive: true });
  fs.mkdirSync(getBlobsDir(sessionDir), { recursive: true });
  return sessionDir;
}

// ═══════════════════════════════════════════════════════
// session.json I/O (atomic write)
// ═══════════════════════════════════════════════════════

export function readSession(sessionDir: string): Session {
  const filePath = getSessionJsonPath(sessionDir);
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as Session;
}

export function readSessionSafe(sessionDir: string): Session | null {
  try {
    return readSession(sessionDir);
  } catch {
    return null;
  }
}

/**
 * Atomic write: write to temp file, fsync, rename.
 * If process crashes mid-write, the old file is still intact.
 */
export function writeSession(sessionDir: string, session: Session): void {
  session.updatedAt = new Date().toISOString();
  const filePath = getSessionJsonPath(sessionDir);
  const tmpPath = filePath + '.tmp.' + process.pid;
  const content = JSON.stringify(session, null, 2);
  const fd = fs.openSync(tmpPath, 'w');
  fs.writeSync(fd, content);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filePath);
}

// ═══════════════════════════════════════════════════════
// Write queue (serialize writes to session.json)
// ═══════════════════════════════════════════════════════

const writeQueues = new Map<string, Promise<void>>();

/**
 * Enqueue a mutation to session.json.
 * The mutator receives the current session, modifies it in place, and it's saved atomically.
 * All writes to the same session are serialized.
 */
export function enqueueSessionWrite(sessionDir: string, mutator: (session: Session) => void): Promise<void> {
  const prev = writeQueues.get(sessionDir) || Promise.resolve();
  const next = prev.then(() => {
    const session = readSession(sessionDir);
    mutator(session);
    writeSession(sessionDir, session);
  }).catch(err => {
    console.error(`[session-store-v2] Write failed for ${sessionDir}:`, err.message);
  });
  writeQueues.set(sessionDir, next);
  return next;
}

// ═══════════════════════════════════════════════════════
// Prompt JSONL I/O (append-only)
// ═══════════════════════════════════════════════════════

export function appendPromptEvent(sessionDir: string, promptUuid: string, event: PromptEvent): void {
  const filePath = getPromptFilePath(sessionDir, promptUuid);
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
}

export function readPromptEvents(sessionDir: string, promptUuid: string): PromptEvent[] {
  const filePath = getPromptFilePath(sessionDir, promptUuid);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const events: PromptEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

// ═══════════════════════════════════════════════════════
// Blob I/O (content-hash deduplicated)
// ═══════════════════════════════════════════════════════

/** Store a blob, returning the content hash. No-op if already exists. */
export function writeBlob(sessionDir: string, data: Buffer): string {
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const blobPath = getBlobPath(sessionDir, hash);
  if (!fs.existsSync(blobPath)) {
    fs.writeFileSync(blobPath, data);
  }
  return hash;
}

/** Store a base64 blob (stripping data URI prefix if present). */
export function writeBlobBase64(sessionDir: string, base64Data: string): string {
  const raw = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  return writeBlob(sessionDir, Buffer.from(raw, 'base64'));
}

export function readBlob(sessionDir: string, hash: string): Buffer {
  return fs.readFileSync(getBlobPath(sessionDir, hash));
}

export function blobExists(sessionDir: string, hash: string): boolean {
  return fs.existsSync(getBlobPath(sessionDir, hash));
}

// ═══════════════════════════════════════════════════════
// Tree walking
// ═══════════════════════════════════════════════════════

/**
 * Walk the tree following activePath indices.
 * Returns the flat list of nodes on the active path.
 * At each fork (node with multiple children), follow children[activePath[depth]].
 * If no index available, follow children[0] (default to first/original).
 */
export function walkActivePath(roots: TreeNode[], activePath: number[]): TreeNode[] {
  if (roots.length === 0) return [];

  // activePath[0] selects which root (if multiple roots/extractions)
  const rootIndex = activePath[0] ?? 0;
  const root = roots[rootIndex];
  if (!root) return [];

  const result: TreeNode[] = [];
  let current: TreeNode | undefined = root;
  let depth = 1; // depth 0 was the root selection

  while (current) {
    result.push(current);
    const ch: TreeNode[] | undefined = current.children;
    if (!ch || ch.length === 0) break;

    if (ch.length === 1) {
      // No fork, just follow the single child
      current = ch[0];
    } else {
      // Fork point: pick child by activePath index
      const childIndex = activePath[depth] ?? 0;
      current = ch[childIndex] ?? ch[0];
      depth++;
    }
  }

  return result;
}

/**
 * Find the most recent path through the tree (by prompt startedAt).
 * Used to initialize new clients.
 */
export function findMostRecentPath(roots: TreeNode[], prompts: Record<string, Prompt>): number[] {
  if (roots.length === 0) return [];

  // Find the root with the most recent activity
  let bestRootIndex = 0;
  let bestTime = '';
  for (let i = 0; i < roots.length; i++) {
    const leafTime = findDeepestTime(roots[i], prompts);
    if (leafTime > bestTime) {
      bestTime = leafTime;
      bestRootIndex = i;
    }
  }

  const path: number[] = [bestRootIndex];
  let current: TreeNode | undefined = roots[bestRootIndex];

  while (current) {
    const ch: TreeNode[] | undefined = current.children;
    if (!ch || ch.length <= 1) {
      if (ch?.length === 1) current = ch[0];
      else break;
      continue;
    }

    // At a fork: pick the child with the most recent leaf
    let bestChildIndex = 0;
    let bestChildTime = '';
    for (let i = 0; i < ch.length; i++) {
      const t = findDeepestTime(ch[i], prompts);
      if (t > bestChildTime) {
        bestChildTime = t;
        bestChildIndex = i;
      }
    }
    path.push(bestChildIndex);
    current = ch[bestChildIndex];
  }

  return path;
}

function findDeepestTime(node: TreeNode, prompts: Record<string, Prompt>): string {
  const prompt = prompts[node.uuid];
  let best = prompt?.startedAt || '';

  if (node.children) {
    for (const child of node.children) {
      const t = findDeepestTime(child, prompts);
      if (t > best) best = t;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════
// Tree mutations
// ═══════════════════════════════════════════════════════

/**
 * Append a new prompt node to the current leaf of the active path.
 */
export function appendToActivePath(session: Session, activePath: number[], promptUuid: string, agentIndices: number[]): void {
  const node: TreeNode = { uuid: promptUuid, agents: agentIndices };

  if (session.tree.length === 0) {
    // First prompt — create the root
    session.tree.push(node);
    return;
  }

  // Walk to the leaf
  const nodes = walkActivePath(session.tree, activePath);
  if (nodes.length === 0) {
    session.tree.push(node);
    return;
  }

  const leaf = nodes[nodes.length - 1];
  if (!leaf.children) leaf.children = [];
  leaf.children.push(node);
}

/**
 * Fork: add a new child to a specific node in the tree.
 * Returns the child index of the new branch (for updating activePath).
 */
export function forkAtNode(session: Session, activePath: number[], targetUuid: string): number {
  const nodes = walkActivePath(session.tree, activePath);
  const target = nodes.find(n => n.uuid === targetUuid);
  if (!target) return 0;

  if (!target.children) target.children = [];
  // The new branch starts empty — the next prompt will be appended to it
  // Return the index of the new (empty) fork slot
  return target.children.length;
}

/**
 * Compact: create a new branch replacing a range of prompts with a synthetic compaction node.
 * The branch diverges at the parent of the first compacted prompt.
 * Returns the new activePath for the compacted branch.
 */
export function compactInTree(
  session: Session,
  activePath: number[],
  compactPromptUuid: string,
  replacedUuids: string[],
): number[] {
  const nodes = walkActivePath(session.tree, activePath);
  if (nodes.length === 0) return activePath;

  // Find the parent of the first replaced prompt
  const firstReplacedIndex = nodes.findIndex(n => replacedUuids.includes(n.uuid));
  if (firstReplacedIndex <= 0) return activePath;

  const parentNode = nodes[firstReplacedIndex - 1];
  if (!parentNode.children) parentNode.children = [];

  // Build the compacted branch: compact node + remaining nodes after the replaced range
  const lastReplacedIndex = nodes.findIndex(n => n.uuid === replacedUuids[replacedUuids.length - 1]);
  const remainingNodes = nodes.slice(lastReplacedIndex + 1);

  // Build the branch as a chain
  const compactNode: TreeNode = { uuid: compactPromptUuid, agents: [0] };
  let chainTip = compactNode;
  for (const remaining of remainingNodes) {
    const copy: TreeNode = { uuid: remaining.uuid, agents: remaining.agents };
    chainTip.children = [copy];
    chainTip = copy;
  }

  parentNode.children.push(compactNode);
  const newChildIndex = parentNode.children.length - 1;

  // Build new activePath: copy up to the fork depth, then select the new branch
  const newPath = [...activePath];
  // Count how many forks we passed before the parent
  let forkDepth = 1; // depth 0 = root selection
  for (let i = 0; i < firstReplacedIndex - 1; i++) {
    const n = nodes[i];
    if (n.children && n.children.length > 1) forkDepth++;
  }
  // Extend path if needed and set the fork index
  while (newPath.length <= forkDepth) newPath.push(0);
  newPath[forkDepth] = newChildIndex;

  return newPath;
}

/**
 * Hide: create a new branch where a specific prompt is marked hidden.
 * Similar to compact — diverges at the parent, copies remaining with hidden flag.
 */
export function hideInTree(
  session: Session,
  activePath: number[],
  hideUuid: string,
): number[] {
  const nodes = walkActivePath(session.tree, activePath);
  const hideIndex = nodes.findIndex(n => n.uuid === hideUuid);
  if (hideIndex <= 0) return activePath;

  const parentNode = nodes[hideIndex - 1];
  if (!parentNode.children) parentNode.children = [];

  // Build branch: hidden node + remaining
  const remaining = nodes.slice(hideIndex);
  let first: TreeNode | undefined;
  let chainTip: TreeNode | undefined;

  for (const node of remaining) {
    const copy: TreeNode = {
      uuid: node.uuid,
      agents: node.agents,
      ...(node.uuid === hideUuid ? { hidden: true } : {}),
    };
    if (!first) {
      first = copy;
      chainTip = copy;
    } else {
      chainTip!.children = [copy];
      chainTip = copy;
    }
  }

  if (first) {
    parentNode.children.push(first);
  }

  const newChildIndex = parentNode.children.length - 1;
  const newPath = [...activePath];
  let forkDepth = 1;
  for (let i = 0; i < hideIndex - 1; i++) {
    if (nodes[i].children && nodes[i].children!.length > 1) forkDepth++;
  }
  while (newPath.length <= forkDepth) newPath.push(0);
  newPath[forkDepth] = newChildIndex;

  return newPath;
}

/**
 * Extract: add prompt range as a new root in the tree.
 */
export function extractAsRoot(session: Session, promptUuids: string[], label?: string): void {
  // Build a chain of the extracted prompts
  let root: TreeNode | undefined;
  let tip: TreeNode | undefined;

  for (const uuid of promptUuids) {
    const prompt = session.prompts[uuid];
    const node: TreeNode = {
      uuid,
      agents: prompt ? prompt.agents.map((_, i) => i) : undefined,
    };
    if (!root) {
      root = node;
      tip = node;
    } else {
      tip!.children = [node];
      tip = node;
    }
  }

  if (root) {
    session.tree.push(root);
  }
}

// ═══════════════════════════════════════════════════════
// Session scanning (for historical sessions list)
// ═══════════════════════════════════════════════════════

/**
 * Scan for session directories (new format).
 */
export function scanSessionDirs(cwds: string[]): HistoricalSession[] {
  const sessions: HistoricalSession[] = [];

  for (const cwd of cwds) {
    const sessionsDir = getSessionsDir(cwd);
    if (!fs.existsSync(sessionsDir)) continue;

    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const sessionDir = path.join(sessionsDir, entry.name);
        const jsonPath = getSessionJsonPath(sessionDir);
        if (!fs.existsSync(jsonPath)) continue;

        try {
          const session = readSession(sessionDir);
          const stat = fs.statSync(jsonPath);
          const promptCount = Object.keys(session.prompts).length;

          sessions.push({
            id: session.uuid,
            agentType: 'atoo-any',
            title: session.metadata.name || session.metadata.title,
            directory: session.directory,
            lastModified: session.updatedAt || stat.mtime.toISOString(),
            eventCount: promptCount,
            metaName: session.metadata.name,
            tags: session.metadata.tags,
          });
        } catch {}
      }
    } catch {}
  }

  return sessions;
}

/**
 * Check if a UUID matches a session directory.
 */
export function ownsSession(uuid: string, cwds: string[]): boolean {
  for (const cwd of cwds) {
    const sessionDir = getSessionDir(cwd, uuid);
    if (fs.existsSync(getSessionJsonPath(sessionDir))) return true;
  }
  return false;
}

/**
 * Initialize a new session on disk.
 */
export function initSession(cwd: string, sessionUuid: string): { session: Session; sessionDir: string } {
  const sessionDir = ensureSessionDir(cwd, sessionUuid);
  const session = createSession(sessionUuid, cwd);
  writeSession(sessionDir, session);
  return { session, sessionDir };
}
