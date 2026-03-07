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
        // Auto-select if only one agent
        if (data.length === 1) {
          onSelect(data[0]);
        }
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

  // If auto-selected (single agent), don't render anything
  if (!loading && agents.length <= 1) return null;

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
          agents.map((agent) => (
            <button
              key={agent.agentType}
              className="agent-picker-btn"
              onClick={() => onSelect(agent)}
            >
              <img src={agent.iconUrl} alt={agent.name} className="agent-picker-icon" />
              <span className="agent-picker-name">{agent.name}</span>
              <span className="agent-picker-mode">{modeLabel(agent.mode)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
