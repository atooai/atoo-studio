/**
 * AtooAnyAgentFactory v2 — uses normalized session schema.
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { AgentFactory, Agent, AgentDescriptor, HistoricalSession } from '../types.js';
import type { SessionEvent } from '../../events/types.js';
import { AtooAnyAgent } from './adapter.js';
import { writeForkedClaudeJsonl } from '../lib/claude/jsonl-writer.js';
import {
  scanSessionDirs,
  ownsSession,
  readSession,
  readPromptEvents,
  walkActivePath,
  getSessionDir,
} from './session-store.js';
import { db } from '../../state/db.js';

export class AtooAnyAgentFactory implements AgentFactory {
  agentType = 'atoo-any';
  agentFamily = 'atoo';

  create(sessionId: string): Agent {
    return new AtooAnyAgent(sessionId);
  }

  getDescriptor(): AgentDescriptor {
    return {
      agentType: this.agentType,
      agentFamily: this.agentFamily,
      name: 'Atoo Any',
      mode: 'chat',
      iconUrl: '/logo_64x64.png',
    };
  }

  async getHistoricalSessions(): Promise<HistoricalSession[]> {
    const cwds = this.getProjectCwds();
    return scanSessionDirs(cwds);
  }

  async ownsSession(uuid: string): Promise<boolean> {
    const cwds = this.getProjectCwds();
    return ownsSession(uuid, cwds);
  }

  async getSessionFilesForProject(cwds: string[]): Promise<string[]> {
    // Return session.json paths for search indexing
    const files: string[] = [];
    for (const cwd of cwds) {
      const sessionsDir = `${cwd}/.atoo-studio/atoo-any-sessions`;
      try {
        const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const jsonPath = `${sessionsDir}/${entry.name}/session.json`;
            if (fs.existsSync(jsonPath)) {
              files.push(jsonPath);
              // Also include all prompt JSONL files
              const promptsDir = `${sessionsDir}/${entry.name}/prompts`;
              try {
                for (const f of fs.readdirSync(promptsDir)) {
                  if (f.endsWith('.jsonl')) files.push(`${promptsDir}/${f}`);
                }
              } catch {}
            }
          }
        }
      } catch {}
    }
    return files;
  }

  async readSessionEvents(uuid: string): Promise<SessionEvent[]> {
    const cwds = this.getProjectCwds();
    for (const cwd of cwds) {
      const sessionDir = getSessionDir(cwd, uuid);
      const session = (() => { try { return readSession(sessionDir); } catch { return null; } })();
      if (!session) continue;

      // Flatten tree to SessionEvents for cross-family resume
      const result: SessionEvent[] = [];
      const activePath = Object.values(session.clientState)[0]?.activePath ?? [];
      const nodes = walkActivePath(session.tree, activePath);

      for (const node of nodes) {
        const prompt = session.prompts[node.uuid];
        if (!prompt) continue;
        const events = readPromptEvents(sessionDir, node.uuid);

        const promptEvent = events.find(e => e.type === 'prompt');
        if (promptEvent?.type === 'prompt') {
          result.push({
            type: 'user',
            uuid: node.uuid,
            timestamp: prompt.startedAt,
            message: { role: 'user', content: promptEvent.message },
          });
        }

        for (const event of events) {
          if (event.type !== 'run_msg') continue;
          const rm = event as any;
          if (rm.role === 'assistant' && rm.content) {
            result.push({
              type: 'assistant',
              uuid: uuidv4(),
              timestamp: prompt.startedAt,
              message: { role: 'assistant', content: [rm.content] },
            });
          }
        }
      }

      if (result.length > 0) return result;
    }
    return [];
  }

  writeSessionForResume(events: SessionEvent[], targetUuid: string, directory: string): string {
    return writeForkedClaudeJsonl(events, targetUuid, directory);
  }

  private getProjectCwds(): string[] {
    try {
      const projects = db.listAllProjects();
      return projects.map((p: any) => p.path);
    } catch {
      return [];
    }
  }
}
