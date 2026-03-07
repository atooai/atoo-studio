/**
 * JSONL session file discovery and tailing.
 * Watches Claude CLI's session JSONL files for new events in real-time.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DISCOVERY_TIMEOUT = 15_000;
const DEBOUNCE_MS = 50;

/**
 * Convert a cwd path to Claude CLI's dir-hash format.
 * "/home/furti/ccproxy" → "-home-furti-ccproxy"
 */
function cwdToDirHash(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export class JsonlWatcher extends EventEmitter {
  private cwd: string;
  private resumeUuid?: string;
  private dirPath: string;
  private targetPath: string | null = null;
  private lastReadOffset = 0;
  private lineBuffer = '';
  private dirWatcher: fs.FSWatcher | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private preExistingFiles = new Set<string>();

  constructor(options: { cwd: string; resumeUuid?: string }) {
    super();
    this.cwd = options.cwd;
    this.resumeUuid = options.resumeUuid;
    this.dirPath = path.join(CLAUDE_PROJECTS_DIR, cwdToDirHash(this.cwd));
  }

  async start(): Promise<void> {
    if (this.resumeUuid) {
      // Known UUID — wait for that specific file
      this.targetPath = path.join(this.dirPath, `${this.resumeUuid}.jsonl`);
      this.waitForFile(this.targetPath);
    } else {
      // Snapshot existing files, then watch for a new one
      this.snapshotExisting();
      this.watchForNewFile();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
    if (this.fileWatcher) { this.fileWatcher.close(); this.fileWatcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.discoveryTimer) { clearTimeout(this.discoveryTimer); this.discoveryTimer = null; }
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

      // Find the most recently modified file that wasn't pre-existing
      // (or fall back to most recent overall)
      let best: { name: string; mtime: number } | null = null;
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(this.dirPath, f));
          if (!best || stat.mtimeMs > best.mtime) {
            best = { name: f, mtime: stat.mtimeMs };
          }
        } catch {}
      }

      if (best) {
        this.targetPath = path.join(this.dirPath, best.name);
        if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
        console.log(`[jsonl-watcher] Fallback: using most recent file: ${best.name}`);
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
          this.emit('event', event);
        } catch {
          // Skip unparseable lines
        }
      }
    } catch (err: any) {
      console.error('[jsonl-watcher] Read error:', err.message);
    }
  }
}
