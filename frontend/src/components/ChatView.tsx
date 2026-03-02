import React, { useRef, useEffect, useState, useMemo } from 'react';
import Markdown from 'react-markdown';
import { sendMessage, forkSession } from '../api/client.js';
import { useSessionWebSocket } from '../hooks/useWebSocket.js';
import ToolApproval from './ToolApproval.js';
import UserQuestion from './UserQuestion.js';
import TurnChanges from './TurnChanges.js';
import TerminalView from './TerminalView.js';
import type { SessionEvent } from '../types/index.js';
import '../markdown.css';

interface Props {
  sessionId: string;
  onSelectSession?: (id: string) => void;
  parentSessionId?: string | null;
  parentTitle?: string | null;
  forkAfterEventUuid?: string | null;
}

export default function ChatView({ sessionId, onSelectSession, parentSessionId, parentTitle, forkAfterEventUuid }: Props) {
  const { events, connected, agentStatus, meta, sendControlResponse, sendControlRequest } = useSessionWebSocket(sessionId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [forkingAtUuid, setForkingAtUuid] = useState<string | null>(null);
  const [forkMessage, setForkMessage] = useState('');
  const [forking, setForking] = useState(false);
  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(sessionId, input.trim());
      setInput('');
    } finally {
      setSending(false);
    }
  };

  const handleFork = async (afterEventUuid: string) => {
    setForking(true);
    try {
      const result = await forkSession(sessionId, afterEventUuid, forkMessage.trim() || undefined);
      setForkingAtUuid(null);
      setForkMessage('');
      if (onSelectSession) onSelectSession(result.id);
    } catch (err: any) {
      alert(`Fork failed: ${err.message}`);
    } finally {
      setForking(false);
    }
  };

  // Check if a control_request has been responded to
  const respondedRequests = new Set(
    events
      .filter((e) => e.type === 'control_response')
      .map((e) => e.response?.request_id)
      .filter(Boolean)
  );

  // Compute turn boundaries: indices of user messages (top-level, non-tool-result)
  const turnBoundaries = useMemo(() => {
    const boundaries: { startTime: number; endTime: number; insertAfterIndex: number }[] = [];
    const userEventIndices: number[] = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'user' && !e.parent_tool_use_id) {
        const content = e.message?.content;
        if (Array.isArray(content) && content.every((item: any) => item.type === 'tool_result')) continue;
        // Skip synthetic/command messages from turn boundary detection
        const text = typeof content === 'string' ? content : '';
        if (text.includes('<local-command-caveat>') || text.includes('<command-name>') || text.includes('<local-command-stdout>')) continue;
        userEventIndices.push(i);
      }
    }

    // Each turn is between user messages. Insert TurnChanges before each subsequent user message.
    for (let j = 1; j < userEventIndices.length; j++) {
      const prevUserIdx = userEventIndices[j - 1];
      const nextUserIdx = userEventIndices[j];
      // Use _receivedAt (epoch seconds stamped on arrival) for turn boundaries
      const startTime = events[prevUserIdx]?._receivedAt || 0;
      const endTime = events[nextUserIdx]?._receivedAt || (Date.now() / 1000);
      boundaries.push({ startTime, endTime, insertAfterIndex: nextUserIdx - 1 });
    }

    // If agent is idle after the last user message, add a boundary for the current turn
    if (userEventIndices.length > 0 && agentStatus === 'idle') {
      const lastIdx = userEventIndices[userEventIndices.length - 1];
      const startTime = events[lastIdx]?._receivedAt || 0;
      boundaries.push({ startTime, endTime: Date.now() / 1000, insertAfterIndex: events.length - 1 });
    }

    return boundaries;
  }, [events, agentStatus]);

  // Filter to visible events (ones that render something) for fork dividers
  const visibleEvents = events.filter((e) => {
    if (e.type === 'system' || e.type === 'keep_alive' || e.type === 'control_response') return false;
    if (e.type === 'control_request' && e.request?.subtype !== 'can_use_tool') return false;
    if (e.type === 'user') {
      const content = e.message?.content;
      if (Array.isArray(content) && content.every((item: any) => item.type === 'tool_result')) return false;
      if (e.parent_tool_use_id) return false;
      // Hide caveat messages from fork divider tracking
      const text = typeof content === 'string' ? content : '';
      if (text.includes('<local-command-caveat>')) return false;
    }
    if (e.type === 'assistant' && e.parent_tool_use_id) return false;
    if (e.type === 'result' && e.parent_tool_use_id) return false;
    return true;
  });

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.viewTabs}>
            <button
              style={{
                ...styles.viewTab,
                ...(viewMode === 'chat' ? styles.viewTabActive : {}),
              }}
              onClick={() => setViewMode('chat')}
            >
              Chat
            </button>
            <button
              style={{
                ...styles.viewTab,
                ...(viewMode === 'terminal' ? styles.viewTabActive : {}),
              }}
              onClick={() => setViewMode('terminal')}
            >
              Terminal
            </button>
          </div>
          <span style={styles.sessionId}>{sessionId}</span>
        </div>
        <span style={{ ...styles.status, color: connected ? '#3fb950' : '#8b949e' }}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: viewMode === 'terminal' ? 'flex' : 'none' }}>
        <TerminalView sessionId={sessionId} />
      </div>

      <div style={{ ...styles.messages, display: viewMode === 'chat' ? 'block' : 'none' }}>
        {/* Fork point indicator for forked sessions */}
        {parentSessionId && (
          <div style={styles.forkIndicator}>
            <span style={styles.forkIndicatorLine} />
            <span
              style={styles.forkIndicatorText}
              onClick={() => onSelectSession?.(parentSessionId)}
            >
              Forked from {parentTitle || parentSessionId} &#8599;
            </span>
            <span style={styles.forkIndicatorLine} />
          </div>
        )}

        {events.map((event, i) => {
          const rendered = (
            <EventMessage
              key={i}
              event={event}
              allEvents={events}
              respondedRequests={respondedRequests}
              onControlRespond={sendControlResponse}
            />
          );

          // Check if a TurnChanges widget should be inserted after this event
          const turnBoundary = turnBoundaries.find(b => b.insertAfterIndex === i);

          // Add fork divider after visible events
          const isVisible = visibleEvents.includes(event);
          const eventUuid = event.uuid;

          if (!isVisible || !eventUuid) {
            return (
              <React.Fragment key={i}>
                {rendered}
                {turnBoundary && (
                  <TurnChanges
                    sessionId={sessionId}
                    startTime={turnBoundary.startTime}
                    endTime={turnBoundary.endTime}
                  />
                )}
              </React.Fragment>
            );
          }

          return (
            <React.Fragment key={i}>
              {rendered}
              {turnBoundary && (
                <TurnChanges
                  sessionId={sessionId}
                  startTime={turnBoundary.startTime}
                  endTime={turnBoundary.endTime}
                />
              )}
              <ForkDivider
                eventUuid={eventUuid}
                isOpen={forkingAtUuid === eventUuid}
                forkMessage={forkingAtUuid === eventUuid ? forkMessage : ''}
                forking={forking}
                onToggle={() => {
                  if (forkingAtUuid === eventUuid) {
                    setForkingAtUuid(null);
                    setForkMessage('');
                  } else {
                    setForkingAtUuid(eventUuid);
                    setForkMessage('');
                  }
                }}
                onMessageChange={setForkMessage}
                onFork={() => handleFork(eventUuid)}
                onCancel={() => { setForkingAtUuid(null); setForkMessage(''); }}
              />
            </React.Fragment>
          );
        })}

        {agentStatus === 'active' && (
          <div style={styles.typingIndicator}>
            <span className="typing-dots">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
            <span style={styles.typingText}>Claude is working...</span>
          </div>
        )}
        {agentStatus === 'waiting' && (
          <div style={{ ...styles.typingIndicator, borderLeftColor: '#f0883e' }}>
            <span style={{ ...styles.typingText, color: '#f0883e' }}>Waiting for approval...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div style={{ ...styles.inputArea, display: viewMode === 'chat' ? 'block' : 'none' }}>
        <div style={styles.inputRow}>
          <textarea
            style={styles.textarea}
            placeholder="Send a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={3}
          />
          <button style={styles.sendBtn} onClick={handleSend} disabled={sending}>
            Send
          </button>
        </div>
        <div style={styles.controlsRow}>
          <label style={styles.controlLabel}>
            <span style={styles.controlLabelText}>Mode</span>
            <select
              style={styles.controlSelect}
              value={meta.permissionMode || 'default'}
              onChange={(e) => sendControlRequest('set_permission_mode', { mode: e.target.value })}
            >
              <option value="default">Always Ask</option>
              <option value="acceptEdits">Accept Edits</option>
              <option value="plan">Plan Mode</option>
              <option value="dontAsk">Don't Ask</option>
              <option value="bypassPermissions">Bypass Permissions</option>
            </select>
          </label>
          <label style={styles.controlLabel}>
            <span style={styles.controlLabelText}>Model</span>
            {meta.models.length > 0 ? (
              <select
                style={styles.controlSelect}
                value={meta.model || ''}
                onChange={(e) => sendControlRequest('set_model', { model: e.target.value })}
              >
                {meta.models.map((m) => (
                  <option key={m.value} value={m.value}>{m.displayName}</option>
                ))}
              </select>
            ) : (
              <select
                style={styles.controlSelect}
                value={meta.model || ''}
                onChange={(e) => sendControlRequest('set_model', { model: e.target.value })}
              >
                {meta.model ? (
                  <option value={meta.model}>{meta.model}</option>
                ) : (
                  <option value="">--</option>
                )}
                <option value="claude-opus-4-6">Opus 4.6</option>
                <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
                <option value="default">Default</option>
              </select>
            )}
          </label>
        </div>
      </div>
    </div>
  );
}

function ForkDivider({ eventUuid, isOpen, forkMessage, forking, onToggle, onMessageChange, onFork, onCancel }: {
  eventUuid: string;
  isOpen: boolean;
  forkMessage: string;
  forking: boolean;
  onToggle: () => void;
  onMessageChange: (msg: string) => void;
  onFork: () => void;
  onCancel: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={styles.forkDividerContainer}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={styles.forkDividerLine}>
        {(hovered || isOpen) && (
          <button
            style={{
              ...styles.forkBtn,
              opacity: isOpen ? 1 : 0.7,
            }}
            onClick={onToggle}
            title="Fork conversation here"
          >
            &#9986; Fork
          </button>
        )}
      </div>
      {isOpen && (
        <div style={styles.forkDialog}>
          <textarea
            style={styles.forkDialogTextarea}
            placeholder="Optional: message to send in forked session..."
            value={forkMessage}
            onChange={(e) => onMessageChange(e.target.value)}
            rows={2}
            disabled={forking}
          />
          <div style={styles.forkDialogActions}>
            <button style={styles.forkDialogCancel} onClick={onCancel} disabled={forking}>Cancel</button>
            <button style={styles.forkDialogConfirm} onClick={onFork} disabled={forking}>
              {forking ? 'Forking...' : 'Fork'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Strip ANSI escape codes from terminal output
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '');
}

// Parse special user message formats (slash commands, command output, caveats)
type ParsedUserContent =
  | { type: 'caveat' }
  | { type: 'command'; name: string; args: string }
  | { type: 'command-output'; text: string }
  | { type: 'normal'; text: string };

function parseUserContent(text: string): ParsedUserContent {
  if (text.includes('<local-command-caveat>')) {
    return { type: 'caveat' };
  }
  const cmdMatch = text.match(/<command-name>(.*?)<\/command-name>/);
  if (cmdMatch) {
    const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return { type: 'command', name: cmdMatch[1], args: argsMatch?.[1]?.trim() || '' };
  }
  const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*)<\/local-command-stdout>/);
  if (stdoutMatch) {
    return { type: 'command-output', text: stripAnsi(stdoutMatch[1]).trim() };
  }
  return { type: 'normal', text };
}

function RawJson({ data }: { data: any }) {
  return (
    <details style={styles.rawJson}>
      <summary style={styles.rawJsonToggle}>raw</summary>
      <pre style={styles.rawJsonContent}>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

// Find the matching tool_result for a tool_use id
function findToolResult(allEvents: SessionEvent[], toolUseId: string): any | null {
  for (const ev of allEvents) {
    if (ev.type !== 'user' || !Array.isArray(ev.message?.content)) continue;
    for (const item of ev.message.content) {
      if (item.type === 'tool_result' && item.tool_use_id === toolUseId) return item;
    }
  }
  return null;
}

// Find child events (sub-agent inputs/outputs) for a tool_use id
function findChildEvents(allEvents: SessionEvent[], toolUseId: string): SessionEvent[] {
  return allEvents.filter((ev) => ev.parent_tool_use_id === toolUseId);
}

function formatToolError(text: string): string | null {
  if (text.includes('<tool_use_error>Sibling tool call errored</tool_use_error>')) {
    return 'Cancelled: a sibling tool call in this batch failed';
  }
  if (text.includes('Tool permission request failed')) {
    const zodMatch = text.match(/ZodError/);
    if (zodMatch) return 'Permission request failed: invalid response format';
    return 'Tool permission denied';
  }
  if (text.includes('User denied')) return 'Denied by user';
  if (text.includes('timed out')) return 'Tool call timed out';
  return null;
}

function ToolCallBlock({ block, allEvents }: { block: any; allEvents?: SessionEvent[] }) {
  const name = block.name || 'Tool';
  const input = block.input || {};
  const desc = input.description || input.command || input.pattern || input.query || '';
  const prompt = input.prompt || '';

  const result = allEvents ? findToolResult(allEvents, block.id) : null;
  const isError = result?.is_error === true;
  const rawResultText = result
    ? Array.isArray(result.content)
      ? result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      : typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
    : '';

  // Friendly error messages for known patterns
  const friendlyError = isError ? formatToolError(rawResultText) : null;
  const resultTexts = result
    ? Array.isArray(result.content)
      ? result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text)
      : [typeof result.content === 'string' ? result.content : JSON.stringify(result.content)]
    : [];

  const childEvents = allEvents ? findChildEvents(allEvents, block.id) : [];

  return (
    <div className="tool-use">
      <div style={styles.toolCallHeader}>
        <span className="tool-name" style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{name}</span>
        {desc && <span className="tool-desc" style={{ fontSize: 12 }}>{desc}</span>}
      </div>
      {prompt && <div className="tool-prompt" style={{ marginTop: 4, whiteSpace: 'pre-wrap' as any, lineHeight: 1.4, fontSize: 11 }}>{prompt}</div>}
      <details style={styles.rawJson}>
        <summary style={styles.rawJsonToggle}>all params</summary>
        <pre style={styles.rawJsonContent}>{JSON.stringify(input, null, 2)}</pre>
      </details>
      {childEvents.length > 0 && (
        <details style={styles.toolResultInline}>
          <summary style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <span className="result-label">{childEvents.length} sub-event{childEvents.length !== 1 ? 's' : ''}</span>
          </summary>
          <div style={styles.toolResultInner}>
            {childEvents.map((child, j) => (
              <EventMessage key={`child-${j}`} event={child} allEvents={allEvents || []} nested />
            ))}
          </div>
        </details>
      )}
      {result && isError && friendlyError && (
        <div style={styles.toolErrorInline}>
          <span style={styles.toolErrorIcon}>&#10005;</span>
          <span style={styles.toolErrorText}>{friendlyError}</span>
          <details style={styles.rawJson}>
            <summary style={styles.rawJsonToggle}>raw</summary>
            <pre style={styles.rawJsonContent}>{rawResultText}</pre>
          </details>
        </div>
      )}
      {result && (!isError || !friendlyError) && (
        <details style={styles.toolResultInline}>
          <summary style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <span className="result-label">{isError ? 'Error' : 'Result'}</span>
          </summary>
          <div style={styles.toolResultInner}>
            {resultTexts.map((text: string, j: number) => (
              <AssistantTextBlock key={j} text={text} />
            ))}
            <details style={styles.rawJson}>
              <summary style={styles.rawJsonToggle}>raw</summary>
              <pre style={styles.rawJsonContent}>{JSON.stringify(result, null, 2)}</pre>
            </details>
          </div>
        </details>
      )}
    </div>
  );
}

function AssistantTextBlock({ text }: { text: string }) {
  const [markdown, setMarkdown] = useState(true);
  return (
    <div>
      <button
        style={{
          ...styles.mdToggle,
          background: markdown ? '#30363d' : 'transparent',
          float: 'right',
        }}
        onClick={() => setMarkdown(!markdown)}
      >
        {markdown ? 'md' : 'txt'}
      </button>
      {markdown ? (
        <div className="md-content">
          <Markdown>{text}</Markdown>
        </div>
      ) : (
        <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
      )}
    </div>
  );
}

function EventMessage({ event, allEvents, nested, respondedRequests, onControlRespond }: {
  event: SessionEvent;
  allEvents: SessionEvent[];
  nested?: boolean;
  respondedRequests?: Set<string>;
  onControlRespond?: (requestId: string, approved: boolean, updatedInput?: any) => void;
}) {
  if (event.type === 'user') {
    const content = event.message?.content;

    // Tool results: shown inline in the Claude bubble, so hide standalone
    if (Array.isArray(content) && content.every((item: any) => item.type === 'tool_result')) {
      return null;
    }

    // Hide events with parent_tool_use_id at top level — they're rendered inline in their parent tool block
    if (event.parent_tool_use_id && !nested) {
      return null;
    }

    // Extract text from array of content blocks
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || JSON.stringify(content)
        : JSON.stringify(content);

    // Nested tool-delegated message
    if (nested) {
      return (
        <div style={{ margin: '4px 0', padding: '4px 0', borderBottom: '1px solid rgba(48,54,61,0.3)' }}>
          <div style={{ ...styles.role, color: '#58a6ff' }}>{event.message?.role === 'user' ? 'Input' : 'Output'} <RawJson data={event} /></div>
          <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{text}</div>
        </div>
      );
    }

    // Parse special user message formats
    const parsed = parseUserContent(text);

    if (parsed.type === 'caveat') {
      // Hide synthetic caveat messages — they're instructions for the AI, not user content
      return null;
    }

    if (parsed.type === 'command') {
      return (
        <div style={styles.commandMsg}>
          <span style={styles.commandBadge}>{parsed.name}</span>
          {parsed.args && <span style={styles.commandArgs}>{parsed.args}</span>}
          <RawJson data={event} />
        </div>
      );
    }

    if (parsed.type === 'command-output') {
      return (
        <div style={styles.commandOutputMsg}>
          <pre style={styles.commandOutputPre}>{parsed.text}</pre>
          <RawJson data={event} />
        </div>
      );
    }

    return (
      <div style={styles.userMsg}>
        <div style={styles.role}>You <RawJson data={event} /></div>
        <div>{text}</div>
      </div>
    );
  }

  if (event.type === 'assistant') {
    // Hide sub-agent responses at top level — rendered inline in parent tool block
    if (event.parent_tool_use_id && !nested) {
      return null;
    }

    const blocks = event.message?.content;
    if (Array.isArray(blocks)) {
      // Separate text blocks from tool_use blocks
      const hasText = blocks.some((b: any) => b.type === 'text');
      const hasToolUse = blocks.some((b: any) => b.type === 'tool_use');
      const hasThinking = blocks.some((b: any) => b.type === 'thinking');

      // If it's only a tool_use (no text), render compactly
      if (hasToolUse && !hasText) {
        return (
          <>
            {blocks.map((block: any, i: number) => {
              if (block.type === 'thinking')
                return (
                  <div key={i} className="bubble-tool">
                    <details className="bubble-thinking-inner">
                      <summary>Thinking... <RawJson data={event} /></summary>
                      <pre>{block.thinking}</pre>
                    </details>
                  </div>
                );
              if (block.type === 'tool_use')
                return (
                  <div key={i} className="bubble-tool">
                    <div style={styles.role}>Claude <RawJson data={event} /></div>
                    <ToolCallBlock block={block} allEvents={allEvents} />
                  </div>
                );
              return null;
            })}
          </>
        );
      }

      const thinkingBlocks = blocks.filter((b: any) => b.type === 'thinking');
      const otherBlocks = blocks.filter((b: any) => b.type !== 'thinking' && b.type !== 'signature');

      return (
        <>
          {thinkingBlocks.map((block: any, i: number) => (
            <div key={`t${i}`} className="bubble-tool">
              <details className="bubble-thinking-inner">
                <summary>Thinking... <RawJson data={event} /></summary>
                <pre>{block.thinking}</pre>
              </details>
            </div>
          ))}
          {otherBlocks.length > 0 && (
            <div style={styles.assistantMsg}>
              <div style={styles.role}>Claude <RawJson data={event} /></div>
              {otherBlocks.map((block: any, i: number) => {
                if (block.type === 'text') return <AssistantTextBlock key={i} text={block.text} />;
                if (block.type === 'tool_use') return <ToolCallBlock key={i} block={block} allEvents={allEvents} />;
                return null;
              })}
            </div>
          )}
        </>
      );
    }
    const content =
      typeof event.message?.content === 'string'
        ? event.message.content
        : JSON.stringify(event.message?.content);
    return (
      <div style={styles.assistantMsg}>
        <div style={styles.role}>Claude <RawJson data={event} /></div>
        <AssistantTextBlock text={content} />
      </div>
    );
  }

  if (event.type === 'result') {
    if (event.parent_tool_use_id && !nested) return null;
    return (
      <div className="bubble-system">
        Session {event.subtype} ({event.num_turns} turns) <RawJson data={event} />
      </div>
    );
  }

  if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
    const reqId = event.request_id || event.response?.request_id || '';
    const isResponded = respondedRequests?.has(reqId) || false;
    if (event.request?.tool_name === 'AskUserQuestion') {
      return (
        <UserQuestion
          request={event}
          onRespond={onControlRespond || (() => {})}
          responded={isResponded}
        />
      );
    }
    if (isResponded) return null;
    return (
      <ToolApproval
        request={event}
        onRespond={onControlRespond || (() => {})}
      />
    );
  }

  if (event.type === 'control_request') {
    return null;
  }

  if (event.type === 'system' || event.type === 'keep_alive' || event.type === 'control_response') {
    return null;
  }

  return (
    <div className="bubble-system">
      <span style={styles.eventType}>[{event.type}]</span> <RawJson data={event} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #30363d',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  viewTabs: {
    display: 'flex',
    background: '#161b22',
    borderRadius: 6,
    border: '1px solid #30363d',
    overflow: 'hidden',
  },
  viewTab: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500,
    color: '#8b949e',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  viewTabActive: {
    background: '#30363d',
    color: '#e6edf3',
  },
  sessionId: { fontSize: 13, fontFamily: 'monospace', color: '#8b949e' },
  status: { fontSize: 12 },
  messages: {
    flex: 1,
    overflow: 'auto',
    padding: 16,
  },
  userMsg: {
    margin: '12px 0',
    padding: 12,
    background: '#161b22',
    borderRadius: 8,
    borderLeft: '3px solid #58a6ff',
  },
  assistantMsg: {
    margin: '12px 0',
    padding: 12,
    background: '#161b22',
    borderRadius: 8,
    borderLeft: '3px solid #3fb950',
  },
  role: { fontSize: 11, fontWeight: 600, color: '#8b949e', marginBottom: 4, textTransform: 'uppercase' as const },
  mdToggle: {
    fontSize: 10,
    color: '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '1px 6px',
    cursor: 'pointer',
    fontFamily: 'monospace',
    lineHeight: '16px',
  },
  eventType: { color: '#f0883e', fontFamily: 'monospace' },
  toolCallHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  toolErrorInline: {
    marginTop: 6,
    padding: '5px 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'rgba(248, 81, 73, 0.08)',
    borderRadius: 4,
    border: '1px solid rgba(248, 81, 73, 0.2)',
  },
  toolErrorIcon: {
    color: '#f85149',
    fontSize: 11,
    flexShrink: 0,
  },
  toolErrorText: {
    fontSize: 12,
    color: '#f85149',
  },
  toolResultInline: {
    marginTop: 6,
    padding: '4px 8px',
    background: 'rgba(22, 27, 34, 0.3)',
    borderRadius: 4,
    border: '1px solid rgba(48, 54, 61, 0.3)',
    cursor: 'pointer',
  },
  toolResultInner: {
    marginTop: 8,
  },
  toolResultText: {
    fontSize: 13,
    color: '#c9d1d9',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    margin: '4px 0',
    fontFamily: 'inherit',
    lineHeight: 1.5,
  },
  rawJson: {
    display: 'inline',
  },
  rawJsonToggle: {
    display: 'inline',
    fontSize: 10,
    color: '#484f58',
    cursor: 'pointer',
    fontWeight: 400,
    textTransform: 'lowercase' as const,
    marginLeft: 6,
  },
  rawJsonContent: {
    fontSize: 11,
    color: '#7d8590',
    background: '#0d1117',
    padding: 8,
    borderRadius: 4,
    marginTop: 6,
    maxHeight: 400,
    overflow: 'auto',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  inputArea: {
    padding: 12,
    borderTop: '1px solid #30363d',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  inputRow: {
    display: 'flex',
    gap: 8,
  },
  textarea: {
    flex: 1,
    background: '#161b22',
    color: '#e6edf3',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: 8,
    fontSize: 14,
    resize: 'none',
    fontFamily: 'inherit',
  },
  controlsRow: {
    display: 'flex',
    gap: 12,
  },
  controlLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  controlLabelText: {
    fontSize: 11,
    color: '#8b949e',
    textTransform: 'uppercase' as const,
    fontWeight: 600,
    letterSpacing: '0.5px',
  },
  controlSelect: {
    background: '#161b22',
    color: '#e6edf3',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: 'pointer',
    outline: 'none',
  },
  typingIndicator: {
    margin: '12px 0',
    padding: '10px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderLeft: '3px solid #3fb950',
    borderRadius: 8,
    background: 'rgba(22, 27, 34, 0.5)',
  },
  typingText: {
    fontSize: 12,
    color: '#8b949e',
  },
  sendBtn: {
    padding: '8px 20px',
    background: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    alignSelf: 'flex-end',
  },
  forkDividerContainer: {
    position: 'relative' as const,
    height: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 -16px',
    padding: '0 16px',
  },
  forkDividerLine: {
    width: '100%',
    height: 1,
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative' as const,
  },
  forkBtn: {
    position: 'absolute' as const,
    background: '#21262d',
    color: '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: '1px 10px',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    zIndex: 1,
    transition: 'opacity 0.15s ease',
  },
  forkDialog: {
    position: 'absolute' as const,
    top: 20,
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 8,
    padding: 10,
    zIndex: 10,
    width: 320,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  forkDialogTextarea: {
    width: '100%',
    background: '#0d1117',
    color: '#e6edf3',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: 6,
    fontSize: 12,
    resize: 'none' as const,
    fontFamily: 'inherit',
  },
  forkDialogActions: {
    display: 'flex',
    gap: 6,
    justifyContent: 'flex-end',
    marginTop: 6,
  },
  forkDialogCancel: {
    background: 'transparent',
    color: '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
  },
  forkDialogConfirm: {
    background: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
  },
  commandMsg: {
    margin: '6px 0',
    padding: '6px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderRadius: 6,
    background: 'rgba(22, 27, 34, 0.4)',
  },
  commandBadge: {
    display: 'inline-block',
    padding: '2px 10px',
    background: '#1f2937',
    color: '#bc8cff',
    borderRadius: 12,
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: 600,
    border: '1px solid rgba(188, 140, 255, 0.2)',
  },
  commandArgs: {
    fontSize: 12,
    color: '#8b949e',
    fontFamily: 'monospace',
  },
  commandOutputMsg: {
    margin: '2px 0 12px',
    borderRadius: 6,
    background: '#0d1117',
    border: '1px solid #21262d',
    overflow: 'hidden',
  },
  commandOutputPre: {
    margin: 0,
    padding: '10px 12px',
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
    color: '#8b949e',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    lineHeight: 1.5,
    maxHeight: 300,
    overflow: 'auto',
  },
  forkIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '8px 0 16px',
  },
  forkIndicatorLine: {
    flex: 1,
    height: 1,
    background: '#30363d',
  },
  forkIndicatorText: {
    fontSize: 12,
    color: '#58a6ff',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    padding: '2px 8px',
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 12,
  },
};
