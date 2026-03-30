/**
 * JSONL session persistence for atoo-any agent.
 * Stores SessionEvents with extra metadata (_source, _parentUserUuid, _dispatchId).
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SessionEvent } from '../../events/types.js';
import type { HistoricalSession } from '../types.js';

const SESSIONS_DIR_NAME = '.atoo-studio/atoo-any-sessions';

export type AtooMessageStatus = 'visible' | 'removed' | 'compacted';

export interface AtooEventMeta {
  _source?: 'claude' | 'codex' | 'gemini';
  _parentUserUuid?: string;
  _dispatchId?: string;
  // Branch-aware fields
  _branchId?: string;
  _msgStatus?: AtooMessageStatus;
  _compactedSummary?: string;
  _compactedBy?: string;
  _contextDrift?: boolean;
}

/** Meta-event for branch structure changes (stored in JSONL) */
export interface AtooBranchOperation {
  type: 'branch_operation';
  uuid: string;
  timestamp: string;
  operation: 'fork' | 'remove' | 'restore' | 'compact' | 'extract' | 'switch_branch';
  // Fork: where the branch diverges
  forkPointEventUuid?: string;
  branchId?: string;
  branchLabel?: string;
  parentBranchId?: string | null; // branch from which the fork was created
  // Remove/restore: which events are affected
  targetEventUuids?: string[];
  // Compact: summary info
  compactedBy?: string;
  compactedSummary?: string;
  // Extract: extraction metadata
  extractionId?: string;
  extractionLabel?: string;
  sourceRange?: [string, string]; // [startEventUuid, endEventUuid]
}

export type AtooSessionEvent = SessionEvent & AtooEventMeta;

/**
 * Get the sessions directory for a project.
 */
export function getSessionsDir(cwd: string): string {
  return path.join(cwd, SESSIONS_DIR_NAME);
}

/**
 * Get the JSONL file path for a session.
 */
export function getSessionFilePath(cwd: string, sessionUuid: string): string {
  return path.join(getSessionsDir(cwd), `${sessionUuid}.jsonl`);
}

/**
 * Ensure the sessions directory exists.
 */
export function ensureSessionsDir(cwd: string): void {
  fs.mkdirSync(getSessionsDir(cwd), { recursive: true });
}

/**
 * Append a single event to a session JSONL file.
 */
export function appendEvent(filePath: string, event: SessionEvent, meta?: AtooEventMeta): void {
  const line: any = { ...event };
  if (meta?._source) line._source = meta._source;
  if (meta?._parentUserUuid) line._parentUserUuid = meta._parentUserUuid;
  if (meta?._dispatchId) line._dispatchId = meta._dispatchId;
  if (meta?._branchId) line._branchId = meta._branchId;
  if (meta?._msgStatus) line._msgStatus = meta._msgStatus;
  if (meta?._compactedSummary) line._compactedSummary = meta._compactedSummary;
  if (meta?._compactedBy) line._compactedBy = meta._compactedBy;
  if (meta?._contextDrift != null) line._contextDrift = meta._contextDrift;
  fs.appendFileSync(filePath, JSON.stringify(line) + '\n');
}

/**
 * Append a branch operation meta-event to the session JSONL.
 */
export function appendBranchOperation(filePath: string, op: AtooBranchOperation): void {
  fs.appendFileSync(filePath, JSON.stringify(op) + '\n');
}

/**
 * Read all events from a session JSONL file.
 */
export function readAllEvents(filePath: string): AtooSessionEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const events: AtooSessionEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip unparseable lines
    }
  }
  return events;
}

/**
 * Strip atoo-any metadata from events (for cross-family resume).
 */
export function stripMeta(events: AtooSessionEvent[]): SessionEvent[] {
  return events.map(e => {
    const { _source, _parentUserUuid, _dispatchId, _branchId, _msgStatus, _compactedSummary, _compactedBy, _contextDrift, ...rest } = e;
    return rest as SessionEvent;
  });
}

/**
 * Scan session directories for atoo-any session files.
 */
export function scanSessions(cwds: string[]): HistoricalSession[] {
  const sessions: HistoricalSession[] = [];
  for (const cwd of cwds) {
    const dir = getSessionsDir(cwd);
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const uuid = file.replace('.jsonl', '');
        const meta = parseQuickMeta(filePath);
        sessions.push({
          id: uuid,
          agentType: 'atoo-any',
          title: meta.title,
          directory: cwd,
          lastModified: meta.lastModified,
          eventCount: meta.eventCount,
        });
      }
    } catch {}
  }
  return sessions;
}

/**
 * Get all session file paths for given cwds.
 */
export function getSessionFiles(cwds: string[]): string[] {
  const files: string[] = [];
  for (const cwd of cwds) {
    const dir = getSessionsDir(cwd);
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
      }
    } catch {}
  }
  return files;
}

/**
 * Check if a UUID matches a session file in any of the given cwds.
 */
export function ownsSession(uuid: string, cwds: string[]): boolean {
  for (const cwd of cwds) {
    const filePath = getSessionFilePath(cwd, uuid);
    if (fs.existsSync(filePath)) return true;
  }
  return false;
}

interface QuickMeta {
  title: string;
  lastModified: string;
  eventCount: number;
}

// ─── Fork state reconstruction ──────────────────────────

export interface ForkBranch {
  id: string;
  label: string;
  isOriginal: boolean;
}

export interface ForkInfo {
  id: string;
  forkPointEventUuid: string;
  parentBranchId: string | null;
  branches: ForkBranch[];
  activeBranchId: string;
}

export interface ForkState {
  forks: ForkInfo[];
  activeBranchId: string | null;
}

/**
 * Replay branch_operation records from JSONL to reconstruct fork state.
 * Returns the fork structure and the currently active branch.
 */
export function rebuildForkState(allRecords: any[]): ForkState {
  const forks = new Map<string, ForkInfo>(); // forkPointEventUuid -> ForkInfo
  let activeBranchId: string | null = null;

  for (const record of allRecords) {
    if (record.type !== 'branch_operation') continue;

    if (record.operation === 'fork' && record.forkPointEventUuid && record.branchId) {
      const existing = forks.get(record.forkPointEventUuid);
      if (existing) {
        // Adding another branch to an existing fork point
        existing.branches.push({
          id: record.branchId,
          label: record.branchLabel || `Branch ${existing.branches.length + 1}`,
          isOriginal: false,
        });
      } else {
        // New fork point — create with original branch + new branch
        const originalBranchId = record.parentBranchId ?? null;
        const forkId = record.uuid;
        forks.set(record.forkPointEventUuid, {
          id: forkId,
          forkPointEventUuid: record.forkPointEventUuid,
          parentBranchId: originalBranchId,
          branches: [
            { id: originalBranchId ?? '__main__', label: 'Original', isOriginal: true },
            { id: record.branchId, label: record.branchLabel || 'Branch 1', isOriginal: false },
          ],
          activeBranchId: record.branchId, // new branch is active by default
        });
      }
      // Forking implicitly switches to the new branch
      activeBranchId = record.branchId;
    } else if (record.operation === 'switch_branch' && record.branchId) {
      // Only process switch_branch ops that have forkPointEventUuid (new format).
      // Old ops without it are ambiguous (multiple forks can share __main__) and are ignored.
      if (record.forkPointEventUuid && forks.has(record.forkPointEventUuid)) {
        const fork = forks.get(record.forkPointEventUuid)!;
        fork.activeBranchId = record.branchId;
      }
      // Recompute global active branch from last fork
      let lastActive: string | null = null;
      for (const fork of forks.values()) {
        lastActive = fork.activeBranchId === '__main__' ? null : fork.activeBranchId;
      }
      activeBranchId = lastActive;
    }
  }

  return { forks: [...forks.values()], activeBranchId };
}

/**
 * Check if a message's branchId matches the active branch at a fork point.
 * Untagged messages (null) belong to the original branch.
 */
function isOnActiveBranch(branchId: string | null, fork: ForkInfo): boolean {
  const origBranch = fork.branches.find(b => b.isOriginal);
  const origBid = origBranch?.id ?? '__main__';
  const effectiveBranch = branchId || origBid;
  return effectiveBranch === fork.activeBranchId;
}

/**
 * Given the fork state and a list of events, return only events visible on the active path.
 * Events before any fork point are always visible. After a fork point, only events matching
 * the active branch at that fork are included. Fork-point messages and their dispatch
 * responses (which existed before the fork) are always visible.
 */
export function filterEventsForActivePath(events: AtooSessionEvent[], forkState: ForkState): AtooSessionEvent[] {
  if (forkState.forks.length === 0) return events;

  const forkByEventUuid = new Map<string, ForkInfo>();
  for (const fork of forkState.forks) {
    forkByEventUuid.set(fork.forkPointEventUuid, fork);
  }
  const forkPointSet = new Set(forkState.forks.map(f => f.forkPointEventUuid));
  const visibleForkPoints = new Set<string>();

  const result: AtooSessionEvent[] = [];
  const activeGates: ForkInfo[] = [];

  for (const event of events) {
    if ((event as any).type === 'branch_operation') {
      result.push(event);
      continue;
    }

    const eventBranch: string | null = (event as any)._branchId || null;
    const eventUuid = (event as any).uuid;

    // Dispatch response — follows parent's visibility
    if ((event as any)._dispatchId) {
      const parentUuid = (event as any)._parentUserUuid;
      if (parentUuid && visibleForkPoints.has(parentUuid)) {
        result.push(event);
        continue;
      }
      if (activeGates.length === 0) { result.push(event); continue; }
      if (activeGates.every(gate => isOnActiveBranch(eventBranch, gate))) result.push(event);
      continue;
    }

    // Top-level message: check gates first
    const passesGates = activeGates.length === 0 || activeGates.every(gate => isOnActiveBranch(eventBranch, gate));
    if (!passesGates) continue;

    // If this is a fork point that passed the gates, register it and add its gate
    if ((event as any).type === 'user' && eventUuid && forkPointSet.has(eventUuid)) {
      visibleForkPoints.add(eventUuid);
      const fork = forkByEventUuid.get(eventUuid);
      if (fork) activeGates.push(fork);
    }

    result.push(event);
  }

  return result;
}

function parseQuickMeta(filePath: string): QuickMeta {
  const defaultMeta: QuickMeta = {
    title: 'Atoo Any Session',
    lastModified: new Date().toISOString(),
    eventCount: 0,
  };

  try {
    const stat = fs.statSync(filePath);
    defaultMeta.lastModified = stat.mtime.toISOString();

    // Read first 32KB for quick metadata
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, 32768));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    const content = buf.toString('utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    defaultMeta.eventCount = lines.length;

    // Find first user message for title
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'user' && event.message?.content) {
          const text = typeof event.message.content === 'string'
            ? event.message.content
            : event.message.content.map((b: any) => b.text || '').join('');
          defaultMeta.title = text.substring(0, 100) || 'Atoo Any Session';
          break;
        }
      } catch {}
    }

    // Get total line count from full file if small enough
    if (stat.size <= 32768) {
      defaultMeta.eventCount = lines.length;
    }
  } catch {}

  return defaultMeta;
}
