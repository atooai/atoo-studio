import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import type {
  FileChange,
  PreloadEvent,
  ChangeOperation,
} from './fs-monitor-types.js';

const ATOO_DIR = path.join(os.homedir(), '.atoo-studio');
const SOCKET_PATH = path.join(ATOO_DIR, 'preload.sock');
const OBJECTS_DIR = path.join(ATOO_DIR, 'objects');

type ChangeListener = (change: FileChange) => void;

/** Map a preload op to a FileChange operation. */
function mapOperation(op: PreloadEvent['op'], fileExisted: boolean): ChangeOperation {
  switch (op) {
    case 'write':
      return fileExisted ? 'modify' : 'create';
    case 'rename':
      return 'rename';
    case 'delete':
      return 'delete';
    case 'truncate':
      return 'modify';
  }
}

/** Detect if a buffer is likely binary (contains null bytes). */
function isBinaryBuffer(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Paths to exclude from inotify watching. */
function shouldExcludeInotify(filePath: string): boolean {
  const base = path.basename(filePath);
  // Skip hidden dirs/files (except specific ones), node_modules, etc.
  if (base === 'node_modules') return true;
  if (base === '.git') return true;
  if (base === '.atoo-studio') return true;
  if (filePath.includes('/node_modules/')) return true;
  if (filePath.includes('/.git/')) return true;
  if (filePath.includes('/.atoo-studio/')) return true;
  return false;
}

/** Store a buffer in the content-addressed object store. Returns the hash. */
function storeObject(buf: Buffer): string {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const objectPath = path.join(OBJECTS_DIR, hash);
  if (!fs.existsSync(objectPath)) {
    fs.writeFileSync(objectPath, buf);
  }
  return hash;
}

interface InotifySession {
  sessionId: string;
  baseDir: string;
  watcher: fs.FSWatcher;
  /** Snapshot of file hashes taken at watch start, for before-state */
  initialHashes: Map<string, string>;
}

export class FsMonitor {
  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();
  private listening = false;
  private changes = new Map<string, FileChange[]>(); // sessionId → changes
  private changeListeners: ChangeListener[] = [];
  /** Mapping from preload tracking UUID → real session ID */
  private sessionMap = new Map<string, string>();
  /** Active inotify watchers per session */
  private inotifySessions = new Map<string, InotifySession>();
  /** Track paths already reported by preload (to dedup with inotify) */
  private preloadReportedPaths = new Map<string, Set<string>>(); // sessionId → Set<path>

  /** Start the Unix socket server for preload library connections. */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Ensure directories exist
      fs.mkdirSync(ATOO_DIR, { recursive: true });
      fs.mkdirSync(OBJECTS_DIR, { recursive: true });

      // Remove stale socket
      try { fs.unlinkSync(SOCKET_PATH); } catch {}

      const server = net.createServer((client) => {
        this.clients.add(client);
        const rl = readline.createInterface({ input: client });

        rl.on('line', (line: string) => {
          this.handlePreloadEvent(line);
        });

        client.on('error', () => {
          this.clients.delete(client);
        });

        client.on('close', () => {
          this.clients.delete(client);
        });
      });

      server.on('error', (err) => {
        console.error(`[fs-monitor] Socket server error: ${err.message}`);
        reject(err);
      });

      server.listen(SOCKET_PATH, () => {
        this.listening = true;
        console.log(`[fs-monitor] Preload socket listening on ${SOCKET_PATH}`);
        resolve();
      });

      this.server = server;
    });
  }

  /** Register a listener for real-time change events. */
  onChangeEvent(listener: ChangeListener): void {
    this.changeListeners.push(listener);
  }

  /** Remove a change event listener. */
  offChangeEvent(listener: ChangeListener): void {
    const idx = this.changeListeners.indexOf(listener);
    if (idx >= 0) this.changeListeners.splice(idx, 1);
  }

  /** Handle a JSON line from a preload library instance. */
  private handlePreloadEvent(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: PreloadEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      console.warn('[fs-monitor] Invalid JSON from preload:', trimmed.substring(0, 100));
      return;
    }

    // Remap tracking UUID to real session ID
    const realSessionId = this.sessionMap.get(event.session_id) || event.session_id;

    // Mark this path as reported by preload (for inotify dedup)
    if (!this.preloadReportedPaths.has(realSessionId)) {
      this.preloadReportedPaths.set(realSessionId, new Set());
    }
    this.preloadReportedPaths.get(realSessionId)!.add(event.path);

    // Process snapshot: hash and move to object store
    let beforeHash: string | null = null;
    let fileSize = 0;
    let binary = false;

    if (event.snapshot) {
      try {
        const snapBuf = fs.readFileSync(event.snapshot);
        fileSize = snapBuf.length;
        binary = isBinaryBuffer(snapBuf);

        const hash = crypto.createHash('sha256').update(snapBuf).digest('hex');
        const objectPath = path.join(OBJECTS_DIR, hash);

        // Move snapshot to object store (content-addressed, skip if exists)
        if (!fs.existsSync(objectPath)) {
          fs.renameSync(event.snapshot, objectPath);
        } else {
          try { fs.unlinkSync(event.snapshot); } catch {}
        }

        beforeHash = hash;
      } catch (err: any) {
        console.warn(`[fs-monitor] Failed to process snapshot ${event.snapshot}: ${err.message}`);
      }
    }

    const operation = mapOperation(event.op, event.file_existed);

    this.recordChange({
      sessionId: realSessionId,
      timestamp: event.ts,
      operation,
      filePath: event.path,
      oldPath: event.old_path,
      beforeHash,
      fileSize,
      isBinary: binary,
    });
  }

  /** Handle an inotify event from fs.watch. */
  private handleInotifyEvent(sessionId: string, baseDir: string, _eventType: string, filename: string | null): void {
    if (!filename) return;

    const filePath = path.resolve(baseDir, filename);

    // Skip excluded paths
    if (shouldExcludeInotify(filePath)) return;

    // Skip if already reported by preload recently
    const preloadPaths = this.preloadReportedPaths.get(sessionId);
    if (preloadPaths?.has(filePath)) return;

    const inoSession = this.inotifySessions.get(sessionId);
    if (!inoSession) return;

    this.processInotifyChange(sessionId, filePath, inoSession);
  }

  /** Process a debounced inotify change. */
  private processInotifyChange(sessionId: string, filePath: string, inoSession: InotifySession): void {
    // Re-check preload dedup after debounce
    const preloadPaths = this.preloadReportedPaths.get(sessionId);
    if (preloadPaths?.has(filePath)) return;

    const fileExists = fs.existsSync(filePath);
    const initialHash = inoSession.initialHashes.get(filePath);

    let operation: ChangeOperation;
    let beforeHash: string | null = initialHash || null;
    let fileSize = 0;
    let binary = false;

    if (!fileExists) {
      if (!initialHash) {
        // File never existed at session start and is now gone — transient, skip
        return;
      }
      operation = 'delete';
    } else {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return; // Skip directories
        fileSize = stat.size;
      } catch { return; }

      if (initialHash) {
        // File existed before — check if actually changed
        try {
          const buf = fs.readFileSync(filePath);
          const currentHash = crypto.createHash('sha256').update(buf).digest('hex');
          if (currentHash === initialHash) return; // No actual change
          binary = isBinaryBuffer(buf);
          fileSize = buf.length;
        } catch { return; }
        operation = 'modify';
      } else {
        // File didn't exist at session start — it's a create
        operation = 'create';
        try {
          const buf = fs.readFileSync(filePath);
          binary = isBinaryBuffer(buf);
          fileSize = buf.length;
        } catch {}
      }
    }

    // Update initial hash for subsequent changes
    if (fileExists) {
      try {
        const buf = fs.readFileSync(filePath);
        const newHash = storeObject(buf);
        inoSession.initialHashes.set(filePath, newHash);
      } catch {}
    } else {
      inoSession.initialHashes.delete(filePath);
    }

    this.recordChange({
      sessionId,
      timestamp: Date.now() / 1000,
      operation,
      filePath,
      beforeHash,
      fileSize,
      isBinary: binary,
    });
  }

  /** Record a FileChange and notify listeners. */
  private recordChange(opts: {
    sessionId: string;
    timestamp: number;
    operation: ChangeOperation;
    filePath: string;
    oldPath?: string;
    beforeHash: string | null;
    fileSize: number;
    isBinary: boolean;
  }): void {
    const change: FileChange = {
      changeId: uuidv4(),
      sessionId: opts.sessionId,
      timestamp: opts.timestamp,
      pid: 0,
      operation: opts.operation,
      path: opts.filePath,
      oldPath: opts.oldPath,
      beforeHash: opts.beforeHash,
      afterHash: null, // lazy — materialized on demand
      fileSize: opts.fileSize,
      isBinary: opts.isBinary,
    };

    if (!this.changes.has(opts.sessionId)) {
      this.changes.set(opts.sessionId, []);
    }
    this.changes.get(opts.sessionId)!.push(change);

    // Notify listeners
    for (const listener of this.changeListeners) {
      try {
        listener(change);
      } catch (err) {
        console.error('[fs-monitor] Listener error:', err);
      }
    }
  }

  /**
   * Start watching a session's working directory.
   * Combines preload session mapping + inotify watching.
   */
  watchPid(sessionId: string, _pid: number, baseDir: string): void {
    console.log(`[fs-monitor] watchPid: session=${sessionId}, dir=${baseDir}`);
    if (!this.changes.has(sessionId)) {
      this.changes.set(sessionId, []);
    }

    // Start inotify watcher for the working directory
    this.startInotifyWatch(sessionId, baseDir);
  }

  /** Start an inotify (fs.watch) watcher for a session's working directory. */
  private startInotifyWatch(sessionId: string, baseDir: string): void {
    // Don't double-watch
    if (this.inotifySessions.has(sessionId)) return;

    try {
      // Snapshot initial file hashes for before-state tracking
      const initialHashes = new Map<string, string>();
      this.snapshotDirectory(baseDir, initialHashes);
      console.log(`[fs-monitor] Snapshotted ${initialHashes.size} files in ${baseDir}`);

      const watcher = fs.watch(baseDir, { recursive: true }, (eventType, filename) => {
        this.handleInotifyEvent(sessionId, baseDir, eventType, filename);
      });

      watcher.on('error', (err) => {
        console.warn(`[fs-monitor] Inotify watcher error for ${sessionId}: ${err.message}`);
      });

      const inoSession: InotifySession = {
        sessionId,
        baseDir,
        watcher,
        initialHashes,
      };

      this.inotifySessions.set(sessionId, inoSession);
      console.log(`[fs-monitor] Inotify watching ${baseDir} for session ${sessionId}`);
    } catch (err: any) {
      console.warn(`[fs-monitor] Failed to start inotify for ${baseDir}: ${err.message}`);
    }
  }

  /** Recursively snapshot file hashes in a directory. */
  private snapshotDirectory(dir: string, hashes: Map<string, string>, depth = 0): void {
    if (depth > 10) return; // Limit recursion depth
    if (shouldExcludeInotify(dir)) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (shouldExcludeInotify(fullPath)) continue;

        if (entry.isDirectory()) {
          this.snapshotDirectory(fullPath, hashes, depth + 1);
        } else if (entry.isFile()) {
          try {
            const buf = fs.readFileSync(fullPath);
            const hash = storeObject(buf);
            hashes.set(fullPath, hash);
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  /** Register the mapping from a preload tracking UUID to the real session ID. */
  registerSessionMapping(preloadSessionId: string, realSessionId: string): void {
    this.sessionMap.set(preloadSessionId, realSessionId);
    // Remap any changes already received with the tracking UUID
    const pending = this.changes.get(preloadSessionId);
    if (pending && pending.length > 0) {
      const existing = this.changes.get(realSessionId) || [];
      for (const c of pending) {
        c.sessionId = realSessionId;
        existing.push(c);
      }
      this.changes.set(realSessionId, existing);
      this.changes.delete(preloadSessionId);
    }
    // Also remap preload reported paths
    const preloadPaths = this.preloadReportedPaths.get(preloadSessionId);
    if (preloadPaths) {
      const existing = this.preloadReportedPaths.get(realSessionId) || new Set();
      for (const p of preloadPaths) existing.add(p);
      this.preloadReportedPaths.set(realSessionId, existing);
      this.preloadReportedPaths.delete(preloadSessionId);
    }
  }

  /** Stop watching a session. */
  unwatchPid(sessionId: string): void {
    const inoSession = this.inotifySessions.get(sessionId);
    if (inoSession) {
      inoSession.watcher.close();
      this.inotifySessions.delete(sessionId);
    }
  }

  /** Get all changes for a session. */
  getChanges(sessionId: string): FileChange[] {
    return this.changes.get(sessionId) || [];
  }

  /** Get changes for a session within a time range. */
  getChangesInRange(sessionId: string, from?: number, to?: number): FileChange[] {
    const all = this.getChanges(sessionId);
    if (from === undefined && to === undefined) return all;
    return all.filter(c => {
      if (from !== undefined && c.timestamp < from) return false;
      if (to !== undefined && c.timestamp > to) return false;
      return true;
    });
  }

  /** Get the change count for a session. */
  getChangeCount(sessionId: string): number {
    return this.changes.get(sessionId)?.length || 0;
  }

  /** Read file content by hash from the object store. Returns base64-encoded content. */
  async getFileContent(hash: string): Promise<string | null> {
    const objectPath = path.join(OBJECTS_DIR, hash);
    try {
      const buf = fs.readFileSync(objectPath);
      return buf.toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Materialize the after_hash for a change by reading the file's current content.
   * Returns the hash, or null if the file doesn't exist.
   */
  async materializeAfterHash(change: FileChange): Promise<string | null> {
    if (change.afterHash !== null) return change.afterHash;
    if (change.operation === 'delete') return null;

    try {
      const buf = fs.readFileSync(change.path);
      const hash = storeObject(buf);

      // Cache on the change record
      change.afterHash = hash;
      change.fileSize = Math.max(change.fileSize, buf.length);
      change.isBinary = change.isBinary || isBinaryBuffer(buf);

      return hash;
    } catch {
      // File may have been deleted since the change
      return null;
    }
  }

  /** Revert a single change by restoring the file to its before state. */
  async revertChange(change: FileChange): Promise<{ success: boolean; message?: string }> {
    try {
      switch (change.operation) {
        case 'modify': {
          if (!change.beforeHash) {
            return { success: false, message: 'No before snapshot available' };
          }
          const content = await this.getFileContent(change.beforeHash);
          if (!content) {
            return { success: false, message: 'Failed to read before content from object store' };
          }
          const buf = Buffer.from(content, 'base64');
          fs.writeFileSync(change.path, buf);
          return { success: true };
        }
        case 'create': {
          // Undo creation by deleting the file
          if (fs.existsSync(change.path)) {
            fs.unlinkSync(change.path);
          }
          return { success: true };
        }
        case 'delete': {
          if (!change.beforeHash) {
            return { success: false, message: 'No before snapshot available for deleted file' };
          }
          const content = await this.getFileContent(change.beforeHash);
          if (!content) {
            return { success: false, message: 'Failed to read before content from object store' };
          }
          const buf = Buffer.from(content, 'base64');
          // Ensure parent directory exists
          const dir = path.dirname(change.path);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(change.path, buf);
          return { success: true };
        }
        case 'rename': {
          if (change.oldPath) {
            fs.renameSync(change.path, change.oldPath);
          }
          return { success: true };
        }
        default:
          return { success: false, message: `Unknown operation: ${change.operation}` };
      }
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /** Revert all changes for a session in reverse chronological order. */
  async revertAll(sessionId: string): Promise<{ success: boolean; reverted: number; failed: number }> {
    const changes = this.getChanges(sessionId);
    if (changes.length === 0) {
      return { success: true, reverted: 0, failed: 0 };
    }

    // Process in reverse order
    const reversed = [...changes].reverse();
    let reverted = 0;
    let failed = 0;

    for (const change of reversed) {
      const result = await this.revertChange(change);
      if (result.success) {
        reverted++;
      } else {
        failed++;
        console.warn(`[fs-monitor] Failed to revert ${change.changeId}: ${result.message}`);
      }
    }

    return { success: failed === 0, reverted, failed };
  }

  /** Find a specific change by ID across all sessions. */
  findChange(changeId: string): FileChange | undefined {
    for (const changes of this.changes.values()) {
      const found = changes.find(c => c.changeId === changeId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Third fallback: notify that a tool call modified a file.
   * Called when a Write/Edit tool_result arrives. Checks if the change
   * was already captured by preload or inotify; if not, records it.
   */
  notifyToolChange(sessionId: string, filePath: string, toolName: string): void {
    const absPath = path.resolve(filePath);

    // Dedup: check if this path was already captured recently (within 3s)
    const existing = this.changes.get(sessionId);
    if (existing) {
      const now = Date.now() / 1000;
      const alreadyCaptured = existing.some(
        c => c.path === absPath && (now - c.timestamp) < 3
      );
      if (alreadyCaptured) {
        console.log(`[fs-monitor] Tool change for ${absPath} already captured, skipping`);
        return;
      }
    }

    // Also check preload reported paths
    const preloadPaths = this.preloadReportedPaths.get(sessionId);
    if (preloadPaths?.has(absPath)) {
      console.log(`[fs-monitor] Tool change for ${absPath} already reported by preload, skipping`);
      return;
    }

    // Determine before hash from inotify session snapshot
    const inoSession = this.inotifySessions.get(sessionId);
    let beforeHash: string | null = null;
    if (inoSession) {
      beforeHash = inoSession.initialHashes.get(absPath) || null;
    }

    // Determine operation
    let operation: ChangeOperation;
    if (toolName === 'Write') {
      operation = beforeHash ? 'modify' : 'create';
    } else if (toolName === 'Edit') {
      operation = 'modify';
    } else {
      return;
    }

    // Read current file state
    let fileSize = 0;
    let binary = false;
    const fileExists = fs.existsSync(absPath);

    if (fileExists) {
      try {
        const buf = fs.readFileSync(absPath);
        fileSize = buf.length;
        binary = isBinaryBuffer(buf);

        // Update inotify initial hash for future change detection
        if (inoSession) {
          const hash = storeObject(buf);
          inoSession.initialHashes.set(absPath, hash);
        }
      } catch {}
    }

    console.log(`[fs-monitor] Tool change: ${toolName} → ${operation} ${absPath}`);
    this.recordChange({
      sessionId,
      timestamp: Date.now() / 1000,
      operation,
      filePath: absPath,
      beforeHash,
      fileSize,
      isBinary: binary,
    });
  }

  /** Whether the monitor is available (socket server listening). */
  isAvailable(): boolean {
    return this.listening;
  }

  /** Close the socket server, inotify watchers, and all client connections. */
  disconnect(): void {
    // Close inotify watchers
    for (const [, inoSession] of this.inotifySessions) {
      inoSession.watcher.close();
    }
    this.inotifySessions.clear();

    // Close preload socket clients
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.listening = false;

    // Clean up socket file
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
  }
}

export const fsMonitor = new FsMonitor();
