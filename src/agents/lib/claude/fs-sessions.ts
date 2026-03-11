import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

export interface FsSessionMeta {
  uuid: string;           // Filename UUID (the --resume target)
  dirHash: string;        // e.g., "-home-furti-myproject"
  directory: string;      // Resolved from cwd field in JSONL
  title: string;          // First user message text, truncated
  lastModified: string;   // File mtime (ISO)
  fileSize: number;
  eventCount: number;     // Approximate line count
  jsonlPath: string;      // Full path to the .jsonl file
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_HISTORY_PATH = path.join(os.homedir(), '.claude', 'history.jsonl');
const CACHE_TTL = 30_000; // 30s

/**
 * Load session titles from ~/.claude/history.jsonl.
 * Returns map of sessionId → first display text.
 */
function loadHistoryTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const content = fs.readFileSync(CLAUDE_HISTORY_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && entry.display && !titles.has(entry.sessionId)) {
          const d = entry.display.trim();
          // Skip slash commands and system prompts
          if (d && !d.startsWith('/')) {
            titles.set(entry.sessionId, d.substring(0, 100));
          }
        }
      } catch {}
    }
  } catch {}
  return titles;
}

/**
 * Strip XML/HTML-like tags from text (e.g. <local-command-caveat>...</local-command-caveat>).
 */
function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim();
}

class FsSessionScanner {
  private cache = new Map<string, FsSessionMeta>();
  private lastScanTime = 0;

  async scan(): Promise<FsSessionMeta[]> {
    const now = Date.now();
    if (now - this.lastScanTime < CACHE_TTL && this.cache.size > 0) {
      return Array.from(this.cache.values());
    }

    // Load titles from history.jsonl for better session names
    const historyTitles = loadHistoryTitles();

    const results: FsSessionMeta[] = [];
    try {
      const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
      for (const dirEntry of projectDirs) {
        if (!dirEntry.isDirectory()) continue;
        const dirHash = dirEntry.name;
        const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirHash);
        try {
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const uuid = file.replace('.jsonl', '');
            // Skip non-UUID filenames
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) continue;
            const jsonlPath = path.join(dirPath, file);
            try {
              const meta = await this.parseSessionMeta(jsonlPath, dirHash, uuid, historyTitles);
              if (meta) results.push(meta);
            } catch {
              // Skip unparseable files
            }
          }
        } catch {
          // Skip unreadable directories
        }
      }
    } catch {
      // ~/.claude/projects doesn't exist
    }

    this.cache.clear();
    for (const meta of results) {
      this.cache.set(meta.uuid, meta);
    }
    this.lastScanTime = now;
    return results;
  }

  private async parseSessionMeta(jsonlPath: string, dirHash: string, uuid: string, historyTitles: Map<string, string>): Promise<FsSessionMeta | null> {
    const stat = fs.statSync(jsonlPath);
    if (stat.size === 0) return null;

    let title = '';
    let directory = '';
    let lineCount = 0;
    let bytesRead = 0;
    let hasConversationEvent = false;
    const MAX_LINES = 30;
    const MAX_BYTES = 64 * 1024; // 64KB max for metadata extraction

    return new Promise((resolve) => {
      const stream = fs.createReadStream(jsonlPath, {
        encoding: 'utf-8',
        start: 0,
        end: Math.min(stat.size, MAX_BYTES) - 1,
      });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        lineCount++;
        bytesRead += line.length + 1;

        try {
          const event = JSON.parse(line);

          // Track whether file has real conversation events (not just snapshots)
          if (event.type && event.type !== 'file-history-snapshot') {
            hasConversationEvent = true;
          }

          // Extract cwd from first event that has it
          if (!directory && event.cwd) {
            directory = event.cwd;
          }

          // Extract title from first real user message (skip meta, commands, system tags)
          if (!title && event.type === 'user' && !event.isMeta && event.message?.content) {
            const content = event.message.content;
            let raw = '';
            if (typeof content === 'string') {
              raw = content.trim();
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b: any) => b.type === 'text');
              if (textBlock?.text) raw = textBlock.text.trim();
            }
            // Skip slash commands, XML-tagged system messages, and /remote-control prompt
            if (raw && !raw.startsWith('/') && !raw.startsWith('<') && raw !== 'remote-control') {
              title = raw.substring(0, 100);
            }
          }
        } catch {
          // Skip unparseable lines
        }

        if (lineCount >= MAX_LINES && title && directory) {
          rl.close();
          stream.destroy();
        }
      });

      rl.on('close', () => {
        // Skip files that only contain file-history-snapshot events (ghost files
        // created by Claude CLI on --resume without any actual conversation)
        if (!hasConversationEvent) {
          resolve(null);
          return;
        }

        // Extrapolate event count from partial read
        let eventCount = lineCount;
        if (bytesRead > 0 && bytesRead < stat.size) {
          eventCount = Math.round((stat.size / bytesRead) * lineCount);
        }

        // Fallback directory from dir hash
        if (!directory) {
          directory = dirHashToPath(dirHash);
        }

        // Resolve title: history.jsonl display > stripped user message > 'Untitled'
        const historyTitle = historyTitles.get(uuid);
        const resolvedTitle = historyTitle || (title ? stripXmlTags(title) : '') || 'Untitled';

        resolve({
          uuid,
          dirHash,
          directory,
          title: resolvedTitle,
          lastModified: stat.mtime.toISOString(),
          fileSize: stat.size,
          eventCount,
          jsonlPath,
        });
      });

      rl.on('error', () => resolve(null));
    });
  }

  async readEvents(uuid: string): Promise<any[]> {
    const meta = this.cache.get(uuid);
    if (!meta) return [];

    const content = fs.readFileSync(meta.jsonlPath, 'utf-8');
    const events: any[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        // Skip file-history-snapshot events
        if (event.type === 'file-history-snapshot') continue;

        // Map JSONL fields to SessionEvent format, preserving fields needed
        // for chain building (cwd, parentUuid, version, etc.)
        const mapped: any = {
          uuid: event.uuid,
          parentUuid: event.parentUuid,
          session_id: event.sessionId || event.session_id,
          type: event.type,
          message: event.message,
          timestamp: event.timestamp,
          cwd: event.cwd,
          version: event.version,
          gitBranch: event.gitBranch,
          userType: event.userType,
          isSidechain: event.isSidechain,
          permissionMode: event.permissionMode,
        };

        // Copy optional fields that some event types have
        if (event.subtype) mapped.subtype = event.subtype;
        if (event.data) mapped.data = event.data;
        if (event.content) mapped.content = event.content;
        if (event.toolUseResult) mapped.toolUseResult = event.toolUseResult;
        if (event.hookCount !== undefined) mapped.hookCount = event.hookCount;
        if (event.hookInfos) mapped.hookInfos = event.hookInfos;
        if (event.hookErrors) mapped.hookErrors = event.hookErrors;
        if (event.hasOutput !== undefined) mapped.hasOutput = event.hasOutput;
        if (event.preventedContinuation !== undefined) mapped.preventedContinuation = event.preventedContinuation;
        if (event.level) mapped.level = event.level;
        if (event.toolUseID) mapped.toolUseID = event.toolUseID;

        // Map parentUuid + isSidechain to parent_tool_use_id
        if (event.isSidechain && event.parentUuid) {
          mapped.parent_tool_use_id = event.parentUuid;
        } else {
          mapped.parent_tool_use_id = event.parent_tool_use_id || null;
        }

        events.push(mapped);
      } catch {
        // Skip unparseable lines
      }
    }
    return events;
  }

  getByUuid(uuid: string): FsSessionMeta | undefined {
    return this.cache.get(uuid);
  }

  invalidate(): void {
    this.cache.clear();
    this.lastScanTime = 0;
  }

  /**
   * Find the most recently modified session UUID for a given working directory.
   * Useful as a fallback when hook-based CLI session discovery fails.
   */
  async findMostRecentForCwd(cwd: string): Promise<string | null> {
    await this.scan();
    let best: FsSessionMeta | null = null;
    for (const meta of this.cache.values()) {
      if (meta.directory !== cwd) continue;
      if (!best || new Date(meta.lastModified).getTime() > new Date(best.lastModified).getTime()) {
        best = meta;
      }
    }
    return best?.uuid ?? null;
  }

  /**
   * Return all JSONL file paths (sessions + subagents) for sessions
   * whose working directory matches any of the given cwds.
   */
  async getFilesForProject(cwds: string[]): Promise<string[]> {
    await this.scan();
    const cwdSet = new Set(cwds);

    // Filter matching sessions and sort by lastModified descending (most recent first)
    const matching = Array.from(this.cache.values())
      .filter(meta => cwdSet.has(meta.directory))
      .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    const files: string[] = [];
    const seen = new Set<string>();

    for (const meta of matching) {
      // Add main session file
      if (!seen.has(meta.jsonlPath)) {
        seen.add(meta.jsonlPath);
        files.push(meta.jsonlPath);
      }

      // Add subagent files: <dirHash>/<uuid>/subagents/*.jsonl
      const subagentsDir = path.join(
        path.dirname(meta.jsonlPath),
        meta.uuid,
        'subagents',
      );
      try {
        const entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const subPath = path.join(subagentsDir, entry.name);
            if (!seen.has(subPath)) {
              seen.add(subPath);
              files.push(subPath);
            }
          }
        }
      } catch {
        // No subagents directory
      }
    }
    return files;
  }
}

/**
 * Convert dir hash back to path: "-home-furti-myproject" → "/home/furti/myproject"
 * Validates with fs.existsSync().
 */
function dirHashToPath(dirHash: string): string {
  // Replace leading dash, then remaining dashes with /
  const candidate = '/' + dirHash.replace(/^-/, '').replace(/-/g, '/');
  if (fs.existsSync(candidate)) return candidate;
  return dirHash; // fallback: return as-is
}

export const fsSessionScanner = new FsSessionScanner();
