import React from 'react';
import type { SessionEvent } from '../types/index.js';

interface Props {
  request: SessionEvent;
  onRespond: (requestId: string, approved: boolean) => void;
}

function BashInput({ input }: { input: any }) {
  const command = input?.command || '';
  const description = input?.description || '';
  const timeout = input?.timeout;
  const bgFlag = input?.run_in_background;

  return (
    <div>
      {description && <div style={styles.bashDesc}>{description}</div>}
      <pre style={styles.bashCommand}><span style={styles.bashPrompt}>$ </span>{command}</pre>
      {(timeout || bgFlag) && (
        <div style={styles.bashMeta}>
          {bgFlag && <span style={styles.bashTag}>background</span>}
          {timeout && <span style={styles.bashTag}>timeout: {timeout}ms</span>}
        </div>
      )}
    </div>
  );
}

function GenericInput({ input, toolName }: { input: any; toolName: string }) {
  // For tools with a primary field, show it prominently
  const primaryFields: Record<string, string[]> = {
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    Glob: ['pattern', 'path'],
    Grep: ['pattern', 'path'],
    WebFetch: ['url'],
    WebSearch: ['query'],
  };

  const primaries = primaryFields[toolName] || [];
  const primaryEntries: [string, any][] = [];
  const otherEntries: [string, any][] = [];

  for (const [k, v] of Object.entries(input || {})) {
    if (primaries.includes(k)) {
      primaryEntries.push([k, v]);
    } else {
      otherEntries.push([k, v]);
    }
  }

  if (primaryEntries.length === 0) {
    return <pre style={styles.input}>{JSON.stringify(input, null, 2)}</pre>;
  }

  return (
    <div>
      {primaryEntries.map(([k, v]) => (
        <div key={k} style={styles.primaryField}>
          <span style={styles.primaryLabel}>{k}: </span>
          <span style={styles.primaryValue}>{String(v)}</span>
        </div>
      ))}
      {otherEntries.length > 0 && (
        <details style={styles.otherParams}>
          <summary style={styles.otherParamsSummary}>
            {otherEntries.length} more param{otherEntries.length !== 1 ? 's' : ''}
          </summary>
          <pre style={styles.input}>{JSON.stringify(Object.fromEntries(otherEntries), null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export default function ToolApproval({ request, onRespond }: Props) {
  const requestId = request.request_id || request.response?.request_id || '';
  const toolName = request.request?.tool_name || request.request?.name || '';
  const input = request.request?.input;

  const isBash = toolName === 'Bash';

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerIcon}>{isBash ? '>' : '\u26A0'}</span>
        <span style={styles.toolName}>{toolName || 'Tool'}</span>
      </div>
      {input && (
        isBash
          ? <BashInput input={input} />
          : <GenericInput input={input} toolName={toolName} />
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
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  headerIcon: {
    fontSize: 14,
    color: '#f0883e',
    fontFamily: 'monospace',
    fontWeight: 700,
  },
  toolName: {
    fontFamily: 'monospace',
    fontSize: 14,
    color: '#79c0ff',
    fontWeight: 600,
  },
  bashDesc: {
    fontSize: 12,
    color: '#8b949e',
    marginBottom: 6,
  },
  bashCommand: {
    background: '#0d1117',
    padding: '8px 10px',
    borderRadius: 4,
    fontSize: 13,
    color: '#e6edf3',
    overflow: 'auto',
    maxHeight: 200,
    marginBottom: 8,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    lineHeight: 1.5,
  },
  bashPrompt: {
    color: '#3fb950',
    userSelect: 'none',
  },
  bashMeta: {
    display: 'flex',
    gap: 6,
    marginBottom: 8,
  },
  bashTag: {
    fontSize: 10,
    color: '#8b949e',
    background: '#21262d',
    padding: '1px 6px',
    borderRadius: 4,
  },
  primaryField: {
    background: '#0d1117',
    padding: '6px 10px',
    borderRadius: 4,
    marginBottom: 4,
    fontSize: 13,
    fontFamily: 'monospace',
    overflow: 'auto',
  },
  primaryLabel: {
    color: '#8b949e',
    fontSize: 11,
  },
  primaryValue: {
    color: '#e6edf3',
  },
  otherParams: {
    marginBottom: 8,
  },
  otherParamsSummary: {
    fontSize: 11,
    color: '#484f58',
    cursor: 'pointer',
    marginBottom: 4,
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
