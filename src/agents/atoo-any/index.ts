/**
 * AtooAnyAgentFactory — factory for the atoo-any meta-agent.
 * Orchestrates Claude Code and Codex CLI simultaneously.
 */
import type { AgentFactory, Agent, AgentDescriptor, HistoricalSession } from '../types.js';
import type { SessionEvent } from '../../events/types.js';
import { AtooAnyAgent } from './adapter.js';
import { writeForkedClaudeJsonl } from '../lib/claude/jsonl-writer.js';
import {
  scanSessions,
  getSessionFiles,
  ownsSession,
  readAllEvents,
  stripMeta,
} from './session-store.js';
import { db } from '../../state/db.js';

// Use the application's favicon/logo for the atoo-any agent icon

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
    // Get all project paths from the database
    const cwds = this.getProjectCwds();
    return scanSessions(cwds);
  }

  async ownsSession(uuid: string): Promise<boolean> {
    const cwds = this.getProjectCwds();
    return ownsSession(uuid, cwds);
  }

  async getSessionFilesForProject(cwds: string[]): Promise<string[]> {
    return getSessionFiles(cwds);
  }

  async readSessionEvents(uuid: string): Promise<SessionEvent[]> {
    const cwds = this.getProjectCwds();
    for (const cwd of cwds) {
      const filePath = `${cwd}/atoo-studio/atoo-any-sessions/${uuid}.jsonl`;
      const events = readAllEvents(filePath);
      if (events.length > 0) {
        return stripMeta(events);
      }
    }
    return [];
  }

  writeSessionForResume(events: SessionEvent[], targetUuid: string, directory: string): string {
    // Fallback: write as Claude format for cross-family resume
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
