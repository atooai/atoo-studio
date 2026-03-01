import React from 'react';
import type { SessionEvent } from '../types/index.js';

interface Props {
  request: SessionEvent;
  onRespond: (requestId: string, approved: boolean) => void;
}

export default function ToolApproval({ request, onRespond }: Props) {
  const requestId = request.request_id || request.response?.request_id || '';
  const subtype = request.request?.subtype || 'unknown';
  const toolName = request.request?.tool_name || request.request?.name || '';
  const input = request.request?.input;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        Tool Approval: <strong>{subtype}</strong>
      </div>
      {toolName && <div style={styles.toolName}>{toolName}</div>}
      {input && (
        <pre style={styles.input}>{JSON.stringify(input, null, 2)}</pre>
      )}
      <div style={styles.buttons}>
        <button
          style={styles.allowBtn}
          onClick={() => onRespond(requestId, true)}
        >
          Allow
        </button>
        <button
          style={styles.denyBtn}
          onClick={() => onRespond(requestId, false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    margin: '8px 0',
    padding: 12,
    background: '#1c2128',
    border: '1px solid #f0883e',
    borderRadius: 8,
  },
  header: { fontSize: 13, color: '#f0883e', marginBottom: 8 },
  toolName: {
    fontFamily: 'monospace',
    fontSize: 13,
    color: '#79c0ff',
    marginBottom: 8,
  },
  input: {
    background: '#0d1117',
    padding: 8,
    borderRadius: 4,
    fontSize: 12,
    overflow: 'auto',
    maxHeight: 200,
    color: '#8b949e',
    marginBottom: 8,
  },
  buttons: { display: 'flex', gap: 8 },
  allowBtn: {
    padding: '4px 16px',
    background: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  denyBtn: {
    padding: '4px 16px',
    background: '#da3633',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
};
