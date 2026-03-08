import React, { useMemo } from 'react';
import { useStore } from '../../state/store';
import { escapeHtml } from '../../utils';

/**
 * Extract raw hex (no dashes, no prefix) from a session ID.
 * Handles agent_<uuid>, sess_<uuid>, or bare <uuid>.
 */
function toHex(id: string): string {
  return id.replace(/^(agent_|sess_)/, '').replace(/-/g, '');
}

interface TreeNode {
  id: string;
  depth: number;
  kind: 'active' | 'historical';
  data: any;
}

/**
 * Build a depth-annotated flat list from sessions using parent-linked UUIDs.
 * A session is a child if its first 16 hex chars match another session's last 16 hex chars.
 * Children are placed immediately after their parent, recursively.
 */
function buildTree(
  activeSessions: { id: string; [k: string]: any }[],
  historicalSessions: { id: string; [k: string]: any }[],
): TreeNode[] {
  // idx preserves original array order as a stable sort fallback
  const all = [
    ...activeSessions.map((s, i) => ({ id: s.id, kind: 'active' as const, data: s, idx: i })),
    ...historicalSessions.map((s, i) => ({ id: s.id, kind: 'historical' as const, data: s, idx: activeSessions.length + i })),
  ];

  if (all.length === 0) return [];

  // Build parent lookup: last16 hex → node id
  const last16Map = new Map<string, string>();
  for (const node of all) {
    const hex = toHex(node.id);
    if (hex.length >= 16) {
      last16Map.set(hex.slice(-16), node.id);
    }
  }

  // Build children map: parentId → children[]
  const childrenOf = new Map<string, typeof all>();
  const roots: typeof all = [];

  for (const node of all) {
    const hex = toHex(node.id);
    const first16 = hex.slice(0, 16);
    const parentId = last16Map.get(first16);

    // A node is a child if its first16 matches a DIFFERENT node's last16
    if (parentId && parentId !== node.id) {
      const siblings = childrenOf.get(parentId) || [];
      siblings.push(node);
      childrenOf.set(parentId, siblings);
    } else {
      roots.push(node);
    }
  }

  // Sort siblings: most recent first within each sibling group
  // Historical sessions sort by lastModified; active sessions preserve original array order
  function sortSiblings(nodes: typeof all) {
    nodes.sort((a, b) => {
      // Historical sessions: sort by lastModified descending
      if (a.kind === 'historical' && b.kind === 'historical') {
        return new Date(b.data.lastModified).getTime() - new Date(a.data.lastModified).getTime();
      }
      // Active sessions: preserve original creation order (lower idx = older = appears first)
      if (a.kind === 'active' && b.kind === 'active') {
        return a.idx - b.idx;
      }
      // Mixed: active before historical (active sessions are more relevant)
      return a.kind === 'active' ? -1 : 1;
    });
  }

  sortSiblings(roots);
  for (const children of childrenOf.values()) {
    sortSiblings(children);
  }

  // Flatten tree with depth annotation
  const result: TreeNode[] = [];

  function walk(nodes: typeof all, depth: number) {
    for (const node of nodes) {
      result.push({ id: node.id, depth, kind: node.kind, data: node.data });
      const children = childrenOf.get(node.id);
      if (children) walk(children, depth + 1);
    }
  }

  walk(roots, 0);
  return result;
}

export function SessionsPanel() {
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  if (!proj) return null;

  const tree = useMemo(
    () => buildTree(proj.sessions, proj.historicalSessions || []),
    [proj.sessions, proj.historicalSessions],
  );

  // Split into active and historical sections, preserving tree order
  const activeNodes = tree.filter(n => n.kind === 'active');
  const historicalNodes = tree.filter(n => n.kind === 'historical');

  return (
    <div className="session-list">
      {activeNodes.map(n => {
        const s = n.data;
        return (
          <div key={s.id} className={`session-item ${s.status !== 'ended' ? 'active-session' : ''}`}
               style={{ paddingLeft: `${10 + n.depth * 16}px` }}>
            {n.depth > 0 && <span className="session-tree-line" />}
            <div className={`session-status-dot ${s.status === 'ended' ? 'ended' : s.status === 'waiting' ? 'waiting' : s.status === 'running' ? 'live' : 'ended'}`}></div>
            <div className="session-info">
              <div className="session-title">{s.title}</div>
              <div className="session-meta"><span>{s.startedAt || ''}</span><span>{s.status}</span></div>
            </div>
            {(s.status === 'ended' || s.status === 'idle') && (
              <button className="session-resume-btn" onClick={() => (window as any).resumeSession(proj.id, s.id)}>Resume</button>
            )}
          </div>
        );
      })}
      {historicalNodes.length > 0 && (
        <>
          <div className="session-history-divider">History</div>
          {historicalNodes.map(n => {
            const h = n.data;
            const d = new Date(h.lastModified);
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            return (
              <div key={h.id} className="session-item session-historical" onClick={() => (window as any).resumeHistoricalSession(proj.id, h.id)}
                   style={{ paddingLeft: `${10 + n.depth * 16}px` }}>
                {n.depth > 0 && <span className="session-tree-line" />}
                <div className="session-status-dot ended"></div>
                <div className="session-info">
                  <div className="session-title">{escapeHtml(h.title)}</div>
                  <div className="session-meta"><span>{dateStr} {timeStr}</span><span>{h.eventCount} events</span></div>
                </div>
                <button className="session-resume-btn" onClick={(e) => { e.stopPropagation(); (window as any).resumeHistoricalSession(proj.id, h.id); }}>Resume</button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
