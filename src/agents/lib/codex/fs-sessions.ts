/**
 * Scan ~/.codex/sessions/ for Codex session metadata.
 *
 * Codex stores sessions at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
 *
 * The UUID is extracted from the filename.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { mapCodexJsonlLine } from './jsonl-mapper.js';
import type { SessionEvent } from '../../../events/types.js';

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CACHE_TTL = 30_000;

export interface CodexSessionMeta {
  uuid: string;
  directory: string;     // cwd from session_meta
  title: string;         // First user message
  lastModified: string;  // File mtime
  fileSize: number;
  eventCount: number;
  jsonlPath: string;
}

/**
 * Extract UUID from Codex session filename.
 * "rollout-2026-03-08T14-42-42-019ccdaf-9532-7b01-a95d-120dfe13ec7c.jsonl"
 * → "019ccdaf-9532-7b01-a95d-120dfe13ec7c"
 */
function extractUuidFromFilename(filename: string): string | null {
  // UUID is at the end of the filename before .jsonl
  // Pattern: rollout-{datetime}-{uuid}.jsonl where uuid has 5 groups
  const match = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return match ? match[1] : null;
}

class CodexSessionScanner {
  private cache = new Map<string, CodexSessionMeta>();
  private lastScanTime = 0;

  async scan(): Promise<CodexSessionMeta[]> {
    const now = Date.now();
    if (now - this.lastScanTime < CACHE_TTL && this.cache.size > 0) {
      return Array.from(this.cache.values());
    }

    const results: CodexSessionMeta[] = [];
    try {
      // Walk ~/.codex/sessions/YYYY/MM/DD/
      this.walkSessionDirs(CODEX_SESSIONS_DIR, results);
    } catch {
      // ~/.codex/sessions doesn't exist
    }

    this.cache.clear();
    for (const meta of results) {
      this.cache.set(meta.uuid, meta);
    }
    this.lastScanTime = now;
    return results;
  }

  private walkSessionDirs(baseDir: string, results: CodexSessionMeta[]): void {
    let yearDirs: string[];
    try {
      yearDirs = fs.readdirSync(baseDir);
    } catch { return; }

    for (const year of yearDirs) {
      const yearPath = path.join(baseDir, year);
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
            if (!file.endsWith('.jsonl')) continue;
            const uuid = extractUuidFromFilename(file);
            if (!uuid) continue;

            const jsonlPath = path.join(dayPath, file);
            try {
              const stat = fs.statSync(jsonlPath);
              if (stat.size === 0) continue;

              // Parse first few lines for metadata
              const meta = this.parseQuickMeta(jsonlPath, uuid, stat);
              if (meta) results.push(meta);
            } catch { /* skip */ }
          }
        }
      }
    }
  }

  private parseQuickMeta(jsonlPath: string, uuid: string, stat: fs.Stats): CodexSessionMeta | null {
    // Read first 32KB for quick metadata extraction
    const maxBytes = Math.min(stat.size, 32 * 1024);
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(jsonlPath, 'r');
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);

    const chunk = buf.toString('utf-8');
    const lines = chunk.split('\n');

    let directory = '';
    let title = '';
    let lineCount = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      lineCount++;
      try {
        const parsed = JSON.parse(line);

        // Extract cwd from session_meta
        if (parsed.type === 'session_meta' && parsed.payload?.cwd) {
          directory = parsed.payload.cwd;
        }

        // Extract first user message as title
        if (!title && parsed.type === 'event_msg' && parsed.payload?.type === 'user_message') {
          title = (parsed.payload.message || '').substring(0, 100);
        }
      } catch { /* skip */ }

      if (directory && title) break;
    }

    if (!directory) return null;

    // Extrapolate event count
    const bytesRead = chunk.length;
    let eventCount = lineCount;
    if (bytesRead > 0 && bytesRead < stat.size) {
      eventCount = Math.round((stat.size / bytesRead) * lineCount);
    }

    return {
      uuid,
      directory,
      title: title || 'Untitled',
      lastModified: stat.mtime.toISOString(),
      fileSize: stat.size,
      eventCount,
      jsonlPath,
    };
  }

  /**
   * Read all events from a Codex session, converting to SessionEvent[].
   */
  async readEvents(uuid: string): Promise<SessionEvent[]> {
    const meta = this.cache.get(uuid);
    if (!meta) return [];

    const content = fs.readFileSync(meta.jsonlPath, 'utf-8');
    const events: SessionEvent[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const mapped = mapCodexJsonlLine(parsed);
        events.push(...mapped);
      } catch { /* skip */ }
    }

    return events;
  }

  getByUuid(uuid: string): CodexSessionMeta | undefined {
    return this.cache.get(uuid);
  }

  invalidate(): void {
    this.cache.clear();
    this.lastScanTime = 0;
  }

  /**
   * Find the JSONL file path for a given session UUID.
   */
  findSessionFile(uuid: string): string | null {
    const meta = this.cache.get(uuid);
    if (meta) return meta.jsonlPath;

    // Walk the directory to find it
    try {
      return this.findFileByUuid(CODEX_SESSIONS_DIR, uuid);
    } catch {
      return null;
    }
  }

  private findFileByUuid(baseDir: string, uuid: string): string | null {
    let yearDirs: string[];
    try { yearDirs = fs.readdirSync(baseDir); } catch { return null; }

    for (const year of yearDirs) {
      const yearPath = path.join(baseDir, year);
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
    return null;
  }

  /**
   * Return JSONL file paths for sessions matching the given cwds.
   */
  async getFilesForProject(cwds: string[]): Promise<string[]> {
    await this.scan();
    const cwdSet = new Set(cwds);

    return Array.from(this.cache.values())
      .filter(meta => cwdSet.has(meta.directory))
      .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
      .map(meta => meta.jsonlPath);
  }
}

export const codexSessionScanner = new CodexSessionScanner();
