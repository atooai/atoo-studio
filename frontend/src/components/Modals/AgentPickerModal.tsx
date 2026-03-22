import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { AgentDescriptor } from '../../types';

interface AgentPickerModalProps {
  onSelect: (agent: AgentDescriptor) => void;
  onClose: () => void;
  /** When resuming a session, pass its original agentType so we can auto-resume or filter */
  resumeAgentType?: string;
}

// Agent types that use the atoo-any chat UI
const ATOO_CHAT_TYPES = new Set(['atoo-any']);
// Terminal-only agent types
const TERMINAL_TYPES = new Set(['claude-code-terminal', 'codex-terminal', 'gemini-terminal']);
// Agent types to hide from the picker (terminal+chat variants)
const HIDDEN_TYPES = new Set(['claude-code-terminal-chatro', 'gemini-cli']);

export function AgentPickerModal({ onSelect, onClose, resumeAgentType }: AgentPickerModalProps) {
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('GET', '/api/available-agents')
      .then((data: AgentDescriptor[]) => {
        setAgents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Auto-resume: if resuming an atoo-any session, select it automatically
  useEffect(() => {
    if (!loading && resumeAgentType && ATOO_CHAT_TYPES.has(resumeAgentType)) {
      const atooAgent = agents.find(a => a.agentType === resumeAgentType);
      if (atooAgent) {
        onSelect(atooAgent);
        return;
      }
    }
  }, [loading, agents, resumeAgentType, onSelect]);

  // If auto-resuming atoo-any, don't render the modal at all
  if (!loading && resumeAgentType && ATOO_CHAT_TYPES.has(resumeAgentType)) {
    return null;
  }

  // Is this a resume of a terminal session? Hide Atoo Chat section
  const isTerminalResume = resumeAgentType && !ATOO_CHAT_TYPES.has(resumeAgentType);

  // Filter agents into categories
  const atooAgent = agents.find(a => ATOO_CHAT_TYPES.has(a.agentType));
  const terminalAgents = agents.filter(a => TERMINAL_TYPES.has(a.agentType));

  return (
    <div className="modal-card agent-picker-modal">
      <div className="modal-header">
        <span>Select Agent</span>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>
      <div className="agent-picker-content">
        {loading ? (
          <div className="agent-picker-loading">Loading agents...</div>
        ) : (
          <>
            {/* Atoo Chat — primary, shown only for new sessions (not terminal resumes) */}
            {!isTerminalResume && atooAgent && (
              <>
                <div className="agent-picker-row agent-picker-primary">
                  <button
                    className="agent-picker-btn agent-picker-btn-large"
                    onClick={() => onSelect(atooAgent)}
                  >
                    <img src={atooAgent.iconUrl} alt={atooAgent.name} className="agent-picker-icon agent-picker-icon-large" />
                    <span className="agent-picker-name">Atoo Chat</span>
                    <span className="agent-picker-mode">Multi-Agent Chat</span>
                  </button>
                </div>
                <div className="agent-picker-separator">
                  <span>Terminal Agents</span>
                </div>
              </>
            )}

            {/* Terminal agents row */}
            <div className="agent-picker-row agent-picker-terminals">
              {terminalAgents.map((agent) => (
                <button
                  key={agent.agentType}
                  className="agent-picker-btn agent-picker-btn-small"
                  onClick={() => onSelect(agent)}
                >
                  <img src={agent.iconUrl} alt={agent.name} className="agent-picker-icon" />
                  <span className="agent-picker-name">{agent.name}</span>
                  <span className="agent-picker-mode">Terminal</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
