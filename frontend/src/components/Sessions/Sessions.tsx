import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';
import { escapeHtml } from '../../utils';
import { toRawHex, parseLinkType, getParentLink } from '../../utils/session-id-utils';
import type { LinkType } from '../../utils/session-id-utils';
import type { AgentDescriptor } from '../../types';

// ═══════════════════════════════════════════════════════
// Data structures
// ═══════════════════════════════════════════════════════

interface RawNode {
  id: string;
  kind: 'active' | 'historical';
  data: any;
  linkType: LinkType | null;
  idx: number;
}

/** A chain group: one or more chain-linked sessions displayed as a carousel */
interface ChainGroup {
  type: 'chain';
  /** Chain links ordered oldest → newest */
  links: RawNode[];
  /** Sort key for ordering in the list (most recent link's timestamp) */
  sortTime: number;
}

/** A single session (fork or root, not part of a chain) */
interface SingleSession {
  type: 'single';
  node: RawNode;
  /** If this is a fork, the parent session ID */
  parentId: string | null;
  /** Parent session title (for display) */
  parentTitle: string | null;
  sortTime: number;
}

type DisplayItem = ChainGroup | SingleSession;

// ═══════════════════════════════════════════════════════
// Build display items from raw sessions
// ═══════════════════════════════════════════════════════

function buildDisplayItems(
  activeSessions: { id: string; [k: string]: any }[],
  historicalSessions: { id: string; [k: string]: any }[],
): DisplayItem[] {
  const all: RawNode[] = [
    ...activeSessions.map((s, i) => ({
      id: s.id, kind: 'active' as const, data: s, linkType: parseLinkType(s.id), idx: i,
    })),
    ...historicalSessions.map((s, i) => ({
      id: s.id, kind: 'historical' as const, data: s, linkType: parseLinkType(s.id), idx: activeSessions.length + i,
    })),
  ];

  if (all.length === 0) return [];

  // Build parent lookup: last16 hex → node
  const last16Map = new Map<string, RawNode>();
  const nodeById = new Map<string, RawNode>();
  for (const node of all) {
    nodeById.set(node.id, node);
    const hex = toRawHex(node.id);
    if (hex.length >= 16) {
      last16Map.set(hex.slice(-16), node);
    }
  }

  // Find parent for each node
  const parentOf = new Map<string, RawNode>();
  for (const node of all) {
    const hex = toRawHex(node.id);
    const first16 = hex.slice(0, 16);
    const parent = last16Map.get(first16);
    if (parent && parent.id !== node.id) {
      parentOf.set(node.id, parent);
    }
  }

  // Build chains: follow chain links (linkType === 'chain') to group them
  // A chain is: root → chain child → chain child → ...
  const inChain = new Set<string>();
  const chains: RawNode[][] = [];

  // Find chain roots: nodes that have chain children
  // Walk forward from each node to build chains
  const childrenOf = new Map<string, RawNode[]>();
  for (const node of all) {
    const parent = parentOf.get(node.id);
    if (parent && node.linkType === 'chain') {
      const siblings = childrenOf.get(parent.id) || [];
      siblings.push(node);
      childrenOf.set(parent.id, siblings);
    }
  }

  // Walk chains starting from roots (nodes that are not chain-children themselves)
  function walkChainForward(start: RawNode): RawNode[] {
    const chain = [start];
    let current = start;
    while (true) {
      const chainChildren = (childrenOf.get(current.id) || []).filter(c => c.linkType === 'chain');
      if (chainChildren.length === 0) break;
      // If multiple chain children, take the most recent
      chainChildren.sort((a, b) => getNodeTime(b) - getNodeTime(a));
      const next = chainChildren[0];
      chain.push(next);
      current = next;
    }
    return chain;
  }

  // Find all chain roots and build chain groups
  for (const node of all) {
    if (inChain.has(node.id)) continue;
    // A node starts a chain if it has chain children and is not itself a chain child
    const isChainChild = node.linkType === 'chain' && parentOf.has(node.id);
    if (isChainChild) continue;

    const chainChildren = (childrenOf.get(node.id) || []).filter(c => c.linkType === 'chain');
    if (chainChildren.length > 0) {
      const chain = walkChainForward(node);
      for (const n of chain) inChain.add(n.id);
      chains.push(chain);
    }
  }

  // Build display items
  const items: DisplayItem[] = [];

  // Add chain groups
  for (const chain of chains) {
    const sortTime = getNodeTime(chain[chain.length - 1]);
    items.push({ type: 'chain', links: chain, sortTime });
  }

  // Add single sessions (not part of any chain)
  for (const node of all) {
    if (inChain.has(node.id)) continue;

    let parentId: string | null = null;
    let parentTitle: string | null = null;
    const parent = parentOf.get(node.id);
    if (parent && node.linkType === 'fork') {
      parentId = parent.id;
      parentTitle = parent.data.title || 'Untitled';
    }

    items.push({
      type: 'single',
      node,
      parentId,
      parentTitle,
      sortTime: getNodeTime(node),
    });
  }

  // Sort: active items first (by creation order), then by sortTime descending
  items.sort((a, b) => {
    const aActive = isItemActive(a);
    const bActive = isItemActive(b);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    if (aActive && bActive) return getItemIdx(a) - getItemIdx(b);
    return b.sortTime - a.sortTime;
  });

  return items;
}

function getNodeTime(node: RawNode): number {
  if (node.kind === 'historical') {
    return new Date(node.data.lastModified).getTime();
  }
  return node.data.createdAt || Date.now();
}

function isItemActive(item: DisplayItem): boolean {
  if (item.type === 'chain') {
    return item.links.some(n => n.kind === 'active');
  }
  return item.node.kind === 'active';
}

function getItemIdx(item: DisplayItem): number {
  if (item.type === 'chain') {
    return Math.min(...item.links.map(n => n.idx));
  }
  return item.node.idx;
}

// ═══════════════════════════════════════════════════════
// Components
// ═══════════════════════════════════════════════════════

function ChainCarousel({ group, agentIcons, projectId, openSessionIds }: {
  group: ChainGroup;
  agentIcons: Map<string, string>;
  projectId: string;
  openSessionIds: Set<string>;
}) {
  const [activeSlide, setActiveSlide] = useState(group.links.length - 1);
  const current = group.links[activeSlide];
  if (!current) return null;

  const isOpen = openSessionIds.has(current.id);
  const isActive = current.kind === 'active' && current.data.status !== 'ended';

  const handleClick = () => {
    if (isOpen) return;
    // Always resume the latest chain link
    const latest = group.links[group.links.length - 1];
    if (latest.kind === 'active') {
      (window as any).resumeSession(projectId, latest.id);
    } else {
      (window as any).resumeHistoricalSession(projectId, latest.id);
    }
  };

  return (
    <div
      id={`session-${current.id}`}
      className={`session-item${isActive ? ' session-running' : ''}${isOpen ? ' session-open' : ''}`}
      onClick={handleClick}
      style={{ paddingLeft: '10px' }}
    >
      {current.data.agentType && agentIcons.get(current.data.agentType) && (
        <img src={agentIcons.get(current.data.agentType)} alt="" className="session-agent-icon" />
      )}
      <SessionStatusDot node={current} />
      <div className="session-info">
        <div className="session-title">
          {current.kind === 'historical' ? escapeHtml(current.data.title) : current.data.title}
        </div>
        <SessionMeta node={current} />
        {/* Carousel dots */}
        {group.links.length > 1 && (
          <div className="session-chain-dots">
            {group.links.map((link, i) => (
              <button
                key={link.id}
                className={`session-chain-dot${i === activeSlide ? ' active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setActiveSlide(i); }}
                title={`Chain link ${i + 1}`}
              />
            ))}
          </div>
        )}
      </div>
      {!isOpen && (
        <button className="session-resume-btn" onClick={(e) => { e.stopPropagation(); handleClick(); }}>Resume</button>
      )}
      {isOpen && (
        <span className="session-open-label">Open</span>
      )}
    </div>
  );
}

function SingleSessionCard({ item, agentIcons, projectId, openSessionIds }: {
  item: SingleSession;
  agentIcons: Map<string, string>;
  projectId: string;
  openSessionIds: Set<string>;
}) {
  const { node, parentId, parentTitle } = item;
  const s = node.data;

  const isOpen = openSessionIds.has(node.id);
  const isActive = node.kind === 'active' && s.status !== 'ended';
  const canResume = !isOpen && (node.kind === 'historical' || s.status === 'ended' || s.status === 'open');

  const handleClick = () => {
    if (isOpen) return;
    if (node.kind === 'active') {
      (window as any).resumeSession(projectId, s.id);
    } else {
      (window as any).resumeHistoricalSession(projectId, s.id);
    }
  };

  const scrollToParent = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!parentId) return;
    const el = document.getElementById(`session-${parentId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      el.classList.add('session-highlight');
      setTimeout(() => el.classList.remove('session-highlight'), 1500);
    }
  };

  return (
    <div
      id={`session-${node.id}`}
      className={`session-item${isActive ? ' session-running' : ''}${isOpen ? ' session-open' : ''}${node.kind === 'historical' ? ' session-historical' : ''}`}
      onClick={handleClick}
      style={{ paddingLeft: '10px' }}
    >
      {s.agentType && agentIcons.get(s.agentType) && (
        <img src={agentIcons.get(s.agentType)} alt="" className="session-agent-icon" />
      )}
      <SessionStatusDot node={node} />
      <div className="session-info">
        <div className="session-title">
          {node.kind === 'historical' ? escapeHtml(s.title) : s.title}
        </div>
        <SessionMeta node={node} />
        {parentId && parentTitle && (
          <div className="session-fork-link" onClick={scrollToParent}>
            forked from {parentTitle.length > 30 ? parentTitle.substring(0, 30) + '...' : parentTitle}
          </div>
        )}
      </div>
      {canResume && (
        <button className="session-resume-btn" onClick={(e) => { e.stopPropagation(); handleClick(); }}>Resume</button>
      )}
      {isOpen && (
        <span className="session-open-label">Open</span>
      )}
    </div>
  );
}

function SessionStatusDot({ node }: { node: RawNode }) {
  if (node.kind === 'historical') {
    return <div className="session-status-dot ended" />;
  }
  const s = node.data;
  const cls = s.status === 'ended' ? 'ended'
    : s.status === 'attention' ? 'waiting'
    : s.status === 'active' ? 'live'
    : 'ended';
  return <div className={`session-status-dot ${cls}`} />;
}

function SessionMeta({ node }: { node: RawNode }) {
  if (node.kind === 'historical') {
    const d = new Date(node.data.lastModified);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return (
      <div className="session-meta">
        <span>{dateStr} {timeStr}</span>
        <span>{node.data.eventCount} events</span>
      </div>
    );
  }
  return (
    <div className="session-meta">
      <span>{node.data.startedAt || ''}</span>
      <span>{node.data.status}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Main panel
// ═══════════════════════════════════════════════════════

export function SessionsPanel() {
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);

  const [agentIcons, setAgentIcons] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    api('GET', '/api/available-agents')
      .then((agents: AgentDescriptor[]) => {
        const map = new Map<string, string>();
        for (const a of agents) {
          map.set(a.agentType, a.iconUrl);
        }
        setAgentIcons(map);
      })
      .catch(() => {});
  }, []);

  if (!proj) return null;

  // Build set of session IDs currently open in tabs
  const openSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of proj.sessions) {
      if (s.status !== 'ended') ids.add(s.id);
    }
    return ids;
  }, [proj.sessions]);

  const items = useMemo(
    () => buildDisplayItems(proj.sessions, proj.historicalSessions || []),
    [proj.sessions, proj.historicalSessions],
  );

  return (
    <div className="session-list">
      {items.map(item => {
        if (item.type === 'chain') {
          const key = item.links.map(l => l.id).join('-');
          return (
            <ChainCarousel
              key={key}
              group={item}
              agentIcons={agentIcons}
              projectId={proj.id}
              openSessionIds={openSessionIds}
            />
          );
        }
        return (
          <SingleSessionCard
            key={item.node.id}
            item={item}
            agentIcons={agentIcons}
            projectId={proj.id}
            openSessionIds={openSessionIds}
          />
        );
      })}
    </div>
  );
}
