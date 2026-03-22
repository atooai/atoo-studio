/**
 * Gemini CLI session scanner.
 *
 * Scans ~/.gemini/tmp/{project}/chats/session-{id}.json for historical sessions.
 * Session files are single JSON objects (not JSONL).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SessionEvent } from '../../../events/types.js';
import { mapGeminiMessage, type GeminiSessionJson, type GeminiMessage } from './json-mapper.js';

export interface GeminiSessionMeta {
  uuid: string;
  projectId: string;      // e.g., "atoo-studio"
  directory: string;       // Resolved from projects.json
  title: string;
  lastModified: string;
  eventCount: number;      // Number of messages
  jsonPath: string;        // Full path to the JSON file
}

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const PROJECTS_JSON = path.join(GEMINI_DIR, 'projects.json');
const CACHE_TTL = 30_000; // 30s

class GeminiSessionScanner {
  private cache = new Map<string, GeminiSessionMeta>();
  private lastScanTime = 0;
  private projectMap: Record<string, string> = {}; // path → projectId

  async scan(): Promise<GeminiSessionMeta[]> {
    const now = Date.now();
    if (now - this.lastScanTime < CACHE_TTL && this.cache.size > 0) {
      return Array.from(this.cache.values());
    }

    this.loadProjectMap();
    const results: GeminiSessionMeta[] = [];

    try {
      const projectDirs = fs.readdirSync(GEMINI_TMP_DIR, { withFileTypes: true });
      for (const dirEntry of projectDirs) {
        if (!dirEntry.isDirectory()) continue;
        const projectId = dirEntry.name;
        const chatsDir = path.join(GEMINI_TMP_DIR, projectId, 'chats');
        if (!fs.existsSync(chatsDir)) continue;

        try {
          const files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
          for (const file of files) {
            const jsonPath = path.join(chatsDir, file);
            try {
              const meta = this.parseQuickMeta(jsonPath, projectId);
              if (meta) results.push(meta);
            } catch {}
          }
        } catch {}
      }
    } catch {
      // ~/.gemini/tmp doesn't exist
    }

    this.cache.clear();
    for (const meta of results) {
      this.cache.set(meta.uuid, meta);
    }
    this.lastScanTime = now;
    return results;
  }

  private loadProjectMap(): void {
    try {
      const content = fs.readFileSync(PROJECTS_JSON, 'utf-8');
      const data = JSON.parse(content);
      this.projectMap = data.projects || {};
    } catch {
      this.projectMap = {};
    }
  }

  /**
   * Reverse-lookup: projectId → directory path.
   */
  private projectIdToPath(projectId: string): string {
    for (const [dirPath, id] of Object.entries(this.projectMap)) {
      if (id === projectId) return dirPath;
    }
    return projectId; // fallback
  }

  private parseQuickMeta(jsonPath: string, projectId: string): GeminiSessionMeta | null {
    const stat = fs.statSync(jsonPath);
    if (stat.size === 0) return null;

    // Read a limited amount for quick metadata extraction
    const maxBytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(jsonPath, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);

    let content = buf.toString('utf-8');

    // For large files, we may have a truncated JSON. Try parsing the full file if small enough.
    let session: GeminiSessionJson;
    try {
      if (stat.size <= maxBytes) {
        session = JSON.parse(content);
      } else {
        // Quick extraction from partial JSON
        const sessionIdMatch = content.match(/"sessionId"\s*:\s*"([^"]+)"/);
        const sessionId = sessionIdMatch?.[1];
        if (!sessionId) return null;

        // Count messages roughly by finding "type": patterns
        const messageMatches = content.match(/"type"\s*:\s*"(user|gemini)"/g);
        const eventCount = messageMatches?.length || 0;

        // Find first user message text
        let title = 'Gemini Session';
        const userTextMatch = content.match(/"type"\s*:\s*"user"[^}]*"content"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);
        if (userTextMatch) {
          title = userTextMatch[1].substring(0, 100);
        }

        return {
          uuid: sessionId,
          projectId,
          directory: this.projectIdToPath(projectId),
          title,
          lastModified: stat.mtime.toISOString(),
          eventCount,
          jsonPath,
        };
      }
    } catch {
      return null;
    }

    if (!session.sessionId || !session.messages || !Array.isArray(session.messages)) {
      return null;
    }

    // Skip sessions with only system messages
    const hasContent = session.messages.some(m => m.type === 'user' || m.type === 'gemini');
    if (!hasContent) return null;

    // Extract title from first user message
    let title = 'Gemini Session';
    const firstUser = session.messages.find(m => m.type === 'user');
    if (firstUser) {
      const text = Array.isArray(firstUser.content)
        ? firstUser.content.map(c => c.text).join(' ')
        : String(firstUser.content);
      if (text) title = text.substring(0, 100);
    }

    return {
      uuid: session.sessionId,
      projectId,
      directory: this.projectIdToPath(projectId),
      title,
      lastModified: session.lastUpdated || stat.mtime.toISOString(),
      eventCount: session.messages.length,
      jsonPath,
    };
  }

  /**
   * Read all events from a Gemini session, mapped to SessionEvent format.
   */
  async readEvents(uuid: string): Promise<SessionEvent[]> {
    const meta = this.cache.get(uuid);
    if (!meta) {
      // Try scanning first
      await this.scan();
      const fresh = this.cache.get(uuid);
      if (!fresh) return [];
      return this.readEventsFromPath(fresh.jsonPath);
    }
    return this.readEventsFromPath(meta.jsonPath);
  }

  private readEventsFromPath(jsonPath: string): SessionEvent[] {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const session: GeminiSessionJson = JSON.parse(content);
      const events: SessionEvent[] = [];
      for (const msg of session.messages) {
        events.push(...mapGeminiMessage(msg));
      }
      return events;
    } catch {
      return [];
    }
  }

  getByUuid(uuid: string): GeminiSessionMeta | undefined {
    return this.cache.get(uuid);
  }

  invalidate(): void {
    this.cache.clear();
    this.lastScanTime = 0;
  }

  /**
   * Return all session file paths for sessions whose directory matches any of the given cwds.
   */
  async getFilesForProject(cwds: string[]): Promise<string[]> {
    await this.scan();
    const cwdSet = new Set(cwds);
    return Array.from(this.cache.values())
      .filter(meta => cwdSet.has(meta.directory))
      .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
      .map(meta => meta.jsonPath);
  }

  /**
   * Find the session file path for a given UUID by searching all project dirs.
   */
  findSessionPath(uuid: string): string | null {
    // Check cache first
    const cached = this.cache.get(uuid);
    if (cached) return cached.jsonPath;

    // Search filesystem
    const shortId = uuid.slice(0, 8);
    try {
      const projectDirs = fs.readdirSync(GEMINI_TMP_DIR, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const chatsDir = path.join(GEMINI_TMP_DIR, dir.name, 'chats');
        if (!fs.existsSync(chatsDir)) continue;
        try {
          const files = fs.readdirSync(chatsDir);
          const match = files.find(f => f.includes(shortId) && f.endsWith('.json'));
          if (match) return path.join(chatsDir, match);
        } catch {}
      }
    } catch {}
    return null;
  }
}

export const geminiSessionScanner = new GeminiSessionScanner();
