import type { AgentFactory, Agent, AgentDescriptor, HistoricalSession } from '../types.js';
import type { SessionEvent } from '../../events/types.js';
import { GeminiTerminalAgent } from './adapter.js';
import { geminiSessionScanner } from '../lib/gemini/fs-sessions.js';
import { writeForkedGeminiJson } from '../lib/gemini/json-writer.js';

export class GeminiTerminalAgentFactory implements AgentFactory {
  agentType = 'gemini-terminal';
  agentFamily = 'gemini';

  create(sessionId: string): Agent {
    return new GeminiTerminalAgent(sessionId);
  }

  getDescriptor(): AgentDescriptor {
    return {
      agentType: this.agentType,
      agentFamily: this.agentFamily,
      name: 'Gemini',
      mode: 'terminal',
      iconUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16"><path d="M16 8.016A8.522 8.522 0 008.016 16h-.032A8.521 8.521 0 000 8.016v-.032A8.521 8.521 0 007.984 0h.032A8.522 8.522 0 0016 7.984v.032z" fill="url(#g)"/><defs><radialGradient id="g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(16.1326 5.4553 -43.70045 129.2322 1.588 6.503)"><stop offset=".067" stop-color="#9168C0"/><stop offset=".343" stop-color="#5684D1"/><stop offset=".672" stop-color="#1BA1E3"/></radialGradient></defs></svg>')}`,
    };
  }

  async getHistoricalSessions(): Promise<HistoricalSession[]> {
    const sessions = await geminiSessionScanner.scan();
    return sessions.map(s => ({
      id: s.uuid,
      agentType: this.agentType,
      title: s.title,
      directory: s.directory,
      lastModified: s.lastModified,
      eventCount: s.eventCount,
    }));
  }

  async ownsSession(uuid: string): Promise<boolean> {
    if (geminiSessionScanner.getByUuid(uuid)) return true;
    await geminiSessionScanner.scan();
    return !!geminiSessionScanner.getByUuid(uuid);
  }

  async getSessionFilesForProject(cwds: string[]): Promise<string[]> {
    return geminiSessionScanner.getFilesForProject(cwds);
  }

  async readSessionEvents(uuid: string): Promise<SessionEvent[]> {
    return geminiSessionScanner.readEvents(uuid);
  }

  writeSessionForResume(events: SessionEvent[], targetUuid: string, directory: string): string {
    return writeForkedGeminiJson(events, targetUuid, directory);
  }
}
