/**
 * JSONL session file discovery and tailing.
 * Watches Claude CLI's session JSONL files for new events in real-time.
 * Also discovers and tails subagent JSONL files from progress events.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DISCOVERY_TIMEOUT = 5_000;
const DEBOUNCE_MS = 50;

/**
 * Convert a cwd path to Claude CLI's dir-hash format.
 * "/home/furti/myproject" → "-home-furti-myproject"
 */
function cwdToDirHash(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export interface SubagentMetadata {
  sidechain: true;
  parentToolUseID: string;
  agentId: string;
}

interface SubagentTailer {
  filePath: string;
  lastReadOffset: number;
  lineBuffer: string;
  fileWatcher: fs.FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export class JsonlWatcher extends EventEmitter {
  private cwd: string;
  private resumeUuid?: string;
  private dirPath: string;
  private targetPath: string | null = null;
  private sessionUuid: string | null = null;
  private lastReadOffset = 0;
  private lineBuffer = '';
  private dirWatcher: fs.FSWatcher | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private preExistingFiles = new Set<string>();

  /** Active subagent tailers keyed by agentId */
  private subagentTailers = new Map<string, SubagentTailer>();
  /** Maps agentId → parentToolUseID from the progress event that spawned it */
  private subagentParents = new Map<string, string>();

  constructor(options: { cwd: string; resumeUuid?: string }) {
    super();
    this.cwd = options.cwd;
    this.resumeUuid = options.resumeUuid;
    this.dirPath = path.join(CLAUDE_PROJECTS_DIR, cwdToDirHash(this.cwd));
  }

  /**
   * Phase 1: Snapshot existing JSONL files BEFORE the CLI is spawned.
   * Must be called before the PTY spawn to avoid a race where the CLI
   * creates its file before we record what was already there.
   */
  snapshot(): void {
    if (this.resumeUuid) return; // resume doesn't need a snapshot
    this.snapshotExisting();
    console.log(`[jsonl-watcher] Snapshot: ${this.preExistingFiles.size} existing JSONL files in ${this.dirPath}`);
  }

  /**
   * Phase 2: Begin watching for a new file (or the known resume file).
   * Called AFTER the PTY spawn.
   */
  async start(): Promise<void> {
    if (this.resumeUuid) {
      // Known UUID — wait for that specific file
      this.targetPath = path.join(this.dirPath, `${this.resumeUuid}.jsonl`);
      this.sessionUuid = this.resumeUuid;
      this.waitForFile(this.targetPath);
    } else {
      // Watch for a new file that wasn't in the snapshot
      this.watchForNewFile();
    }
  }

  /** Set of agentIds currently being tailed (for adapter to check) */
  get tailedAgentIds(): ReadonlySet<string> {
    return new Set(this.subagentTailers.keys());
  }

  /**
   * Start tailing a known session UUID file directly, bypassing discovery.
   * Used when hooks report the exact session ID.
   */
  startTailingKnownUuid(uuid: string): void {
    this.targetPath = path.join(this.dirPath, `${uuid}.jsonl`);
    this.sessionUuid = uuid;
    // Stop any active discovery
    if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
    if (this.discoveryTimer) { clearTimeout(this.discoveryTimer); this.discoveryTimer = null; }
    // Wait for the file to exist, then start tailing
    this.waitForFile(this.targetPath);
  }

  stop(): void {
    this.stopped = true;
    if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
    if (this.fileWatcher) { this.fileWatcher.close(); this.fileWatcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.discoveryTimer) { clearTimeout(this.discoveryTimer); this.discoveryTimer = null; }

    // Stop all subagent tailers
    for (const [agentId, tailer] of this.subagentTailers) {
      if (tailer.fileWatcher) tailer.fileWatcher.close();
      if (tailer.debounceTimer) clearTimeout(tailer.debounceTimer);
      console.log(`[jsonl-watcher] Stopped subagent tailer: ${agentId}`);
    }
    this.subagentTailers.clear();
    this.subagentParents.clear();
  }

  private snapshotExisting(): void {
    try {
      if (fs.existsSync(this.dirPath)) {
        for (const f of fs.readdirSync(this.dirPath)) {
          if (f.endsWith('.jsonl')) this.preExistingFiles.add(f);
        }
      }
    } catch {}
  }

  private watchForNewFile(): void {
    // Ensure the projects dir exists
    try { fs.mkdirSync(this.dirPath, { recursive: true }); } catch {}

    try {
      this.dirWatcher = fs.watch(this.dirPath, (eventType, filename) => {
        if (this.stopped || this.targetPath) return;
        if (!filename || !filename.endsWith('.jsonl')) return;
        if (this.preExistingFiles.has(filename)) return;

        // New JSONL file appeared
        this.targetPath = path.join(this.dirPath, filename);
        this.sessionUuid = filename.replace('.jsonl', '');
        if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
        if (this.discoveryTimer) { clearTimeout(this.discoveryTimer); this.discoveryTimer = null; }
        console.log(`[jsonl-watcher] Discovered session file: ${filename}`);
        this.startTailing();
      });
    } catch (err: any) {
      console.warn(`[jsonl-watcher] Cannot watch directory ${this.dirPath}:`, err.message);
    }

    // Fallback: if no new file detected, pick the most recently modified one
    this.discoveryTimer = setTimeout(() => {
      if (this.stopped || this.targetPath) return;
      this.fallbackDiscovery();
    }, DISCOVERY_TIMEOUT);
  }

  private waitForFile(filePath: string): void {
    if (fs.existsSync(filePath)) {
      console.log(`[jsonl-watcher] Resume file exists: ${path.basename(filePath)}`);
      this.startTailing();
      return;
    }

    // Watch directory for the file to appear
    try { fs.mkdirSync(this.dirPath, { recursive: true }); } catch {}
    const targetName = path.basename(filePath);

    try {
      this.dirWatcher = fs.watch(this.dirPath, (eventType, filename) => {
        if (this.stopped) return;
        if (filename === targetName) {
          if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
          if (this.discoveryTimer) { clearTimeout(this.discoveryTimer); this.discoveryTimer = null; }
          console.log(`[jsonl-watcher] Resume file appeared: ${targetName}`);
          this.startTailing();
        }
      });
    } catch {}

    this.discoveryTimer = setTimeout(() => {
      if (this.stopped) return;
      if (fs.existsSync(filePath)) {
        this.startTailing();
      } else {
        console.warn(`[jsonl-watcher] Timeout waiting for resume file: ${targetName}`);
      }
    }, DISCOVERY_TIMEOUT);
  }

  private fallbackDiscovery(): void {
    try {
      const files = fs.readdirSync(this.dirPath).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) {
        console.warn('[jsonl-watcher] No JSONL files found in', this.dirPath);
        return;
      }

      // Prefer files NOT in the pre-existing snapshot (i.e., created after we started)
      const newFiles = files.filter(f => !this.preExistingFiles.has(f));
      const candidates = newFiles.length > 0 ? newFiles : files;

      // Pick the most recently modified
      let best: { name: string; mtime: number } | null = null;
      for (const f of candidates) {
        try {
          const stat = fs.statSync(path.join(this.dirPath, f));
          if (!best || stat.mtimeMs > best.mtime) {
            best = { name: f, mtime: stat.mtimeMs };
          }
        } catch {}
      }

      if (best) {
        this.targetPath = path.join(this.dirPath, best.name);
        this.sessionUuid = best.name.replace('.jsonl', '');
        if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
        console.log(`[jsonl-watcher] Fallback: using ${newFiles.length > 0 ? 'new' : 'most recent'} file: ${best.name}`);
        this.startTailing();
      }
    } catch {}
  }

  private startTailing(): void {
    if (this.stopped || !this.targetPath) return;

    // Read any existing content first (for resume or late discovery)
    this.readFromOffset();

    // Watch for future changes
    try {
      this.fileWatcher = fs.watch(this.targetPath, (eventType) => {
        if (this.stopped || eventType !== 'change') return;
        this.debouncedRead();
      });
      this.emit('ready');
    } catch (err: any) {
      console.error(`[jsonl-watcher] Cannot watch file ${this.targetPath}:`, err.message);
      this.emit('error', err);
    }
  }

  private debouncedRead(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.readFromOffset();
    }, DEBOUNCE_MS);
  }

  private readFromOffset(): void {
    if (!this.targetPath) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.targetPath);
    } catch {
      return;
    }

    // Handle truncation
    if (stat.size < this.lastReadOffset) {
      console.warn('[jsonl-watcher] File truncated, re-reading from start');
      this.lastReadOffset = 0;
      this.lineBuffer = '';
    }

    if (stat.size <= this.lastReadOffset) return;

    try {
      const fd = fs.openSync(this.targetPath, 'r');
      const buf = Buffer.alloc(stat.size - this.lastReadOffset);
      fs.readSync(fd, buf, 0, buf.length, this.lastReadOffset);
      fs.closeSync(fd);

      this.lastReadOffset = stat.size;

      const chunk = this.lineBuffer + buf.toString('utf-8');
      const lines = chunk.split('\n');

      // Last element may be incomplete — buffer it
      this.lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Check for subagent progress events and start tailing subagent files
          this.maybeStartSubagentTailer(event);

          this.emit('event', event);
        } catch {
          // Skip unparseable lines
        }
      }
    } catch (err: any) {
      console.error('[jsonl-watcher] Read error:', err.message);
    }
  }

  /**
   * If the event is a progress event with data.agentId, start tailing
   * the subagent's JSONL file.
   */
  private maybeStartSubagentTailer(event: any): void {
    if (event.type !== 'progress') return;
    const agentId = event.data?.agentId;
    if (!agentId || this.subagentTailers.has(agentId)) return;
    if (!this.sessionUuid) return;

    const parentToolUseID = event.parentToolUseID || event.toolUseID || '';
    this.subagentParents.set(agentId, parentToolUseID);

    const subagentPath = path.join(
      this.dirPath,
      this.sessionUuid,
      'subagents',
      `agent-${agentId}.jsonl`,
    );

    // Start tailing, but the file may not exist yet
    this.startSubagentTailing(agentId, subagentPath, parentToolUseID);
  }

  private startSubagentTailing(agentId: string, filePath: string, parentToolUseID: string): void {
    const tailer: SubagentTailer = {
      filePath,
      lastReadOffset: 0,
      lineBuffer: '',
      fileWatcher: null,
      debounceTimer: null,
    };
    this.subagentTailers.set(agentId, tailer);

    const metadata: SubagentMetadata = {
      sidechain: true,
      parentToolUseID,
      agentId,
    };

    // Try to read existing content
    this.readSubagentFromOffset(tailer, metadata);

    // Watch for changes — file might not exist yet, retry with polling
    const tryWatch = () => {
      if (this.stopped) return;
      if (!fs.existsSync(filePath)) {
        // File doesn't exist yet, retry shortly
        setTimeout(tryWatch, 200);
        return;
      }

      try {
        tailer.fileWatcher = fs.watch(filePath, (eventType) => {
          if (this.stopped || eventType !== 'change') return;
          if (tailer.debounceTimer) return;
          tailer.debounceTimer = setTimeout(() => {
            tailer.debounceTimer = null;
            this.readSubagentFromOffset(tailer, metadata);
          }, DEBOUNCE_MS);
        });
        console.log(`[jsonl-watcher] Tailing subagent ${agentId}: ${path.basename(filePath)}`);
        // Read again in case content appeared between our first read and the watch
        this.readSubagentFromOffset(tailer, metadata);
      } catch (err: any) {
        console.warn(`[jsonl-watcher] Cannot watch subagent file ${filePath}:`, err.message);
      }
    };

    tryWatch();
  }

  private readSubagentFromOffset(tailer: SubagentTailer, metadata: SubagentMetadata): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(tailer.filePath);
    } catch {
      return; // File doesn't exist yet
    }

    if (stat.size < tailer.lastReadOffset) {
      tailer.lastReadOffset = 0;
      tailer.lineBuffer = '';
    }

    if (stat.size <= tailer.lastReadOffset) return;

    try {
      const fd = fs.openSync(tailer.filePath, 'r');
      const buf = Buffer.alloc(stat.size - tailer.lastReadOffset);
      fs.readSync(fd, buf, 0, buf.length, tailer.lastReadOffset);
      fs.closeSync(fd);

      tailer.lastReadOffset = stat.size;

      const chunk = tailer.lineBuffer + buf.toString('utf-8');
      const lines = chunk.split('\n');
      tailer.lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          this.emit('event', event, metadata);
        } catch {
          // Skip unparseable lines
        }
      }
    } catch (err: any) {
      console.error(`[jsonl-watcher] Subagent read error (${metadata.agentId}):`, err.message);
    }
  }
}
