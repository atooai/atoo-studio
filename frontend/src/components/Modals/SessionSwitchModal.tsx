import React, { useEffect } from 'react';
import { api } from '../../api';
import { useStore } from '../../state/store';
import { toRawHex } from '../../utils/session-id-utils';

interface SessionSwitchModalProps {
  requestId: string;
  targetSessionUuid: string;
  refinedPrompt: string;
  sourceSessionId: string | null;
  onClose: () => void;
}

/**
 * Wait for a session's TUI terminal to be connected, then inject text.
 * Polls every 500ms for up to 30s.
 */
function waitAndInjectPrompt(refinedPrompt: string) {
  const win = window as any;
  let attempts = 0;
  const maxAttempts = 60;

  const tryInject = () => {
    attempts++;
    const store = useStore.getState();
    const pending = store.pendingSessionSwitch;
    if (!pending) return; // cleared externally

    // Find the active session with matching cliSessionId
    const targetHex = toRawHex(pending.targetSessionUuid);
    for (const proj of store.projects) {
      for (const s of proj.sessions || []) {
        const sid = s.cliSessionId || s.id;
        if (toRawHex(sid) === targetHex && s.status !== 'ended') {
          // Try to inject into TUI
          if (win.injectTuiInput?.(s.id, pending.refinedPrompt) !== undefined) {
            // injectTuiInput is void — just call it and check if terminal exists
            const tuiTermId = `tui-${s.id}`;
            // Access terminalInstances indirectly via the inject function success
            win.injectTuiInput(s.id, pending.refinedPrompt);
            store.setPendingSessionSwitch(null);
            return;
          }
        }
      }
    }

    if (attempts < maxAttempts) {
      setTimeout(tryInject, 500);
    } else {
      // Timed out — clear pending state
      store.setPendingSessionSwitch(null);
    }
  };

  setTimeout(tryInject, 500);
}

export function SessionSwitchModal({ requestId, targetSessionUuid, refinedPrompt, sourceSessionId, onClose }: SessionSwitchModalProps) {
  const respond = async (action: 'rejected' | 'open' | 'open_and_close') => {
    // Respond to backend first (unblocks MCP tool)
    try {
      await api('POST', '/api/respond-session-switch', { requestId, action });
    } catch (err) {
      console.warn('[SessionSwitchModal] Failed to respond:', err);
    }

    // Close this modal BEFORE opening target session, because
    // resumeHistoricalSession may set its own modal (agent-picker)
    // and onClose() would clear it.
    onClose();

    if (action !== 'rejected') {
      openTargetSession(action === 'open_and_close');
    }
  };

  const openTargetSession = (closeSource: boolean) => {
    const store = useStore.getState();
    const win = window as any;
    const targetHex = toRawHex(targetSessionUuid);

    // Find the project containing the target session
    let targetProject: any = null;
    let activeSession: any = null;
    let activeSessionIdx = -1;

    for (const proj of store.projects) {
      // Check active sessions by cliSessionId
      const activeSessions = (proj.sessions || []).filter((s: any) => s.status !== 'ended');
      for (let i = 0; i < activeSessions.length; i++) {
        const s = activeSessions[i];
        const sid = s.cliSessionId || s.id;
        if (toRawHex(sid) === targetHex) {
          targetProject = proj;
          activeSession = s;
          activeSessionIdx = i;
          break;
        }
      }
      if (activeSession) break;

      // Check historical sessions
      const hist = (proj.historicalSessions || []).find((h: any) => toRawHex(h.id) === targetHex);
      if (hist) {
        targetProject = proj;
        break;
      }
    }

    if (!targetProject) {
      store.addToast('Session Switch', `Could not find session ${targetSessionUuid}`, 'attention');
      return;
    }

    // Store the pending switch so prompt gets injected after session connects
    store.setPendingSessionSwitch({ targetSessionUuid, refinedPrompt, sourceSessionId });

    if (activeSession) {
      // Session is already open — switch to its tab and inject prompt
      win.switchToSession(targetProject.id, activeSessionIdx);
      setTimeout(() => {
        win.injectTuiInput?.(activeSession.id, refinedPrompt);
        store.setPendingSessionSwitch(null);
      }, 200);
    } else {
      // Session needs to be resumed — use the standard resume flow
      // The prompt will be injected by waitAndInjectPrompt polling
      win.resumeHistoricalSession(targetProject.id, targetSessionUuid);
      waitAndInjectPrompt(refinedPrompt);
    }

    // Close the source session if requested
    if (closeSource && sourceSessionId) {
      for (const proj of store.projects) {
        const session = (proj.sessions || []).find((s: any) => {
          const sid = s.cliSessionId || s.id;
          return toRawHex(sid) === toRawHex(sourceSessionId);
        });
        if (session) {
          api('DELETE', `/api/agent-sessions/${session.id}`).catch((err: any) => {
            console.warn('[SessionSwitchModal] Failed to close source session:', err);
          });
          break;
        }
      }
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); respond('rejected'); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="confirm-dialog session-switch-modal">
      <div className="confirm-dialog-title">Continue in another session?</div>
      <div className="confirm-dialog-message">
        An AI agent suggests continuing this task in an existing session that already has relevant context.
        <div className="session-switch-details">
          <div className="session-switch-uuid">
            Target: <code title={targetSessionUuid}>{targetSessionUuid}</code>
          </div>
          <div className="session-switch-prompt">
            <strong>Prompt:</strong>
            <pre>{refinedPrompt}</pre>
          </div>
        </div>
      </div>
      <div className="confirm-dialog-actions session-switch-actions">
        <button className="confirm-dialog-btn cancel" onClick={() => respond('rejected')}>
          Reject
        </button>
        <button className="confirm-dialog-btn primary" onClick={() => respond('open')}>
          Open
        </button>
        <button className="confirm-dialog-btn danger" onClick={() => respond('open_and_close')}>
          Open &amp; Close Current
        </button>
      </div>
    </div>
  );
}
