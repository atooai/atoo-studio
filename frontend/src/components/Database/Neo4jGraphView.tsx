import React from 'react';
import { api } from '../../api';

interface Props {
  connectionId: string;
}

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, any>;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  dragging?: boolean;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  properties: Record<string, any>;
}

function hashToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = ((hash % 360) + 360) % 360;
  return `hsl(${h}, 65%, 55%)`;
}

function isNode(val: any): boolean {
  return val && typeof val === 'object' && Array.isArray(val.labels);
}

function isRelationship(val: any): boolean {
  return val && typeof val === 'object' && typeof val.type === 'string' && ('start' in val || 'end' in val);
}

function getNodeId(val: any): string {
  if (val._id !== undefined) return String(val._id);
  if (val.identity !== undefined) return String(val.identity);
  if (val.elementId !== undefined) return String(val.elementId);
  return JSON.stringify(val.properties || {});
}

function getEdgeId(val: any): string {
  if (val._id !== undefined) return `e_${val._id}`;
  if (val.identity !== undefined) return `e_${val.identity}`;
  if (val.elementId !== undefined) return `e_${val.elementId}`;
  return `e_${val.start}_${val.type}_${val.end}`;
}

function getEdgeEndpoints(val: any): { source: string; target: string } {
  const source = String(val.start ?? val.startNodeElementId ?? '');
  const target = String(val.end ?? val.endNodeElementId ?? '');
  return { source, target };
}

function extractGraph(rows: Record<string, any>[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  for (const row of rows) {
    for (const val of Object.values(row)) {
      if (isNode(val)) {
        const id = getNodeId(val);
        if (!nodeMap.has(id)) {
          const label = val.labels[0] || 'Node';
          nodeMap.set(id, {
            id,
            labels: val.labels,
            properties: val.properties || {},
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            color: hashToColor(label),
          });
        }
      } else if (isRelationship(val)) {
        const eid = getEdgeId(val);
        if (!edgeMap.has(eid)) {
          const { source, target } = getEdgeEndpoints(val);
          edgeMap.set(eid, {
            id: eid,
            source,
            target,
            type: val.type,
            properties: val.properties || {},
          });
        }
      }
    }
  }

  return { nodes: Array.from(nodeMap.values()), edges: Array.from(edgeMap.values()) };
}

function runForceLayout(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): void {
  const NODE_RADIUS = 20;
  const REPULSION = 5000;
  const ATTRACTION = 0.005;
  const CENTER_FORCE = 0.01;
  const DAMPING = 0.9;
  const ITERATIONS = 150;

  // Initialize random positions
  for (const n of nodes) {
    n.x = width * 0.2 + Math.random() * width * 0.6;
    n.y = height * 0.2 + Math.random() * height * 0.6;
    n.vx = 0;
    n.vy = 0;
  }

  const nodeIndex = new Map<string, GraphNode>();
  for (const n of nodes) nodeIndex.set(n.id, n);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion between all node pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) dist = 1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Attraction along edges
    for (const e of edges) {
      const a = nodeIndex.get(e.source);
      const b = nodeIndex.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const force = dist * ATTRACTION;
      const fx = dx * force;
      const fy = dy * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Centering force + velocity update
    const cx = width / 2;
    const cy = height / 2;
    for (const n of nodes) {
      if (n.dragging) continue;
      n.vx += (cx - n.x) * CENTER_FORCE;
      n.vy += (cy - n.y) * CENTER_FORCE;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      // Keep within bounds
      n.x = Math.max(NODE_RADIUS, Math.min(width - NODE_RADIUS, n.x));
      n.y = Math.max(NODE_RADIUS, Math.min(height - NODE_RADIUS, n.y));
    }
  }
}

function drawGraph(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  selectedNodeId: string | null,
): void {
  const NODE_RADIUS = 20;
  const nodeIndex = new Map<string, GraphNode>();
  for (const n of nodes) nodeIndex.set(n.id, n);

  ctx.clearRect(0, 0, width, height);

  // Draw edges
  for (const e of edges) {
    const a = nodeIndex.get(e.source);
    const b = nodeIndex.get(e.target);
    if (!a || !b) continue;

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Arrow
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const arrowX = b.x - Math.cos(angle) * NODE_RADIUS;
    const arrowY = b.y - Math.sin(angle) * NODE_RADIUS;
    const arrowSize = 8;
    ctx.beginPath();
    ctx.moveTo(arrowX, arrowY);
    ctx.lineTo(
      arrowX - arrowSize * Math.cos(angle - Math.PI / 6),
      arrowY - arrowSize * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      arrowX - arrowSize * Math.cos(angle + Math.PI / 6),
      arrowY - arrowSize * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fillStyle = '#666';
    ctx.fill();

    // Edge label
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(e.type, mx, my - 4);
  }

  // Draw nodes
  for (const n of nodes) {
    const isSelected = n.id === selectedNodeId;

    ctx.beginPath();
    ctx.arc(n.x, n.y, NODE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();

    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Node label
    const label = n.labels[0] || n.id;
    const displayLabel = label.length > 10 ? label.substring(0, 9) + '\u2026' : label;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayLabel, n.x, n.y);
  }
}

export function Neo4jGraphView({ connectionId }: Props) {
  const [query, setQuery] = React.useState('MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 50');
  const [error, setError] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [nodes, setNodes] = React.useState<GraphNode[]>([]);
  const [edges, setEdges] = React.useState<GraphEdge[]>([]);
  const [selectedNode, setSelectedNode] = React.useState<GraphNode | null>(null);

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const nodesRef = React.useRef<GraphNode[]>([]);
  const edgesRef = React.useRef<GraphEdge[]>([]);
  const selectedIdRef = React.useRef<string | null>(null);
  const dragRef = React.useRef<{ node: GraphNode; offsetX: number; offsetY: number } | null>(null);

  const redraw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawGraph(ctx, nodesRef.current, edgesRef.current, canvas.width, canvas.height, selectedIdRef.current);
  }, []);

  // Sync state to refs and redraw
  React.useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    redraw();
  }, [nodes, edges, redraw]);

  React.useEffect(() => {
    selectedIdRef.current = selectedNode?.id ?? null;
    redraw();
  }, [selectedNode, redraw]);

  const executeQuery = React.useCallback(async () => {
    const q = query.trim();
    if (!q || running) return;
    setRunning(true);
    setError('');
    setSelectedNode(null);

    try {
      const data = await api('POST', '/api/databases/query', {
        connection_id: connectionId,
        query: q,
      });

      const { nodes: graphNodes, edges: graphEdges } = extractGraph(data.rows || []);

      if (graphNodes.length === 0) {
        setError('No graph data found in query results. Make sure your query returns nodes and relationships.');
        setNodes([]);
        setEdges([]);
        return;
      }

      const canvas = canvasRef.current;
      const w = canvas?.width || 800;
      const h = canvas?.height || 500;

      runForceLayout(graphNodes, graphEdges, w, h);
      setNodes(graphNodes);
      setEdges(graphEdges);
    } catch (e: any) {
      setError(e.message || 'Query failed');
      setNodes([]);
      setEdges([]);
    } finally {
      setRunning(false);
    }
  }, [query, running, connectionId]);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      executeQuery();
    }
  }, [executeQuery]);

  // Canvas resize
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const observer = new ResizeObserver(() => {
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width;
      canvas.height = rect.height;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      // For simplicity, keep canvas coords 1:1 with CSS pixels (no DPR scaling)
      redraw();
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [redraw]);

  // Mouse interactions
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const NODE_RADIUS = 20;

    function findNodeAt(x: number, y: number): GraphNode | null {
      // Reverse order so top-drawn nodes are picked first
      for (let i = nodesRef.current.length - 1; i >= 0; i--) {
        const n = nodesRef.current[i];
        const dx = n.x - x;
        const dy = n.y - y;
        if (dx * dx + dy * dy <= NODE_RADIUS * NODE_RADIUS) return n;
      }
      return null;
    }

    function getCanvasPos(e: MouseEvent): { x: number; y: number } {
      const rect = canvas!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onMouseDown(e: MouseEvent) {
      const pos = getCanvasPos(e);
      const node = findNodeAt(pos.x, pos.y);
      if (node) {
        dragRef.current = { node, offsetX: pos.x - node.x, offsetY: pos.y - node.y };
        node.dragging = true;
      }
    }

    function onMouseMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) {
        // Update cursor
        const pos = getCanvasPos(e);
        const node = findNodeAt(pos.x, pos.y);
        canvas!.style.cursor = node ? 'grab' : 'default';
        return;
      }
      canvas!.style.cursor = 'grabbing';
      const pos = getCanvasPos(e);
      drag.node.x = pos.x - drag.offsetX;
      drag.node.y = pos.y - drag.offsetY;
      redraw();
    }

    function onMouseUp(e: MouseEvent) {
      const drag = dragRef.current;
      if (drag) {
        drag.node.dragging = false;
        // Check if it was a click (small movement)
        const pos = getCanvasPos(e);
        const dx = pos.x - (drag.node.x + drag.offsetX);
        const dy = pos.y - (drag.node.y + drag.offsetY);
        // Always treat mouseup on a node as potential selection
        const node = findNodeAt(pos.x - drag.offsetX + drag.node.x - pos.x + drag.offsetX, pos.y);
        dragRef.current = null;
        redraw();
        return;
      }
    }

    function onClick(e: MouseEvent) {
      const pos = getCanvasPos(e);
      const node = findNodeAt(pos.x, pos.y);
      if (node) {
        setSelectedNode(prev => prev?.id === node.id ? null : node);
      } else {
        setSelectedNode(null);
      }
    }

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('click', onClick);
    };
  }, [redraw]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Query input bar */}
      <div style={{
        display: 'flex',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-color, #333)',
        background: 'var(--bg-secondary, #1e1e1e)',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Cypher query..."
          style={{
            flex: 1,
            padding: '6px 10px',
            background: 'var(--bg-primary, #111)',
            color: 'var(--text-primary, #eee)',
            border: '1px solid var(--border-color, #444)',
            borderRadius: 4,
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          onClick={executeQuery}
          disabled={running}
          className="database-query-run-btn"
          style={{
            padding: '6px 16px',
            background: running ? '#555' : 'var(--accent-color, #0078d4)',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: running ? 'not-allowed' : 'pointer',
            fontSize: 13,
            whiteSpace: 'nowrap',
          }}
        >
          {running ? '... Running' : '\u25b6 Execute'}
        </button>
        {nodes.length > 0 && (
          <span style={{ color: 'var(--text-secondary, #999)', fontSize: 12, whiteSpace: 'nowrap' }}>
            {nodes.length} node{nodes.length !== 1 ? 's' : ''}, {edges.length} edge{edges.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="database-query-error" style={{
          padding: '8px 12px',
          color: '#f44',
          fontSize: 13,
          background: 'rgba(255,60,60,0.08)',
          borderBottom: '1px solid var(--border-color, #333)',
        }}>
          {error}
        </div>
      )}

      {/* Main area: canvas + optional sidebar */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {/* Canvas container */}
        <div style={{
          flex: 1,
          position: 'relative',
          background: 'var(--bg-primary, #111)',
          minWidth: 0,
        }}>
          <canvas
            ref={canvasRef}
            style={{ display: 'block', width: '100%', height: '100%' }}
          />
          {nodes.length === 0 && !running && !error && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'var(--text-secondary, #777)',
              fontSize: 14,
              textAlign: 'center',
              pointerEvents: 'none',
            }}>
              Run a Cypher query to visualize the graph.<br />
              <span style={{ fontSize: 12, opacity: 0.7 }}>Press Ctrl+Enter to execute</span>
            </div>
          )}
        </div>

        {/* Properties sidebar */}
        {selectedNode && (
          <div style={{
            width: 260,
            borderLeft: '1px solid var(--border-color, #333)',
            background: 'var(--bg-secondary, #1e1e1e)',
            overflow: 'auto',
            flexShrink: 0,
            padding: 12,
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}>
              <strong style={{ color: 'var(--text-primary, #eee)', fontSize: 13 }}>Node Properties</strong>
              <button
                onClick={() => setSelectedNode(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary, #999)',
                  cursor: 'pointer',
                  fontSize: 16,
                  padding: '0 4px',
                }}
              >
                \u00d7
              </button>
            </div>

            {/* Labels */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: 'var(--text-secondary, #999)', fontSize: 11, marginBottom: 4 }}>Labels</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {selectedNode.labels.map((label, i) => (
                  <span key={i} style={{
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: hashToColor(label),
                    color: '#fff',
                    fontSize: 11,
                  }}>
                    {label}
                  </span>
                ))}
              </div>
            </div>

            {/* ID */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: 'var(--text-secondary, #999)', fontSize: 11, marginBottom: 2 }}>ID</div>
              <div style={{ color: 'var(--text-primary, #eee)', fontSize: 12, fontFamily: 'var(--font-mono, monospace)' }}>
                {selectedNode.id}
              </div>
            </div>

            {/* Properties */}
            <div>
              <div style={{ color: 'var(--text-secondary, #999)', fontSize: 11, marginBottom: 6 }}>Properties</div>
              {Object.keys(selectedNode.properties).length === 0 ? (
                <div style={{ color: 'var(--text-secondary, #777)', fontSize: 12, fontStyle: 'italic' }}>
                  No properties
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {Object.entries(selectedNode.properties).map(([key, value]) => (
                      <tr key={key}>
                        <td style={{
                          color: 'var(--text-secondary, #aaa)',
                          fontSize: 11,
                          padding: '3px 6px 3px 0',
                          verticalAlign: 'top',
                          whiteSpace: 'nowrap',
                        }}>
                          {key}
                        </td>
                        <td style={{
                          color: 'var(--text-primary, #eee)',
                          fontSize: 11,
                          padding: '3px 0',
                          fontFamily: 'var(--font-mono, monospace)',
                          wordBreak: 'break-all',
                        }}>
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
