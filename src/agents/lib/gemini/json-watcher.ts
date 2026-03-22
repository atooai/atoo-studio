/**
 * Watch a Gemini session JSON file for new messages.
 *
 * Unlike the JSONL SimpleFileWatcher (byte-offset tailing), Gemini sessions
 * are single JSON files. This watcher re-parses the full file on change
 * and emits only newly added messages by tracking the message count.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import type { GeminiMessage, GeminiSessionJson } from './json-mapper.js';

const DEBOUNCE_MS = 50;
const POLL_INTERVAL_MS = 200;

export class GeminiJsonWatcher extends EventEmitter {
  private filePath: string;
  private lastMessageCount: number;
  private fileWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string, initialMessageCount: number = 0) {
    super();
    this.filePath = filePath;
    this.lastMessageCount = initialMessageCount;
  }

  start(): void {
    const tryWatch = () => {
      if (this.stopped) return;
      if (!fs.existsSync(this.filePath)) {
        this.pollTimer = setTimeout(tryWatch, POLL_INTERVAL_MS);
        return;
      }
      // Read any messages that appeared since we started
      this.readNewMessages();
      try {
        this.fileWatcher = fs.watch(this.filePath, (eventType) => {
          if (this.stopped || eventType !== 'change') return;
          if (this.debounceTimer) return;
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.readNewMessages();
          }, DEBOUNCE_MS);
        });
      } catch (err: any) {
        console.error(`[gemini-json-watcher] Cannot watch ${this.filePath}:`, err.message);
      }
    };
    tryWatch();
  }

  /** Do a final read to capture any remaining messages. */
  finalRead(): void {
    this.readNewMessages();
  }

  stop(): void {
    this.stopped = true;
    if (this.fileWatcher) { this.fileWatcher.close(); this.fileWatcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private readNewMessages(): void {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const session: GeminiSessionJson = JSON.parse(content);
      const messages = session.messages || [];

      if (messages.length > this.lastMessageCount) {
        const newMessages = messages.slice(this.lastMessageCount);
        this.lastMessageCount = messages.length;

        for (const msg of newMessages) {
          this.emit('message', msg);
        }
      }
    } catch {
      // File may be in the middle of being written — skip this read
    }
  }
}
