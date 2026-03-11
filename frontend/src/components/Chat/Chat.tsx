import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { filterMessages, classifyFile, getAttachIcon, escapeHtml } from '../../utils';
import { ChatMessageItem } from './ChatMessage';
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

  return (
    <>
      <ChatMessages session={session} />
      {!chatReadOnly && <AttachmentsBar />}
      {!chatReadOnly && <ChatInputBar session={session} proj={proj} />}
      {!chatReadOnly && <ChatStatusBar session={session} />}
    </>
  );
}

function ChatMessages({ session }: { session: Session }) {
  const { activeProjectId } = useStore();
  const areaRef = useRef<HTMLDivElement>(null);
  const showVerbose = session.showVerbose !== false;
  const filtered = filterMessages(session.messages, showVerbose);
  const chatReadOnly = session.agentMode === 'terminal+chatRO';

  // Range fork state
  const [rangeStartIdx, setRangeStartIdx] = useState<number | null>(null);
  const [rangeStartUuid, setRangeStartUuid] = useState<string | null>(null);

  useEffect(() => {
    if (areaRef.current) {
      areaRef.current.scrollTop = areaRef.current.scrollHeight;
    }
  }, [filtered.length, session.status]);

  // Group consecutive sidechain messages for rendering, tracking event UUIDs per item
  const renderItems: React.ReactNode[] = [];
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
  const finalItems: React.ReactNode[] = [];
  if (chatReadOnly && renderItems.length > 0) {
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
  } else {
    finalItems.push(...renderItems);
  }

  return (
    <div className="chat-area" ref={areaRef}>
      {finalItems}
      <StatusLine session={session} />
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
  const { chatAttachments, clearChatAttachments, addChatAttachment, addToast, updateProject } = useStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  const disabled = !!session.contextInProgress;

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

    const cmd = { action: 'send_message', text, attachments: attachments.length ? attachments : undefined };

    sendAgentCommand(session.id, cmd);
  };

  const handleKey = (e: React.KeyboardEvent) => {
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

  return (
    <div className="chat-input-bar">
      <button className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach file" disabled={disabled}>📎</button>
      <input type="file" ref={fileInputRef} multiple style={{ display: 'none' }} onChange={(e) => handleFileAttach(e.target.files)} />
      <textarea
        className="chat-input"
        ref={inputRef}
        placeholder={disabled ? 'Refreshing context...' : 'Message Claude...'}
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
