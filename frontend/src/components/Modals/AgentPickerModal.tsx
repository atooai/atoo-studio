import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { AgentDescriptor } from '../../types';

interface AgentPickerModalProps {
  onSelect: (agent: AgentDescriptor) => void;
  onClose: () => void;
}

export function AgentPickerModal({ onSelect, onClose }: AgentPickerModalProps) {
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

  const modeLabel = (mode: string) => {
    switch (mode) {
      case 'terminal': return 'Terminal';
      case 'chat': return 'Chat';
      case 'terminal+chat': return 'Terminal + Chat';
      case 'terminal+chatRO': return 'Terminal + Chat RO';
      default: return mode;
    }
  };

  // Hardcoded coming-soon agents
  const comingSoonAgents = [
    { name: 'Gemini CLI', iconUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4285F4"/><stop offset="50%" stop-color="#9B72CB"/><stop offset="100%" stop-color="#D96570"/></linearGradient></defs><circle cx="16" cy="16" r="14" fill="#1a1a2e"/><path d="M16 4 C16 4 24 10 24 16 C24 22 16 28 16 28 C16 28 8 22 8 16 C8 10 16 4 16 4Z" fill="url(#g)" opacity="0.9"/></svg>') },
  ];

  // If auto-selected (single agent) and no coming-soon agents, don't render anything
  if (!loading && agents.length <= 1 && comingSoonAgents.length === 0) return null;

  return (
    <div className="modal-card agent-picker-modal">
      <div className="modal-header">
        <span>Select Agent</span>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>
      <div className="agent-picker-grid">
        {loading ? (
          <div className="agent-picker-loading">Loading agents...</div>
        ) : (
          <>
            {agents.map((agent) => (
              <button
                key={agent.agentType}
                className="agent-picker-btn"
                onClick={() => onSelect(agent)}
              >
                <img src={agent.iconUrl} alt={agent.name} className="agent-picker-icon" />
                <span className="agent-picker-name">{agent.name}</span>
                <span className="agent-picker-mode">{modeLabel(agent.mode)}</span>
              </button>
            ))}
            {comingSoonAgents.map((agent) => (
              <button
                key={agent.name}
                className="agent-picker-btn agent-picker-btn-disabled"
                disabled
              >
                <img src={agent.iconUrl} alt={agent.name} className="agent-picker-icon" />
                <span className="agent-picker-name">{agent.name}</span>
                <span className="agent-picker-coming-soon">Coming soon</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
