import { useEffect, useRef, useState, useCallback } from 'react';
import type { SessionEvent } from '../types/index.js';

export type AgentStatus = 'idle' | 'active' | 'waiting';

export interface SessionMeta {
  permissionMode: string | null;
  model: string | null;
  models: Array<{ value: string; displayName: string; description: string }>;
}

export function useSessionWebSocket(sessionId: string | null) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [meta, setMeta] = useState<SessionMeta>({ permissionMode: null, model: null, models: [] });
  const wsRef = useRef<WebSocket | null>(null);
  const lastStatusRef = useRef<AgentStatus>('idle');

  useEffect(() => {
    if (!sessionId) return;

    setEvents([]);
    setAgentStatus('idle');
    setMeta({ permissionMode: null, model: null, models: [] });
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

        // Extract mode/model from system init event
        if (msg.type === 'system' && msg.subtype === 'init') {
          setMeta((prev) => ({
            ...prev,
            permissionMode: msg.permissionMode ?? prev.permissionMode,
            model: msg.model ?? prev.model,
          }));
        }

        // Extract models list + mode from initialize control_response
        if (msg.type === 'control_response' && msg.response?.subtype === 'success') {
          const resp = msg.response.response;
          if (resp?.models && Array.isArray(resp.models)) {
            setMeta((prev) => ({ ...prev, models: resp.models }));
          }
          // set_permission_mode success → update mode
          if (resp?.mode && typeof resp.mode === 'string') {
            setMeta((prev) => ({ ...prev, permissionMode: resp.mode }));
          }
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

        // Stamp event with receive time (epoch seconds) for turn boundary tracking
        msg._receivedAt = Date.now() / 1000;

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
              ? { behavior: 'allow', updatedInput: updatedInput ?? {} }
              : { behavior: 'deny', message: 'User denied' },
          },
        })
      );
    },
    []
  );

  const sendControlRequest = useCallback(
    (subtype: string, params: Record<string, any>) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const requestId = crypto.randomUUID();
      wsRef.current.send(
        JSON.stringify({
          type: 'control_request',
          request: {
            subtype,
            request_id: requestId,
            ...params,
          },
        })
      );
      // Optimistically update local state
      if (subtype === 'set_permission_mode' && params.mode) {
        setMeta((prev) => ({ ...prev, permissionMode: params.mode }));
      }
      if (subtype === 'set_model' && params.model) {
        setMeta((prev) => ({ ...prev, model: params.model }));
      }
    },
    []
  );

  return { events, connected, agentStatus, meta, sendControlResponse, sendControlRequest };
}
