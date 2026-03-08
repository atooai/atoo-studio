import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionEvent } from './state/types.js';

/**
 * Convert an absolute directory path to the Claude project dir hash format.
 * Replaces '/' with '-', e.g. /home/furti/ccproxy → -home-furti-ccproxy
 */
function projectDirHash(directory: string): string {
  return directory.replace(/\//g, '-');
}

/**
 * Extract the UUID portion from a session ID (strip "sess_" prefix).
 */
function sessionUuid(sessionId: string): string {
  return sessionId.replace(/^sess_/, '');
}

/**
 * Write forked session events as a JSONL file to Claude's session storage.
 * Path: ~/.claude/projects/<project-dir-hash>/<session-uuid>.jsonl
 *
 * Rewrites sessionId fields to match the new session, and generates fresh
 * UUIDs for each event while maintaining the parentUuid chain.
 */
export function writeSessionJsonl(session: Session, directory: string): string {
  const dirHash = projectDirHash(path.resolve(directory));
  const projectDir = path.join(os.homedir(), '.claude', 'projects', dirHash);
  const uuid = sessionUuid(session.id);
  const jsonlPath = path.join(projectDir, `${uuid}.jsonl`);

  // Ensure directory exists
  fs.mkdirSync(projectDir, { recursive: true });

  // Build UUID remap: old UUID → new UUID (preserves parentUuid chain)
  const uuidMap = new Map<string, string>();
  for (const event of session.events) {
    if (event.uuid) {
      uuidMap.set(event.uuid, uuidv4());
    }
  }

  const lines: string[] = [];
  for (const event of session.events) {
    const rewritten: any = { ...event };

    // Rewrite sessionId to the new forked session UUID (Claude Code uses camelCase, no "sess_" prefix)
    rewritten.sessionId = uuid;
    // Remove legacy underscore field if present
    delete rewritten.session_id;

    // Rewrite uuid to fresh UUID
    if (rewritten.uuid && uuidMap.has(rewritten.uuid)) {
      rewritten.uuid = uuidMap.get(rewritten.uuid);
    }

    // Rewrite parentUuid chain
    if (rewritten.parentUuid && uuidMap.has(rewritten.parentUuid)) {
      rewritten.parentUuid = uuidMap.get(rewritten.parentUuid);
    }

    lines.push(JSON.stringify(rewritten));
  }

  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  console.log(`[session-writer] Wrote ${lines.length} events to ${jsonlPath}`);
  return jsonlPath;
}
