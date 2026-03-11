/**
 * Pre-create session files with minimal seed content so the CLI accepts --resume.
 * The CLI is then started with --resume <uuid>, adopting our pre-created UUID.
 * This eliminates hook-based or filesystem-based session UUID discovery.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/**
 * Pre-create a Claude Code session JSONL file with a minimal seed conversation.
 * Claude Code requires at least a user+assistant message pair to accept --resume.
 *
 * @returns The generated session UUID
 */
export function precreateClaudeSession(cwd: string): string {
  const uuid = uuidv4();
  const resolvedCwd = path.resolve(cwd);
  const dirHash = resolvedCwd.replace(/\//g, '-');
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirHash);
  const now = new Date().toISOString();
  const userUuid = uuidv4();
  const assistantUuid = uuidv4();

  const userEvent = JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: resolvedCwd,
    sessionId: uuid,
    type: 'user',
    message: { role: 'user', content: 'Hello from Atoo Studio — Agentic Development Environment!' },
    uuid: userUuid,
    timestamp: now,
    permissionMode: 'bypassPermissions',
  });

  const assistantEvent = JSON.stringify({
    parentUuid: userUuid,
    isSidechain: false,
    userType: 'external',
    cwd: resolvedCwd,
    sessionId: uuid,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello! How can I help you today?' }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    },
    uuid: assistantUuid,
    timestamp: now,
  });

  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${uuid}.jsonl`),
    userEvent + '\n' + assistantEvent + '\n',
    { mode: 0o600 },
  );

  return uuid;
}

/**
 * Pre-create a Codex session JSONL file by cloning the header (session_meta +
 * developer prompt) from the most recent real Codex session and replacing the UUID.
 * Codex requires the real developer prompt (permissions, sandbox config) to accept resume.
 *
 * @returns The generated session UUID
 */
export function precreateCodexSession(cwd: string): string {
  const uuid = uuidv4();
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');

  const dateDir = path.join(CODEX_SESSIONS_DIR, String(year), month, day);
  fs.mkdirSync(dateDir, { recursive: true });

  const filename = `rollout-${timestamp}-${uuid}.jsonl`;
  const targetPath = path.join(dateDir, filename);

  // Find the most recent real Codex session to clone its header from
  const donorFile = findMostRecentCodexSession();
  if (donorFile) {
    // Read the first 2 lines (session_meta + developer prompt) from the donor
    const content = fs.readFileSync(donorFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const headerLines = lines.slice(0, 2);

    // Replace the donor's UUID with our new one in both lines
    const donorUuid = extractCodexUuid(headerLines[0]);
    const newHeader = headerLines
      .map(line => donorUuid ? line.replace(new RegExp(donorUuid, 'g'), uuid) : line)
      .join('\n') + '\n';

    fs.writeFileSync(targetPath, newHeader, { mode: 0o600 });
  } else {
    // No donor session found — write minimal session_meta (may not resume, but won't crash)
    const sessionMeta = JSON.stringify({
      timestamp: now.toISOString(),
      type: 'session_meta',
      payload: {
        id: uuid,
        timestamp: now.toISOString(),
        cwd: path.resolve(cwd),
        originator: 'codex_cli_rs',
        source: 'cli',
        model_provider: 'openai',
        git: {},
      },
    });
    fs.writeFileSync(targetPath, sessionMeta + '\n', { mode: 0o600 });
  }

  return uuid;
}

/** Find the most recently modified Codex session JSONL file. */
export function findMostRecentCodexSession(): string | null {
  try {
    let best: { path: string; mtime: number } | null = null as { path: string; mtime: number } | null;

    // Walk ~/.codex/sessions/YYYY/MM/DD/ directories (most recent first)
    const years = fs.readdirSync(CODEX_SESSIONS_DIR).sort().reverse();
    for (const year of years.slice(0, 2)) {
      const yearDir = path.join(CODEX_SESSIONS_DIR, year);
      const months = fs.readdirSync(yearDir).sort().reverse();
      for (const month of months.slice(0, 2)) {
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir).sort().reverse();
        for (const day of days.slice(0, 3)) {
          const dayDir = path.join(monthDir, day);
          const files = fs.readdirSync(dayDir).filter(f => f.endsWith('.jsonl'));
          for (const f of files) {
            const filePath = path.join(dayDir, f);
            try {
              const stat = fs.statSync(filePath);
              if (!best || stat.mtimeMs > best.mtime) {
                best = { path: filePath, mtime: stat.mtimeMs };
              }
            } catch {}
          }
        }
        if (best) return best.path; // Found recent files, no need to keep searching
      }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

/** Extract the session UUID from a Codex session_meta JSON line. */
function extractCodexUuid(line: string): string | null {
  try {
    const parsed = JSON.parse(line);
    return parsed?.payload?.id ?? null;
  } catch {
    return null;
  }
}
