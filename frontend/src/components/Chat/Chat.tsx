import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { filterMessages, classifyFile, getAttachIcon, escapeHtml } from '../../utils';
import { ChatMessageItem } from './ChatMessage';
import { AtooAnyChat } from './AtooAnyChat';
import { api } from '../../api';
import { sendAgentCommand } from '../../api/websocket';
import type { Session, ChatAttachment, FilteredMessage } from '../../types';

export function ChatArea() {
  const { activeProjectId, projects, activeTabType } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj || activeTabType !== 'session') return null;

  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];

  if (!session) {
    return (
      <div className="chat-area">
        <div className="empty-state">
          <div className="empty-state-icon">◉</div>
          <div className="empty-state-title">No active session</div>
          <div className="empty-state-desc">Start a new Claude Code session</div>
        </div>
      </div>
    );
  }

  if (session.viewMode === 'tui') {
    return null; // Terminal view handled elsewhere
  }

  const chatReadOnly = session.agentMode === 'terminal+chatRO';
  const isAtooAny = session.agentType === 'atoo-any';

  if (isAtooAny) {
    return <AtooAnyChat session={session} proj={proj} />;
  }

  const showInput = !chatReadOnly;

  return (
    <>
      <ChatMessages session={session} />
      {showInput && <AttachmentsBar />}
      {showInput && <ChatInputBar session={session} proj={proj} />}
      {!chatReadOnly && <ChatStatusBar session={session} />}
    </>
  );
}

function ChatMessages({ session }: { session: Session }) {
  const { activeProjectId } = useStore();
  const areaRef = useRef<HTMLDivElement>(null);
  const showVerbose = session.showVerbose !== false;
  const chatReadOnly = session.agentMode === 'terminal+chatRO';
  const isAtooAny = session.agentType === 'atoo-any';
  // For atoo-any, always pass showVerbose=true to filterMessages so it doesn't
  // collapse dispatch messages — buildAtooAnyRenderItems handles its own filtering.
  const filtered = filterMessages(session.messages, isAtooAny ? true : showVerbose);

  // Range fork state
  const [rangeStartIdx, setRangeStartIdx] = useState<number | null>(null);
  const [rangeStartUuid, setRangeStartUuid] = useState<string | null>(null);

  useEffect(() => {
    if (areaRef.current) {
      areaRef.current.scrollTop = areaRef.current.scrollHeight;
    }
  }, [filtered.length, session.status]);

  let renderItems: React.ReactNode[];

  if (isAtooAny) {
    // atoo-any: group ALL messages by dispatchId, render dispatch blocks under user messages
    renderItems = buildAtooAnyRenderItems(filtered, session);
  } else {
    // Standard: group consecutive sidechain messages
    renderItems = [];
    const eventUuids: (string | undefined)[] = [];
    let i = 0;
    while (i < filtered.length) {
      const m = filtered[i];
      if (m._parentToolUseId) {
        const parentId = m._parentToolUseId;
        const agentId = m._agentId;
        const group: FilteredMessage[] = [];
        while (i < filtered.length && filtered[i]._parentToolUseId === parentId) {
          group.push(filtered[i]);
          i++;
        }
        renderItems.push(
          <SubagentGroup key={`sg-${parentId}`} messages={group} session={session} agentId={agentId} />
        );
        eventUuids.push(group[group.length - 1]._eventUuid);
      } else {
        renderItems.push(
          <ChatMessageItem key={m._eventUuid || i} m={m} fi={i} session={session} />
        );
        eventUuids.push(m._eventUuid);
        i++;
      }
    }

    // Interleave fork dividers in read-only mode
    if (chatReadOnly && renderItems.length > 0) {
      const finalItems: React.ReactNode[] = [];
      const handleFork = (afterUuid: string) => {
        if (!activeProjectId) return;
        (window as any).forkSession(activeProjectId, session.id, afterUuid, rangeStartUuid || undefined);
        setRangeStartIdx(null);
        setRangeStartUuid(null);
      };
      const handleSetRangeStart = (idx: number, uuid: string) => {
        setRangeStartIdx(idx);
        setRangeStartUuid(uuid);
      };
      const handleClearRange = () => {
        setRangeStartIdx(null);
        setRangeStartUuid(null);
      };

      for (let j = 0; j < renderItems.length; j++) {
        finalItems.push(renderItems[j]);
        const uuid = eventUuids[j];
        if (j < renderItems.length - 1 && uuid) {
          finalItems.push(
            <ForkDivider
              key={`fork-${j}`}
              index={j}
              afterEventUuid={uuid}
              rangeStartIndex={rangeStartIdx}
              isRangeStart={rangeStartIdx === j}
              onFork={handleFork}
              onSetRangeStart={handleSetRangeStart}
              onClearRange={handleClearRange}
            />
          );
        }
      }
      renderItems = finalItems;
    }
  }

  return (
    <div className="chat-area" ref={areaRef}>
      {renderItems}
      <StatusLine session={session} />
    </div>
  );
}

/**
 * Build render items for atoo-any sessions.
 * Groups ALL messages by their dispatchId (non-consecutively) and renders
 * dispatch blocks under each user message.
 */
function buildAtooAnyRenderItems(filtered: FilteredMessage[], session: Session): React.ReactNode[] {
  const items: React.ReactNode[] = [];

  // Collect all dispatch messages by dispatchId
  const dispatchGroups = new Map<string, FilteredMessage[]>();
  const userMessages: FilteredMessage[] = [];
  const orphanMessages: FilteredMessage[] = [];

  for (const m of filtered) {
    if (m.role === 'user' && !m._parentToolUseId) {
      userMessages.push(m);
    } else if (m._parentToolUseId) {
      const group = dispatchGroups.get(m._parentToolUseId) || [];
      group.push(m);
      dispatchGroups.set(m._parentToolUseId, group);
    } else {
      orphanMessages.push(m);
    }
  }

  // Render each user message followed by its dispatch blocks
  for (let ui = 0; ui < userMessages.length; ui++) {
    const userMsg = userMessages[ui];
    items.push(
      <ChatMessageItem key={userMsg._eventUuid || `user-${ui}`} m={userMsg} fi={ui} session={session} />
    );

    // Find dispatch blocks for this user message (dispatchId starts with the user event UUID)
    const userUuid = userMsg._eventUuid || '';
    const dispatches: { dispatchId: string; agent: string; messages: FilteredMessage[] }[] = [];
    for (const [dispatchId, msgs] of dispatchGroups) {
      if (dispatchId.startsWith(userUuid + ':')) {
        const agent = dispatchId.endsWith(':codex') ? 'codex' : 'claude';
        dispatches.push({ dispatchId, agent, messages: msgs });
      }
    }

    // Sort: claude first, then codex
    dispatches.sort((a, b) => a.agent.localeCompare(b.agent));

    for (const d of dispatches) {
      items.push(
        <DispatchBlock key={`dispatch-${d.dispatchId}`} messages={d.messages} agent={d.agent} session={session} />
      );
    }
  }

  // Render any orphan messages at the end
  for (const m of orphanMessages) {
    items.push(
      <ChatMessageItem key={m._eventUuid || `orphan`} m={m} fi={0} session={session} />
    );
  }

  return items;
}

/** Inline SVG icons for dispatch blocks and toggle buttons */
const CLAUDE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>';
const CODEX_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>';

/**
 * A single dispatch response block — ONE block per agent per user message.
 * Contains ALL messages from that dispatch inside.
 */
function DispatchBlock({ messages, agent, session }: { messages: FilteredMessage[]; agent: string; session: Session }) {
  // Detect if dispatch is still running
  const isRunning = session.status === 'active' && messages.length > 0;

  const [userToggled, setUserToggled] = useState(false);
  const [forceExpanded, setForceExpanded] = useState(false);
  // Auto-expand while running or when few messages, collapse when done with many
  const expanded = userToggled ? forceExpanded : (isRunning || messages.length <= 3);
  const toggle = () => { setUserToggled(true); setForceExpanded(!expanded); };

  // Verbose: session.showVerbose controls showing tool calls (default false for atoo-any)
  const showVerbose = session.showVerbose === true;

  const toolCount = messages.filter(m => m.role === 'tool').length;
  const thinkingCount = messages.filter(m => m.role === 'thinking').length;
  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
  const summaryText = lastAssistant
    ? (lastAssistant.content.length > 150 ? lastAssistant.content.substring(0, 150) + '...' : lastAssistant.content)
    : (messages.length === 0 ? 'Waiting...' : '');

  // Filter messages for display: when not verbose, only show assistant messages
  const displayMessages = showVerbose
    ? messages
    : messages.filter(m => m.role === 'assistant');

  const isClaude = agent === 'claude';
  const iconSvg = isClaude ? CLAUDE_ICON_SVG : CODEX_ICON_SVG;
  const label = isClaude ? 'Claude' : 'Codex';
  const colorClass = isClaude ? 'claude' : 'codex';

  return (
    <div className={`atoo-dispatch-block ${colorClass}`}>
      <div className="atoo-dispatch-header" onClick={toggle}>
        <span className={`chat-subagent-chevron ${expanded ? 'expanded' : ''}`}>▶</span>
        <span className="atoo-dispatch-icon" dangerouslySetInnerHTML={{ __html: iconSvg }} />
        <span className="atoo-dispatch-label">{label}</span>
        <span className="chat-subagent-stats">
          {isRunning && <span className="chat-subagent-stat" style={{ color: 'var(--accent-green)' }}>● running</span>}
          {toolCount > 0 && <span className="chat-subagent-stat">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>}
          {thinkingCount > 0 && !showVerbose && <span className="chat-subagent-stat">{thinkingCount} thinking</span>}
        </span>
      </div>
      {!expanded && summaryText && (
        <div className="chat-subagent-summary">{escapeHtml(summaryText)}</div>
      )}
      {expanded && (
        <div className="chat-subagent-messages">
          {displayMessages.map((m, i) => (
            <ChatMessageItem key={m._eventUuid || i} m={m} fi={i} session={session} />
          ))}
          {displayMessages.length === 0 && isRunning && (
            <div style={{ padding: '8px 14px', color: 'var(--text-muted)', fontSize: 12 }}>Working...</div>
          )}
        </div>
      )}
    </div>
  );
}

function ForkDivider({ index, afterEventUuid, rangeStartIndex, isRangeStart, onFork, onSetRangeStart, onClearRange }: {
  index: number;
  afterEventUuid: string;
  rangeStartIndex: number | null;
  isRangeStart: boolean;
  onFork: (uuid: string) => void;
  onSetRangeStart: (idx: number, uuid: string) => void;
  onClearRange: () => void;
}) {
  const [shiftHeld, setShiftHeld] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!hovered) return;
    const onKey = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [hovered]);

  const hasRangeStart = rangeStartIndex !== null;
  const isAboveRange = hasRangeStart && index < rangeStartIndex!;
  const isBelowRange = hasRangeStart && !isRangeStart && index > rangeStartIndex!;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRangeStart) {
      onClearRange();
      return;
    }
    if (isAboveRange) return; // disabled
    if (e.shiftKey) {
      onSetRangeStart(index, afterEventUuid);
    } else {
      onFork(afterEventUuid);
    }
  };

  let className = 'fork-divider';
  if (isRangeStart) className += ' range-start';
  else if (isAboveRange) className += ' range-disabled';
  else if (isBelowRange) className += ' range-active';
  else if (hovered && shiftHeld) className += ' shift-hover';

  let label = 'Fork here';
  let hint = 'Shift+click: set range start';
  if (isRangeStart) {
    label = 'Range start';
    hint = 'Click to clear';
  } else if (isBelowRange) {
    label = 'Fork range';
    hint = '';
  } else if (hovered && shiftHeld) {
    label = 'Set range start';
    hint = '';
  }

  return (
    <div
      className={className}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setShiftHeld(false); }}
    >
      <div className="fork-divider-line"></div>
      <div className="fork-divider-btn">
        <span className="fork-divider-label">{label}</span>
        {hint && <span className="fork-divider-hint">{hint}</span>}
      </div>
    </div>
  );
}

function SubagentGroup({ messages, session, agentId }: { messages: FilteredMessage[]; session: Session; agentId?: string }) {
  const [expanded, setExpanded] = useState(false);

  // Derive a summary: count tool calls and find the last assistant message
  const toolCount = messages.filter(m => m.role === 'tool').length;
  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
  const summaryText = lastAssistant
    ? lastAssistant.content.length > 120 ? lastAssistant.content.substring(0, 120) + '...' : lastAssistant.content
    : '';

  // Determine label from agentId prefix or fallback
  const label = agentId ? `Agent ${agentId.substring(0, 8)}` : 'Subagent';

  return (
    <div className="chat-msg assistant">
      <div className="chat-avatar claude">A</div>
      <div className="chat-subagent-bubble">
        <div className="chat-subagent-header" onClick={() => setExpanded(!expanded)}>
          <span className={`chat-subagent-chevron ${expanded ? 'expanded' : ''}`}>▶</span>
          <span className="chat-subagent-label">{label}</span>
          <span className="chat-subagent-stats">
            {toolCount > 0 && <span className="chat-subagent-stat">{toolCount} tool call{toolCount !== 1 ? 's' : ''}</span>}
            <span className="chat-subagent-stat">{messages.length} msg{messages.length !== 1 ? 's' : ''}</span>
          </span>
        </div>
        {!expanded && summaryText && (
          <div className="chat-subagent-summary">{escapeHtml(summaryText)}</div>
        )}
        {expanded && (
          <div className="chat-subagent-messages">
            {messages.map((m, i) => (
              <ChatMessageItem key={m._eventUuid || i} m={m} fi={i} session={session} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusLine({ session }: { session: Session }) {
  if (session.status === 'attention') {
    return <div className="chat-status-line"><span className="waiting-indicator">⏳ Waiting for your input</span></div>;
  }
  if (session.status === 'active') {
    return <div className="chat-status-line" style={{ color: 'var(--accent-green)' }}>● Agent is working...</div>;
  }
  return null;
}

function AttachmentsBar() {
  const { chatAttachments, removeChatAttachment } = useStore();
  if (chatAttachments.length === 0) return null;

  return (
    <div className="chat-attachments has-items">
      {chatAttachments.map(att => {
        const size = att.size < 1024 ? att.size + ' B' : att.size < 1048576 ? (att.size / 1024).toFixed(1) + ' KB' : (att.size / 1048576).toFixed(1) + ' MB';
        const icon = getAttachIcon(att.kind || 'image');
        return (
          <div key={att.id} className="chat-attach-chip">
            <span className="chat-attach-chip-icon">{icon}</span>
            <span className="chat-attach-chip-name">{att.name}</span>
            <span className="chat-attach-chip-size">{size}</span>
            <span className="chat-attach-chip-remove" onClick={() => removeChatAttachment(att.id)}>×</span>
          </div>
        );
      })}
    </div>
  );
}

function ChatInputBar({ session, proj }: { session: Session; proj: any }) {
  const { chatAttachments, clearChatAttachments, addChatAttachment, addToast, updateProject, isMobileLayout } = useStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  const isAtooAny = session.agentType === 'atoo-any';
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['claude']);
  const disabled = !isAtooAny && !!session.contextInProgress;

  const sendMessage = async () => {
    const text = inputRef.current?.value.trim();
    if (!text || !proj) return;

    inputRef.current!.value = '';
    setHistoryIndex(-1);
    setHistoryDraft('');

    const attachments = chatAttachments
      .filter(a => a.data || a.text)
      .map(a => {
        const att: any = { media_type: a.type, data: a.data || '', name: a.name };
        if (a.text) att.text = a.text;
        if (a.kind) att.kind = a.kind;
        return att;
      });
    clearChatAttachments();

    const cmd: any = { action: 'send_message', text, attachments: attachments.length ? attachments : undefined };
    if (isAtooAny && selectedAgents.length > 0) {
      cmd.agents = selectedAgents;
    }

    sendAgentCommand(session.id, cmd);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    // On mobile: Enter inserts newline, send via button only
    if (e.key === 'Enter' && isMobileLayout && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      return; // let default newline behavior happen
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      if (!disabled) sendMessage();
      return;
    }

    const history = session.messages.filter(m => m.role === 'user');
    if (!history.length) return;
    const input = inputRef.current!;

    if (e.key === 'ArrowUp' && !e.shiftKey && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      const newIdx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      if (historyIndex === -1) setHistoryDraft(input.value);
      setHistoryIndex(newIdx);
      input.value = history[newIdx]?.content || '';
      input.setSelectionRange(0, 0);
    } else if (e.key === 'ArrowDown' && !e.shiftKey && historyIndex !== -1 && input.selectionStart === input.value.length) {
      e.preventDefault();
      if (historyIndex < history.length - 1) {
        const newIdx = historyIndex + 1;
        setHistoryIndex(newIdx);
        input.value = history[newIdx]?.content || '';
      } else {
        setHistoryIndex(-1);
        input.value = historyDraft;
      }
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const handleFileAttach = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const kind = classifyFile(file);
      if (kind === 'unsupported') {
        addToast(proj?.name || '', `Unsupported file type: ${file.name}`, 'attention');
        continue;
      }
      const id = 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const entry: ChatAttachment = { id, name: file.name, size: file.size, type: file.type, data: null, text: null, kind };
      addChatAttachment(entry);

      if (kind === 'text') {
        const reader = new FileReader();
        reader.onload = () => {
          const store = useStore.getState();
          store.setChatAttachments(store.chatAttachments.map(a => a.id === id ? { ...a, text: reader.result as string } : a));
        };
        reader.readAsText(file);
      } else if (kind === 'office') {
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = (reader.result as string).split(',')[1];
          try {
            const resp = await api('POST', '/api/extract-text', { data: base64, name: file.name });
            const store = useStore.getState();
            store.setChatAttachments(store.chatAttachments.map(a => a.id === id ? { ...a, text: resp.text } : a));
          } catch (e: any) {
            addToast(proj?.name || '', `Failed to extract text from ${file.name}: ${e.message}`, 'attention');
            const store = useStore.getState();
            store.setChatAttachments(store.chatAttachments.filter(a => a.id !== id));
          }
        };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          const store = useStore.getState();
          const data = (reader.result as string).split(',')[1];
          store.setChatAttachments(store.chatAttachments.map(a => a.id === id ? { ...a, data } : a));
        };
        reader.readAsDataURL(file);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) handleFileAttach(createFileList([file]));
      }
    }
  };

  const toggleAgent = (agent: string) => {
    setSelectedAgents(prev => {
      if (prev.includes(agent)) {
        // Don't allow deselecting if it's the last one
        if (prev.length <= 1) return prev;
        return prev.filter(a => a !== agent);
      }
      return [...prev, agent];
    });
  };

  return (
    <div className="chat-input-bar">
      <button className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach file" disabled={disabled}>📎</button>
      <input type="file" ref={fileInputRef} multiple style={{ display: 'none' }} onChange={(e) => handleFileAttach(e.target.files)} />
      {isAtooAny && (
        <div className="agent-toggles">
          <button
            className={`agent-toggle ${selectedAgents.includes('claude') ? 'active claude' : ''}`}
            onClick={() => toggleAgent('claude')}
            title="Send to Claude Code"
            dangerouslySetInnerHTML={{ __html: CLAUDE_ICON_SVG }}
          />
          <button
            className={`agent-toggle ${selectedAgents.includes('codex') ? 'active codex' : ''}`}
            onClick={() => toggleAgent('codex')}
            title="Send to Codex"
            dangerouslySetInnerHTML={{ __html: CODEX_ICON_SVG }}
          />
        </div>
      )}
      <textarea
        className="chat-input"
        ref={inputRef}
        placeholder={isAtooAny ? 'Message agents...' : (disabled ? 'Refreshing context...' : 'Message Claude...')}
        onKeyDown={handleKey}
        onPaste={handlePaste}
        rows={1}
        disabled={disabled}
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
      />
      <button className="chat-send-btn" onClick={sendMessage} disabled={disabled}>↑</button>
    </div>
  );
}

function createFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  return dt.files;
}

function ChatStatusBar({ session }: { session: Session }) {
  const u = session.contextUsage;

  return (
    <div className="chat-status-bar">
      <div className="chat-status-item">
        <span className="chat-status-label">Mode</span>
        <select value={session.permissionMode || 'default'} onChange={(e) => (window as any).updateSessionMode(e.target.value)} disabled={!!session.contextInProgress}>
          <option value="default">Always Ask</option>
          <option value="acceptEdits">Auto-Edit</option>
          <option value="plan">Plan Mode</option>
          <option value="bypassPermissions">Bypass All</option>
        </select>
      </div>
      <div className="chat-status-sep"></div>
      <div className="chat-status-item">
        <span className="chat-status-label">Model</span>
        <select value={session.model || 'claude-sonnet-4-6'} onChange={(e) => (window as any).updateSessionModel(e.target.value)} disabled={!!session.contextInProgress}>
          <option value="claude-opus-4-6">Opus</option>
          <option value="claude-sonnet-4-6">Sonnet</option>
          <option value="claude-haiku-4-5-20251001">Haiku</option>
        </select>
      </div>
      <div className="chat-status-sep"></div>
      <div className="chat-status-tokens">
        <TokenBar usage={u} />
      </div>
    </div>
  );
}

function TokenBar({ usage }: { usage?: any }) {
  if (!usage) {
    return (
      <>
        <span>Token usage: —</span>
        <div className="chat-token-bar-track"><div className="chat-token-bar-fill" style={{ width: '0%' }}></div></div>
      </>
    );
  }
  const usedK = usage.usedTokens >= 1000 ? (usage.usedTokens / 1000).toFixed(usage.usedTokens >= 10000 ? 0 : 1) + 'k' : usage.usedTokens;
  const totalK = usage.totalTokens >= 1000 ? (usage.totalTokens / 1000).toFixed(0) + 'k' : usage.totalTokens;
  const free = usage.freePercent != null ? usage.freePercent : (100 - usage.percent);
  const used = 100 - free;
  const color = free < 20 ? 'var(--accent-red, #e55)' : free < 50 ? 'var(--accent-yellow, #eb5)' : 'var(--accent-green, #5e5)';

  return (
    <>
      <span>{usage.model} · {usedK}/{totalK} tokens ({usage.percent}%) · Free: {free.toFixed(1)}%</span>
      <div className="chat-token-bar-track"><div className="chat-token-bar-fill" style={{ width: used + '%', background: color }}></div></div>
    </>
  );
}
