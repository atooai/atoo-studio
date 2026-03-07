import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { filterMessages, classifyFile, getAttachIcon, escapeHtml } from '../../utils';
import { ChatMessageItem } from './ChatMessage';
import { api } from '../../api';
import { sendAgentCommand } from '../../api/websocket';
import type { Session, ChatAttachment } from '../../types';

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
      <ChatStatusBar session={session} />
    </>
  );
}

function ChatMessages({ session }: { session: Session }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const showVerbose = session.showVerbose !== false;
  const filtered = filterMessages(session.messages, showVerbose);

  useEffect(() => {
    if (areaRef.current) {
      areaRef.current.scrollTop = areaRef.current.scrollHeight;
    }
  }, [filtered.length, session.status]);

  return (
    <div className="chat-area" ref={areaRef}>
      {filtered.map((m, fi) => (
        <ChatMessageItem key={m._eventUuid || fi} m={m} fi={fi} session={session} />
      ))}
      <StatusLine session={session} />
    </div>
  );
}

function StatusLine({ session }: { session: Session }) {
  if (session.status === 'waiting') {
    return <div className="chat-status-line"><span className="waiting-indicator">⏳ Waiting for your input</span></div>;
  }
  if (session.status === 'running') {
    return <div className="chat-status-line" style={{ color: 'var(--accent-green)' }}>● Claude is working...</div>;
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

    if (sendAgentCommand(session.id, cmd)) {
      // Agent WS will echo back
    } else {
      const msgUuid = crypto.randomUUID();
      // Optimistic push
      updateProject(proj.id, (p) => ({
        ...p,
        sessions: p.sessions.map(s =>
          s.id === session.id
            ? { ...s, status: 'running' as const, messages: [...s.messages, { role: 'user' as const, content: text, _eventUuid: msgUuid }] }
            : s
        ),
      }));
      try {
        await api('POST', `/api/sessions/${session.id}/message`, {
          message: text, uuid: msgUuid,
          attachments: attachments.length ? attachments : undefined,
        });
      } catch (e: any) {
        addToast(proj.name, `Failed to send: ${e.message}`, 'attention');
      }
    }
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
