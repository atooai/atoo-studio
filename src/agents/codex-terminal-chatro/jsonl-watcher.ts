/**
 * JSONL session file tailer for Codex CLI.
 *
 * Codex stores sessions at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
 *
 * Session discovery is handled by the notify callback (notify.ts).
 * This watcher only tails a known file by UUID.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mapCodexJsonlLine } from '../lib/codex/jsonl-mapper.js';
import type { SessionEvent } from '../../events/types.js';

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const DEBOUNCE_MS = 50;
const FILE_WAIT_INTERVAL = 200;
const FILE_WAIT_TIMEOUT = 30_000;

export class CodexJsonlWatcher extends EventEmitter {
  private targetPath: string | null = null;
  private lastReadOffset = 0;
  private lineBuffer = '';
  private fileWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private initialOffset = 0;

  /**
   * Set the initial read offset to skip content already loaded historically.
   * Must be called before startTailingUuid().
   */
  setInitialOffset(bytes: number): void {
    this.initialOffset = bytes;
  }

  /**
   * Start tailing the session file for a known UUID.
   * Finds the file on disk, waits for it to appear if needed, then tails.
   */
  startTailingUuid(uuid: string): void {
    const filePath = this.findFileByUuid(uuid);
    if (filePath) {
      this.targetPath = filePath;
      this.beginTailing();
    } else {
      // File doesn't exist yet — poll until it appears
      console.log(`[codex-jsonl-watcher] Waiting for session file for ${uuid}...`);
      const startTime = Date.now();
      this.waitTimer = setInterval(() => {
        if (this.stopped) { this.clearWaitTimer(); return; }
        const found = this.findFileByUuid(uuid);
        if (found) {
          this.clearWaitTimer();
          this.targetPath = found;
          console.log(`[codex-jsonl-watcher] Found session file: ${path.basename(found)}`);
          this.beginTailing();
        } else if (Date.now() - startTime > FILE_WAIT_TIMEOUT) {
          this.clearWaitTimer();
          console.warn(`[codex-jsonl-watcher] Timed out waiting for session file for ${uuid}`);
        }
      }, FILE_WAIT_INTERVAL);
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearWaitTimer();
    if (this.fileWatcher) { this.fileWatcher.close(); this.fileWatcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
  }

  private findFileByUuid(uuid: string): string | null {
    try {
      const yearDirs = fs.readdirSync(CODEX_SESSIONS_DIR);
      for (const year of yearDirs) {
        const yearPath = path.join(CODEX_SESSIONS_DIR, year);
        let monthDirs: string[];
        try { monthDirs = fs.readdirSync(yearPath); } catch { continue; }

        for (const month of monthDirs) {
          const monthPath = path.join(yearPath, month);
          let dayDirs: string[];
          try { dayDirs = fs.readdirSync(monthPath); } catch { continue; }

          for (const day of dayDirs) {
            const dayPath = path.join(monthPath, day);
            let files: string[];
            try { files = fs.readdirSync(dayPath); } catch { continue; }

            for (const file of files) {
              if (file.includes(uuid) && file.endsWith('.jsonl')) {
                return path.join(dayPath, file);
              }
            }
          }
        }
      }
    } catch {}
    return null;
  }

  private beginTailing(): void {
    if (this.stopped || !this.targetPath) return;

    // Skip content already loaded by historical pre-load
    if (this.initialOffset > 0) {
      this.lastReadOffset = this.initialOffset;
      this.initialOffset = 0;
    }

    // Read any new content since the offset
    this.readFromOffset();

    // Watch for future changes
    try {
      this.fileWatcher = fs.watch(this.targetPath, (eventType) => {
        if (this.stopped || eventType !== 'change') return;
        this.debouncedRead();
      });
      this.emit('ready');
    } catch (err: any) {
      console.error(`[codex-jsonl-watcher] Cannot watch file ${this.targetPath}:`, err.message);
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
    } catch { return; }

    if (stat.size < this.lastReadOffset) {
      console.warn('[codex-jsonl-watcher] File truncated, re-reading from start');
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
      this.lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const events = mapCodexJsonlLine(parsed);
          for (const event of events) {
            this.emit('event', event);
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch (err: any) {
      console.error('[codex-jsonl-watcher] Read error:', err.message);
    }
  }
}
