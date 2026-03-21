/**
 * AtooAnyChat — Multi-agent chat interface for atoo-any sessions.
 * Renders user messages with per-agent response groups, fork/branch mechanics,
 * removed/compacted states, tree minimap, and virtualized scrolling.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useStore } from '../../state/store';
import { filterMessages, classifyFile, getAttachIcon, escapeHtml, renderMd } from '../../utils';
import { ChatMessageItem } from './ChatMessage';
import { api } from '../../api';
import { sendAgentCommand } from '../../api/websocket';
import type { Session, ChatAttachment, FilteredMessage, AtooFork, AtooBranch, AtooExtraction, MessageStatus } from '../../types';

// ═══════════════════════════════════════════════════════════════
// AGENT CONFIG
// ═══════════════════════════════════════════════════════════════

const AGENT_CONFIG: Record<string, { name: string; color: string; cssClass: string; enabled: boolean }> = {
  claude: { name: 'Claude', color: '#D4845A', cssClass: 'claude', enabled: true },
  codex: { name: 'Codex', color: '#6B8F71', cssClass: 'codex', enabled: true },
  gemini: { name: 'Gemini', color: '#5B8DEF', cssClass: 'gemini', enabled: false },
};

const BRANCH_COLORS = ['#a78bfa', '#f59e0b', '#34d399', '#f472b6', '#60a5fa'];
const COLUMN_BREAKPOINT = 900;

// ═══════════════════════════════════════════════════════════════
// ICONS (compact SVGs)
// ═══════════════════════════════════════════════════════════════

const ChevronIcon = ({ open, size = 14 }: { open: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const BrainIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6" /><path d="M8 4v4l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" /></svg>;
const ToolIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10.5 2.5l3 3-1.5 1.5-3-3M2.5 10.5l3 3 7-7-3-3z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" /></svg>;
const AgentIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6" /><circle cx="6" cy="7.5" r="1" fill="currentColor" opacity="0.6" /><circle cx="10" cy="7.5" r="1" fill="currentColor" opacity="0.6" /></svg>;
const RowIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="2" y="9" width="12" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" /></svg>;
const ColumnIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2" width="5.5" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="9" y="2" width="5.5" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" /></svg>;
const CopyIconSvg = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" /><path d="M11 5V3.5A1.2 1.2 0 009.8 2.3H3.5A1.2 1.2 0 002.3 3.5V9.8A1.2 1.2 0 003.5 11H5" stroke="currentColor" strokeWidth="1.2" /></svg>;
const CheckIconSvg = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const ForkIconSvg = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="4.5" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="11.5" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M8 4.5V8M8 8C8 10 4.5 10 4.5 11.5M8 8C8 10 11.5 10 11.5 11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
const WarningIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2L14.5 13H1.5L8 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="11.2" r="0.6" fill="currentColor" /></svg>;
const ExtractIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 2h8v4l-3-2-3 2V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M3 8h10M3 11h10M3 14h6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.5" /></svg>;
const CompactIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 3h8M4 6.5h8M4 10h8M4 13h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.4" /><path d="M2 6.5l3 2-3 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const TrashIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M5.5 3V2.5a1 1 0 011-1h3a1 1 0 011 1V3M3 3.5h10M4.5 3.5v9a1 1 0 001 1h5a1 1 0 001-1v-9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const MapIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.2" /><circle cx="4" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="12" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="13.5" r="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M8 5.5V7M6.5 7.5L4.8 8.8M9.5 7.5l1.7 1.3M4.5 11.3L7.2 12.5M11.5 11.3L8.8 12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" /></svg>;
const AttachIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>;

// ═══════════════════════════════════════════════════════════════
// DATA MODEL — transforms flat FilteredMessage[] to MsgBlocks
// ═══════════════════════════════════════════════════════════════

interface AgentMessage {
  id: string;
  type: 'assistant' | 'thinking' | 'tool_call' | 'subagent';
  content: string;
  rawContent?: string | null;
  toolName?: string;
  toolInput?: any;
  toolOutput?: string;
  isError?: boolean;
  isPending?: boolean;
  agentName?: string;
  messages?: AgentMessage[];
  _original?: FilteredMessage;
}

interface AgentResponse {
  agentName: string;
  agentColor: string;
  agentClass: string;
  messages: AgentMessage[];
}

interface MsgBlock {
  id: string;
  userMessage: FilteredMessage;
  status: MessageStatus;
  triggeredAgents: string[];
  responses: Record<string, AgentResponse>;
  contextDrift: boolean;
  compactedSummary?: string;
  compactedBy?: string;
}

function buildMsgBlocks(filtered: FilteredMessage[]): MsgBlock[] {
  const dispatchGroups = new Map<string, FilteredMessage[]>();
  const userMessages: FilteredMessage[] = [];

  for (const m of filtered) {
    if (m.role === 'user' && !m._parentToolUseId) {
      userMessages.push(m);
    } else if (m._parentToolUseId) {
      const group = dispatchGroups.get(m._parentToolUseId) || [];
      group.push(m);
      dispatchGroups.set(m._parentToolUseId, group);
    }
  }

  return userMessages.map(userMsg => {
    const userUuid = userMsg._eventUuid || '';
    const responses: Record<string, AgentResponse> = {};
    const triggeredAgents: string[] = [];

    for (const [dispatchId, msgs] of dispatchGroups) {
      if (!dispatchId.startsWith(userUuid + ':')) continue;
      const agentKey = dispatchId.split(':').pop() || 'claude';
      const cfg = AGENT_CONFIG[agentKey];
      if (!cfg) continue;

      triggeredAgents.push(agentKey);
      responses[agentKey] = {
        agentName: cfg.name,
        agentColor: cfg.color,
        agentClass: cfg.cssClass,
        messages: msgs.map(m => mapToAgentMessage(m)),
      };
    }

    // Sort agent keys: claude, codex, gemini
    triggeredAgents.sort();

    return {
      id: userMsg._eventUuid || `msg-${Math.random()}`,
      userMessage: userMsg,
      status: (userMsg._msgStatus || 'visible') as MessageStatus,
      triggeredAgents,
      responses,
      contextDrift: !!userMsg._contextDrift,
      compactedSummary: userMsg._compactedSummary,
      compactedBy: userMsg._compactedBy,
    };
  });
}

function mapToAgentMessage(m: FilteredMessage): AgentMessage {
  if (m.role === 'thinking') {
    return { id: m._eventUuid || '', type: 'thinking', content: m.content, _original: m };
  }
  if (m.role === 'tool') {
    const content = m._toolName
      ? `${m._toolName}(${m._toolInput ? JSON.stringify(m._toolInput).substring(0, 200) : ''})`
      : m.content;
    return {
      id: m._eventUuid || '',
      type: 'tool_call',
      content,
      toolName: m._toolName,
      toolInput: m._toolInput,
      toolOutput: m._toolOutput,
      isError: m._isError,
      isPending: m._pending,
      _original: m,
    };
  }
  return {
    id: m._eventUuid || '',
    type: 'assistant',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    _original: m,
  };
}

// ═══════════════════════════════════════════════════════════════
// SMALL REUSABLE COMPONENTS
// ═══════════════════════════════════════════════════════════════

function CopyButton({ text }: { text?: string }) {
  const [copied, setCopied] = useState(false);
  const go = useCallback(() => {
    navigator.clipboard.writeText(text || '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, [text]);
  return (
    <button onClick={go} title="Copy" className={`aa-copy-btn ${copied ? 'copied' : ''}`}>
      {copied ? <CheckIconSvg /> : <CopyIconSvg />}
    </button>
  );
}

const MODES = ['rendered', 'txt', 'raw'] as const;
const MODE_LABELS: Record<string, string> = { rendered: 'Rendered', txt: 'TXT', raw: 'RAW' };

function RenderCycle({ mode, onChange }: { mode: string; onChange: (m: string) => void }) {
  const next = () => { const i = MODES.indexOf(mode as any); onChange(MODES[(i + 1) % 3]); };
  return (
    <button onClick={next} title={`View: ${MODE_LABELS[mode]}`} className={`aa-render-cycle ${mode !== 'rendered' ? 'active' : ''}`}>
      {MODE_LABELS[mode]}
    </button>
  );
}

function MsgToolbar({ mode, onMode, content, rawContent }: { mode: string; onMode: (m: string) => void; content: string; rawContent?: string | null }) {
  return (
    <div className="aa-msg-toolbar">
      <RenderCycle mode={mode} onChange={onMode} />
      <CopyButton text={mode === 'raw' && rawContent ? rawContent : content} />
    </div>
  );
}

function LayoutToggle({ layout, onChange }: { layout: string; onChange: (l: string) => void }) {
  return (
    <div className="aa-layout-toggle">
      <button onClick={() => onChange('row')} className={layout === 'row' ? 'active' : ''}><RowIcon /></button>
      <button onClick={() => onChange('column')} className={layout === 'column' ? 'active' : ''}><ColumnIcon /></button>
    </div>
  );
}

function Badge({ thinkingCount, toolCallCount, subagentCount }: { thinkingCount: number; toolCallCount: number; subagentCount: number }) {
  const items: { icon: React.ReactNode; count: number }[] = [];
  if (thinkingCount > 0) items.push({ icon: <BrainIcon />, count: thinkingCount });
  if (toolCallCount > 0) items.push({ icon: <ToolIcon />, count: toolCallCount });
  if (subagentCount > 0) items.push({ icon: <AgentIcon />, count: subagentCount });
  if (!items.length) return null;
  return (
    <div className="aa-badges">
      {items.map((x, i) => <span key={i} className="aa-badge">{x.icon} {x.count}</span>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CONTENT RENDERER
// ═══════════════════════════════════════════════════════════════

function Content({ content, rawContent, mode }: { content: string; rawContent?: string | null; mode: string }) {
  if (mode === 'raw' && rawContent) {
    let formatted: string;
    try { formatted = JSON.stringify(JSON.parse(rawContent), null, 2); } catch { formatted = rawContent; }
    return <pre className="aa-content-raw">{formatted}</pre>;
  }
  if (mode === 'txt') return <pre className="aa-content-txt">{content}</pre>;
  return <div className="aa-content" dangerouslySetInnerHTML={{ __html: renderMd(content) }} />;
}

// ═══════════════════════════════════════════════════════════════
// AGENT GROUP & ASSISTANT MESSAGE
// ═══════════════════════════════════════════════════════════════

function AsstMsg({ msg }: { msg: AgentMessage }) {
  const [mode, setMode] = useState('rendered');
  return (
    <div className="aa-asst-msg">
      <MsgToolbar mode={mode} onMode={setMode} content={msg.content} rawContent={msg.rawContent} />
      <Content content={msg.content} rawContent={msg.rawContent} mode={mode} />
    </div>
  );
}

function AgentGroup({ agent, isCol }: { agent: AgentResponse; isCol: boolean }) {
  const [verbose, setVerbose] = useState(false);
  const agentKey = Object.entries(AGENT_CONFIG).find(([, c]) => c.name === agent.agentName)?.[0] || '';

  // Segment: group consecutive non-assistant items together
  const segs: ({ t: 'm'; items: AgentMessage[] } | { t: 'a'; msg: AgentMessage })[] = [];
  let meta: AgentMessage[] = [];
  for (const m of agent.messages) {
    if (m.type === 'assistant') {
      if (meta.length) { segs.push({ t: 'm', items: meta }); meta = []; }
      segs.push({ t: 'a', msg: m });
    } else {
      meta.push(m);
    }
  }
  if (meta.length) segs.push({ t: 'm', items: meta });

  return (
    <div className={`aa-agent-group ${agent.agentClass}`}>
      <div className="aa-agent-group-header">
        <div className="aa-agent-group-label">
          <div className="aa-agent-dot" style={{ background: agent.agentColor }} />
          <span className="aa-agent-name" style={{ color: agent.agentColor }}>{agent.agentName}</span>
        </div>
        <button
          onClick={() => setVerbose(!verbose)}
          className={`aa-verbose-btn ${verbose ? 'active' : ''}`}
          style={verbose ? { borderColor: agent.agentColor + '40', background: agent.agentColor + '12', color: agent.agentColor } : undefined}
        >
          {verbose ? 'verbose' : 'compact'}
        </button>
      </div>
      {segs.map((s, i) => {
        if (s.t === 'm') {
          if (verbose) {
            return (
              <div key={i}>
                {s.items.map(x => {
                  if (x.type === 'thinking') return <div key={x.id} className="aa-thinking">{x.content}</div>;
                  if (x.type === 'tool_call') {
                    return (
                      <div key={x.id} className="aa-tool-call">
                        {x.toolName && <span className="aa-tool-name-badge">{x.toolName}</span>}
                        <span className="aa-tool-content">{x.content}</span>
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            );
          }
          // Collapsed: show badges
          const tc = s.items.filter(x => x.type === 'thinking').length;
          const tlc = s.items.filter(x => x.type === 'tool_call').length;
          const sc = s.items.filter(x => x.type === 'subagent').length;
          return <Badge key={i} thinkingCount={tc} toolCallCount={tlc} subagentCount={sc} />;
        }
        if (s.t === 'a') return <AsstMsg key={i} msg={s.msg} />;
        return null;
      })}
      {agent.messages.length === 0 && (
        <div style={{ padding: '8px 0', color: 'var(--text-muted)', fontSize: 12 }}>Working...</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// REMOVED / COMPACTED / CONTEXT DRIFT
// ═══════════════════════════════════════════════════════════════

function RemovedBlock({ block, onRestore }: { block: MsgBlock; onRestore: (id: string) => void }) {
  const [exp, setExp] = useState(false);
  return (
    <div className="aa-removed-block">
      <div className="aa-removed-header" onClick={() => setExp(!exp)}>
        <TrashIcon />
        <span className="aa-removed-label">Message removed from context</span>
        <span className="aa-removed-toggle">{exp ? 'collapse' : 'expand'}</span>
        <button className="aa-removed-restore" onClick={(e) => { e.stopPropagation(); onRestore(block.id); }}>Restore</button>
      </div>
      {exp && (
        <div className="aa-removed-body">
          <div className="aa-removed-content">"{block.userMessage.content}"</div>
          <div className="aa-removed-agents">{block.triggeredAgents.map(a => AGENT_CONFIG[a]?.name).filter(Boolean).join(', ')} responded</div>
        </div>
      )}
    </div>
  );
}

function CompactedBlock({ block }: { block: MsgBlock }) {
  const [exp, setExp] = useState(false);
  const agentCfg = block.compactedBy ? AGENT_CONFIG[block.compactedBy] : null;
  return (
    <div className="aa-compacted-block">
      <div className="aa-compacted-card">
        <div className="aa-compacted-header">
          <div className="aa-compacted-header-left">
            <CompactIcon />
            <span className="aa-compacted-label">Compacted</span>
            {agentCfg && <span className="aa-compacted-by">by {agentCfg.name}</span>}
          </div>
          <button className="aa-compacted-toggle" onClick={() => setExp(!exp)}>{exp ? 'hide original' : 'show original'}</button>
        </div>
        <div className="aa-compacted-summary">{block.compactedSummary || ''}</div>
      </div>
      {exp && (
        <div className="aa-compacted-original">
          <div className="aa-compacted-original-label">Original messages:</div>
          <div className="aa-compacted-original-user">User: "{block.userMessage.content}"</div>
          {Object.entries(block.responses).map(([k, agent]) => (
            <div key={k} className="aa-compacted-original-agent">
              <span style={{ color: agent.agentColor }}>{agent.agentName}:</span>{' '}
              {agent.messages.filter(m => m.type === 'assistant').map(m => m.content.slice(0, 80) + '...').join(' | ')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ContextDriftBadge = () => (
  <div className="aa-context-drift" title="This message was generated before context was modified. Responses may reference removed content.">
    <WarningIcon /> <span>context modified above -- response may reference removed content</span>
  </div>
);

// ═══════════════════════════════════════════════════════════════
// FORK DIVIDER + RANGE ACTION BAR
// ═══════════════════════════════════════════════════════════════

function AAForkDivider({ index, rangeStartIndex, rangeEndIndex, onFork, onSetRangeStart, onClearRange, onExtract, onRemove, onCompact }: {
  index: number;
  rangeStartIndex: number | null;
  rangeEndIndex: number | null;
  onFork: (idx: number) => void;
  onSetRangeStart: (idx: number) => void;
  onClearRange: () => void;
  onExtract: () => void;
  onRemove: () => void;
  onCompact: (agent: string) => void;
}) {
  const [hov, setHov] = useState(false);
  const [shift, setShift] = useState(false);
  const [compactPick, setCompactPick] = useState(false);

  const isRS = rangeStartIndex === index;
  const isRE = rangeEndIndex === index;
  const hasR = rangeStartIndex !== null;
  const above = hasR && !isRS && index < rangeStartIndex!;
  const below = hasR && !isRS && !isRE && index > rangeStartIndex!;
  const dis = above;

  useEffect(() => {
    const d = (e: KeyboardEvent) => { if (e.key === 'Shift') setShift(true); };
    const u = (e: KeyboardEvent) => { if (e.key === 'Shift') setShift(false); };
    window.addEventListener('keydown', d);
    window.addEventListener('keyup', u);
    return () => { window.removeEventListener('keydown', d); window.removeEventListener('keyup', u); };
  }, []);

  const click = () => {
    if (dis || isRE) return;
    if (isRS) { onClearRange(); return; }
    if (hasR && below) { onFork(index); return; }
    if (shift) { onSetRangeStart(index); return; }
    onFork(index);
  };

  // Range end: show action buttons
  if (isRE) {
    return (
      <div className="aa-range-bar">
        <div className="aa-range-bar-line" />
        <div className="aa-range-bar-actions">
          {!compactPick ? (
            <>
              <button className="cancel" onClick={onClearRange}>Cancel</button>
              <button className="extract" onClick={onExtract}><ExtractIcon /> New Context</button>
              <button className="remove" onClick={onRemove}><TrashIcon /> Remove</button>
              <button className="compact" onClick={() => setCompactPick(true)}><CompactIcon /> Compact</button>
            </>
          ) : (
            <>
              <button className="back" onClick={() => setCompactPick(false)}>&larr;</button>
              <span className="pick-label">Compact with:</span>
              {Object.entries(AGENT_CONFIG).filter(([, c]) => c.enabled).map(([k, cfg]) => (
                <button key={k} className="agent-pick" style={{ color: cfg.color }} onClick={() => { onCompact(k); setCompactPick(false); }}>{cfg.name}</button>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  let cls = 'aa-fork-divider';
  if (dis) cls += ' disabled';
  else if (isRS) cls += ' range-start';
  else if (below && hov) cls += ' range-below';
  else if (shift && hov && !hasR) cls += ' shift-hover';

  let label = 'Fork here', hint: string | null = 'hold Shift for range';
  if (isRS) { label = 'Range start'; hint = 'click to clear'; }
  else if (below && hov) { label = 'Range end'; hint = null; }
  else if (shift && hov && !dis) { label = 'Set range start'; hint = null; }

  return (
    <div
      className={cls}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={click}
    >
      <div className="aa-fork-divider-line" />
      <div className="aa-fork-divider-pill">
        <span className="label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// BRANCH SWITCHER
// ═══════════════════════════════════════════════════════════════

function BranchSwitcher({ fork, onSwitch }: { fork: AtooFork; onSwitch: (forkId: string, branchIdx: number) => void }) {
  const total = fork.branches.length;
  const active = fork.activeBranchIndex;
  const branch = fork.branches[active];
  const color = active === 0 ? 'var(--text-secondary)' : BRANCH_COLORS[(active - 1) % BRANCH_COLORS.length];
  const prev = () => onSwitch(fork.id, (active - 1 + total) % total);
  const next = () => onSwitch(fork.id, (active + 1) % total);

  return (
    <div className="aa-branch-switcher">
      <div className="aa-branch-line" />
      <div className="aa-branch-bar">
        <div className="aa-branch-bar-icon">
          <ForkIconSvg /><span className="label">FORK</span>
        </div>
        {total > 1 && <button className="aa-branch-nav-btn left" onClick={prev}>&lsaquo;</button>}
        <div className="aa-branch-label" style={{ color }}>
          {branch.label}
          <span className="count">{active + 1}/{total}</span>
        </div>
        {total > 1 && <button className="aa-branch-nav-btn right" onClick={next}>&rsaquo;</button>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TREE MINIMAP
// ═══════════════════════════════════════════════════════════════

function TreeMinimap({ blocks, forks, extractions, open, onToggle, onSwitchBranch, onScrollTo }: {
  blocks: MsgBlock[];
  forks: AtooFork[];
  extractions: AtooExtraction[];
  open: boolean;
  onToggle: () => void;
  onSwitchBranch: (fId: string, bIdx: number) => void;
  onScrollTo: (index: number) => void;
}) {
  if (!open) return null;
  const forkMap: Record<number, AtooFork> = {};
  forks.forEach(f => { forkMap[f.forkPointIndex] = f; });

  return (
    <div className="aa-minimap">
      <div className="aa-minimap-header">
        <span className="aa-minimap-title">Conversation Tree</span>
        <button className="aa-minimap-close" onClick={onToggle}>&times;</button>
      </div>
      {blocks.map((block, i) => {
        const fork = forkMap[i + 1];
        const isRemoved = block.status === 'removed';
        const isCompacted = block.status === 'compacted';
        const content = typeof block.userMessage.content === 'string' ? block.userMessage.content : '';
        return (
          <div key={block.id}>
            <div className="aa-minimap-item" onClick={() => onScrollTo(i)}>
              <div className={`aa-minimap-dot ${isRemoved ? 'removed' : isCompacted ? 'compacted' : ''}`}
                style={!isRemoved && !isCompacted ? { background: 'var(--aa-text-tertiary)' } : undefined} />
              <span className={`aa-minimap-label ${isRemoved ? 'removed' : ''}`}>
                {isCompacted && '\u25C6 '}{content.slice(0, 28)}{content.length > 28 ? '...' : ''}
              </span>
            </div>
            {i < blocks.length - 1 && !fork && <div className="aa-minimap-connector" />}
            {fork && (
              <div style={{ marginLeft: 7.5, padding: '2px 0' }}>
                {fork.branches.map((b, bi) => {
                  const isActive = bi === fork.activeBranchIndex;
                  const c = bi === 0 ? 'var(--aa-text-tertiary)' : BRANCH_COLORS[(bi - 1) % BRANCH_COLORS.length];
                  return (
                    <div key={b.id} className="aa-minimap-branch"
                      onClick={() => onSwitchBranch(fork.id, bi)}
                      style={{ borderLeft: `2px solid ${isActive ? c : 'var(--border-subtle)'}` }}>
                      <div className="aa-minimap-branch-dot" style={{ background: c, opacity: isActive ? 1 : 0.3 }} />
                      <span className="aa-minimap-branch-label" style={{ color: isActive ? c : 'var(--aa-text-tertiary)', fontWeight: isActive ? 600 : 400 }}>{b.label}</span>
                      <span className="aa-minimap-branch-count">{b.messages.length}m</span>
                    </div>
                  );
                })}
                <div className="aa-minimap-connector" style={{ marginLeft: 0 }} />
              </div>
            )}
          </div>
        );
      })}
      {extractions.length > 0 && (
        <div className="aa-minimap-section">
          <span className="aa-minimap-section-title">Extractions</span>
          {extractions.map(ext => (
            <div key={ext.id} className="aa-minimap-item" style={{ marginTop: 4 }}>
              <ExtractIcon />
              <span className="aa-minimap-branch-label" style={{ color: '#a78bfa' }}>{ext.label}</span>
              <span className="aa-minimap-branch-count">{ext.extractedMessages.length}m</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// USER MESSAGE
// ═══════════════════════════════════════════════════════════════

function UserMessage({ msg }: { msg: FilteredMessage }) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return (
    <div className="aa-user-msg">
      <div className="aa-user-msg-bubble">
        {content}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE BLOCK (user msg + responses)
// ═══════════════════════════════════════════════════════════════

function MsgBlockView({ block, vw }: { block: MsgBlock; vw: number }) {
  const [layouts, setLayouts] = useState<Record<string, string>>({});
  const re = Object.entries(block.responses);
  const multi = re.length > 1;
  const layout = multi ? (layouts[block.id] || (vw >= COLUMN_BREAKPOINT ? 'column' : 'row')) : 'row';
  const isCol = multi && layout === 'column';

  return (
    <div className="aa-msg-block">
      <UserMessage msg={block.userMessage} />
      <div className="aa-msg-agents-bar">
        <div className="aa-msg-agents-tags">
          {block.triggeredAgents.map(a => {
            const c = AGENT_CONFIG[a];
            return c ? <span key={a} className={`aa-agent-tag ${c.cssClass}`}>{c.name}</span> : null;
          })}
        </div>
        {multi && <LayoutToggle layout={layout} onChange={l => setLayouts(p => ({ ...p, [block.id]: l }))} />}
      </div>
      <div className={`aa-responses ${isCol ? 'column' : 'row'}`}>
        {re.map(([k, a]) => <AgentGroup key={k} agent={a} isCol={isCol} />)}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// INPUT BAR (with attachment system)
// ═══════════════════════════════════════════════════════════════

function AtooAnyInputBar({ session, proj }: { session: Session; proj: any }) {
  const { chatAttachments, clearChatAttachments, addChatAttachment, addToast } = useStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['claude', 'codex']);

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
    if (selectedAgents.length > 0) cmd.agents = selectedAgents;
    sendAgentCommand(session.id, cmd);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      sendMessage();
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
        if (file) {
          const dt = new DataTransfer();
          dt.items.add(file);
          handleFileAttach(dt.files);
        }
      }
    }
  };

  const toggleAgent = (agent: string) => {
    setSelectedAgents(prev => {
      if (prev.includes(agent)) {
        if (prev.length <= 1) return prev;
        return prev.filter(a => a !== agent);
      }
      return [...prev, agent];
    });
  };

  const allSelected = selectedAgents.length === Object.keys(AGENT_CONFIG).filter(k => AGENT_CONFIG[k].enabled).length;

  return (
    <div className="aa-input-bar-wrapper">
      <AttachmentsBar />
      <div className="aa-input-bar-inner">
        <button className="aa-attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach file"><AttachIcon /></button>
        <input type="file" ref={fileInputRef} multiple style={{ display: 'none' }} onChange={(e) => handleFileAttach(e.target.files)} />
        <textarea
          className="aa-input-field"
          ref={inputRef}
          placeholder="Message your agents..."
          onKeyDown={handleKey}
          onPaste={handlePaste}
          rows={1}
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
        />
        <div className="aa-input-send-btns">
          {Object.entries(AGENT_CONFIG).map(([k, cfg]) => (
            <button
              key={k}
              className={`aa-input-agent-btn ${cfg.cssClass} ${selectedAgents.includes(k) ? 'active' : ''}`}
              onClick={() => cfg.enabled ? toggleAgent(k) : undefined}
              disabled={!cfg.enabled}
              title={cfg.enabled ? `Send to ${cfg.name}` : `${cfg.name} (coming soon)`}
            >
              {cfg.name}
            </button>
          ))}
          <button
            className={`aa-input-agent-btn all ${allSelected ? 'active' : ''}`}
            onClick={() => {
              const enabled = Object.keys(AGENT_CONFIG).filter(k => AGENT_CONFIG[k].enabled);
              setSelectedAgents(allSelected ? [enabled[0]] : enabled);
            }}
          >
            All
          </button>
        </div>
      </div>
    </div>
  );
}

function AttachmentsBar() {
  const { chatAttachments, removeChatAttachment } = useStore();
  if (chatAttachments.length === 0) return null;
  return (
    <div className="chat-attachments has-items" style={{ maxWidth: 1200, margin: '0 auto 8px', paddingLeft: 48 }}>
      {chatAttachments.map(att => {
        const size = att.size < 1024 ? att.size + ' B' : att.size < 1048576 ? (att.size / 1024).toFixed(1) + ' KB' : (att.size / 1048576).toFixed(1) + ' MB';
        const icon = getAttachIcon(att.kind || 'image');
        return (
          <div key={att.id} className="chat-attach-chip">
            <span className="chat-attach-chip-icon">{icon}</span>
            <span className="chat-attach-chip-name">{att.name}</span>
            <span className="chat-attach-chip-size">{size}</span>
            <span className="chat-attach-chip-remove" onClick={() => removeChatAttachment(att.id)}>&times;</span>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export function AtooAnyChat({ session, proj }: { session: Session; proj: any }) {
  const [vw, setVw] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const [forks, setForks] = useState<AtooFork[]>(session.forks || []);
  const [extractions, setExtractions] = useState<AtooExtraction[]>(session.extractions || []);
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    const h = () => setVw(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  // Build message blocks from filtered messages
  const filtered = filterMessages(session.messages, true);
  const blocks = useMemo(() => buildMsgBlocks(filtered), [filtered]);

  // Fork map
  const forkMap = useMemo(() => {
    const m: Record<number, AtooFork> = {};
    forks.forEach(f => { m[f.forkPointIndex] = f; });
    return m;
  }, [forks]);

  // Fork actions
  const handleFork = useCallback((idx: number) => {
    if (rangeStart !== null && idx > rangeStart) {
      setRangeEnd(idx);
      return;
    }
    const newBranch: AtooBranch = { id: `b-${Date.now()}`, label: `Branch ${forks.reduce((a, f) => a + f.branches.length, 0) + 1}`, messages: [], isOriginal: false };
    const existing = forks.find(f => f.forkPointIndex === idx);
    if (existing) {
      setForks(p => p.map(f => f.id === existing.id ? { ...f, branches: [...f.branches, newBranch], activeBranchIndex: f.branches.length } : f));
    } else {
      setForks(p => [...p, { id: `fork-${Date.now()}`, forkPointIndex: idx, branches: [{ id: `b-orig-${Date.now()}`, label: 'Original', messages: [], isOriginal: true }, newBranch], activeBranchIndex: 1 }]);
    }
  }, [forks, rangeStart]);

  const handleSwitchBranch = useCallback((fId: string, bIdx: number) => setForks(p => p.map(f => f.id === fId ? { ...f, activeBranchIndex: bIdx } : f)), []);

  // Range actions (local state mutations — backend persistence via WS commands later)
  const handleRangeExtract = useCallback(() => {
    if (rangeStart === null || rangeEnd === null) return;
    const start = Math.min(rangeStart, rangeEnd);
    const end = Math.max(rangeStart, rangeEnd);
    const extracted = blocks.slice(start, end + 1).map(b => b.userMessage);
    setExtractions(p => [...p, { id: `ext-${Date.now()}`, label: `Extract ${p.length + 1}`, sourceConversation: 'main', sourceRange: [start, end], extractedMessages: extracted }]);
    setRangeStart(null);
    setRangeEnd(null);
  }, [rangeStart, rangeEnd, blocks]);

  const handleRangeRemove = useCallback(() => {
    if (rangeStart === null || rangeEnd === null) return;
    const start = Math.min(rangeStart, rangeEnd);
    const end = Math.max(rangeStart, rangeEnd);
    // Mutate status on the messages in store
    const store = useStore.getState();
    const p = store.getActiveProject();
    if (!p) { setRangeStart(null); setRangeEnd(null); return; }
    const sess = p.sessions.find(s => s.id === session.id);
    if (!sess) { setRangeStart(null); setRangeEnd(null); return; }
    // Mark user messages by index as removed
    const userMsgs = sess.messages.filter(m => m.role === 'user' && !m._parentToolUseId);
    for (let i = start; i <= end && i < userMsgs.length; i++) {
      userMsgs[i]._msgStatus = 'removed';
    }
    // Mark messages after range as context drift
    for (let i = end + 1; i < userMsgs.length; i++) {
      if (!userMsgs[i]._msgStatus || userMsgs[i]._msgStatus === 'visible') {
        userMsgs[i]._contextDrift = true;
      }
    }
    store.updateProject(p.id, pp => ({ ...pp }));
    setRangeStart(null);
    setRangeEnd(null);
  }, [rangeStart, rangeEnd, session.id]);

  const handleRangeCompact = useCallback((agent: string) => {
    if (rangeStart === null || rangeEnd === null) return;
    const start = Math.min(rangeStart, rangeEnd);
    const end = Math.max(rangeStart, rangeEnd);
    const store = useStore.getState();
    const p = store.getActiveProject();
    if (!p) { setRangeStart(null); setRangeEnd(null); return; }
    const sess = p.sessions.find(s => s.id === session.id);
    if (!sess) { setRangeStart(null); setRangeEnd(null); return; }
    const userMsgs = sess.messages.filter(m => m.role === 'user' && !m._parentToolUseId);
    for (let i = start; i <= end && i < userMsgs.length; i++) {
      if (i === start) {
        userMsgs[i]._msgStatus = 'compacted';
        userMsgs[i]._compactedSummary = `[Auto-compacted ${end - start + 1} messages by ${AGENT_CONFIG[agent]?.name}. Summary would be generated by the selected agent.]`;
        userMsgs[i]._compactedBy = agent;
      } else {
        userMsgs[i]._msgStatus = 'removed';
      }
    }
    for (let i = end + 1; i < userMsgs.length; i++) {
      if (!userMsgs[i]._msgStatus || userMsgs[i]._msgStatus === 'visible') {
        userMsgs[i]._contextDrift = true;
      }
    }
    store.updateProject(p.id, pp => ({ ...pp }));
    setRangeStart(null);
    setRangeEnd(null);
  }, [rangeStart, rangeEnd, session.id]);

  const handleRestore = useCallback((id: string) => {
    const store = useStore.getState();
    const p = store.getActiveProject();
    if (!p) return;
    const sess = p.sessions.find(s => s.id === session.id);
    if (!sess) return;
    const msg = sess.messages.find(m => m._eventUuid === id);
    if (msg) {
      msg._msgStatus = 'visible';
      store.updateProject(p.id, pp => ({ ...pp }));
    }
  }, [session.id]);

  const handleScrollTo = useCallback((index: number) => {
    virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' });
  }, []);

  // Status line
  const statusNode = session.status === 'active'
    ? <div className="aa-status-line active">&#9679; Agents are working...</div>
    : session.status === 'attention'
    ? <div className="aa-status-line attention">&#9203; Waiting for your input</div>
    : null;

  return (
    <div className="aa-chat">
      {/* Header */}
      <div className="aa-header">
        <div className="aa-header-left">
          <div className="aa-header-logo">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L14 6v4l-6 4-6-4V6l6-4z" stroke="white" strokeWidth="1.3" fill="none" /><circle cx="8" cy="8" r="2" fill="white" opacity="0.8" /></svg>
          </div>
          <div>
            <div className="aa-header-title">Agent Chat</div>
            <div className="aa-header-agents">
              {Object.entries(AGENT_CONFIG).map(([k, c]) => (
                <span key={k} className="aa-header-agent-dot">
                  <span className="aa-header-agent-dot-circle" style={{ background: c.color, opacity: c.enabled ? 1 : 0.3 }} />
                  {c.name}{!c.enabled && ' (soon)'}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="aa-header-right">
          {forks.length > 0 && <span className="aa-header-stat"><ForkIconSvg /> {forks.length}</span>}
          {extractions.length > 0 && <span className="aa-header-stat dim"><ExtractIcon /> {extractions.length}</span>}
          <button className={`aa-tree-btn ${mapOpen ? 'active' : ''}`} onClick={() => setMapOpen(o => !o)}><MapIcon /> Tree</button>
        </div>
      </div>

      {/* Tree minimap */}
      <TreeMinimap
        blocks={blocks}
        forks={forks}
        extractions={extractions}
        open={mapOpen}
        onToggle={() => setMapOpen(o => !o)}
        onSwitchBranch={handleSwitchBranch}
        onScrollTo={handleScrollTo}
      />

      {/* Virtualized chat area */}
      <Virtuoso
        ref={virtuosoRef}
        className="aa-chat-area"
        style={{ paddingBottom: 80 }}
        totalCount={blocks.length}
        overscan={10}
        followOutput="smooth"
        itemContent={(index) => {
          const block = blocks[index];
          const fork = forkMap[index + 1];

          return (
            <div className="aa-chat-item">
              {/* Fork divider above message (skip first) */}
              {index > 0 && block.status !== 'removed' && (
                <AAForkDivider
                  index={index}
                  rangeStartIndex={rangeStart}
                  rangeEndIndex={rangeEnd}
                  onFork={handleFork}
                  onSetRangeStart={setRangeStart}
                  onClearRange={() => { setRangeStart(null); setRangeEnd(null); }}
                  onExtract={handleRangeExtract}
                  onRemove={handleRangeRemove}
                  onCompact={handleRangeCompact}
                />
              )}

              {/* Message rendering by status */}
              {block.status === 'removed' && <RemovedBlock block={block} onRestore={handleRestore} />}
              {block.status === 'compacted' && <CompactedBlock block={block} />}
              {block.status === 'visible' && (
                <>
                  {block.contextDrift && <ContextDriftBadge />}
                  <MsgBlockView block={block} vw={vw} />
                </>
              )}

              {/* Branch switcher + content at fork points */}
              {fork && <BranchSwitcher fork={fork} onSwitch={handleSwitchBranch} />}
              {fork && fork.branches[fork.activeBranchIndex] && (
                <div className={`aa-branch-content ${fork.activeBranchIndex > 0 ? 'alt' : ''}`}>
                  {fork.activeBranchIndex > 0 && (
                    <div className="aa-branch-accent-bar" style={{
                      background: `linear-gradient(180deg, ${BRANCH_COLORS[(fork.activeBranchIndex - 1) % BRANCH_COLORS.length]}66 0%, ${BRANCH_COLORS[(fork.activeBranchIndex - 1) % BRANCH_COLORS.length]}11 100%)`
                    }} />
                  )}
                </div>
              )}

              {/* Status line after last message */}
              {index === blocks.length - 1 && statusNode}
            </div>
          );
        }}
      />

      {/* Input bar */}
      <AtooAnyInputBar session={session} proj={proj} />
    </div>
  );
}
