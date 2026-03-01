import { useEffect, useRef, useState, useCallback } from 'react';
import type { SessionEvent } from '../types/index.js';

export type AgentStatus = 'idle' | 'active' | 'waiting';

export function useSessionWebSocket(sessionId: string | null) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const lastStatusRef = useRef<AgentStatus>('idle');

  useEffect(() => {
    if (!sessionId) return;

    setEvents([]);
    setAgentStatus('idle');
    lastStatusRef.current = 'idle';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sessions/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        // Handle agent status updates (not stored as events)
        if (msg.type === 'agent_status') {
          lastStatusRef.current = msg.status;
          setAgentStatus(msg.status);
          return;
        }

        // Derive status from replayed/live events
        if (msg.type === 'assistant') {
          const stopReason = msg.message?.stop_reason;
          if (stopReason === 'end_turn') {
            lastStatusRef.current = 'idle';
            setAgentStatus('idle');
          } else {
            lastStatusRef.current = 'active';
            setAgentStatus('active');
          }
        } else if (msg.type === 'user' && !msg.parent_tool_use_id) {
          lastStatusRef.current = 'active';
          setAgentStatus('active');
        } else if (msg.type === 'result') {
          lastStatusRef.current = 'idle';
          setAgentStatus('idle');
        } else if (msg.type === 'control_request') {
          lastStatusRef.current = 'waiting';
          setAgentStatus('waiting');
        }

        setEvents((prev) => {
          if (msg.uuid && prev.some((ev) => ev.uuid === msg.uuid)) return prev;
          return [...prev, msg];
        });
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
      setConnected(false);
    };
  }, [sessionId]);

  const sendControlResponse = useCallback(
    (requestId: string, approved: boolean, updatedInput?: any) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: approved
              ? { behavior: 'allow', ...(updatedInput ? { updatedInput } : {}) }
              : { behavior: 'deny', message: 'User denied' },
          },
        })
      );
    },
    []
  );

  return { events, connected, agentStatus, sendControlResponse };
}
