import React, { useCallback } from 'react';
import { useStore } from '../../state/store';
import { AskUserWizard } from './AskUserWizard';
import type { AskUserAnswers } from './types';
import type { Session } from '../../types';

interface Props {
  session: Session;
}

export function AskUserOverlay({ session }: Props) {
  const pending = session.pendingAskUser;
  if (!pending) return null;

  const clearPending = useCallback(() => {
    const projects = useStore.getState().projects.map((proj) => ({
      ...proj,
      sessions: proj.sessions.map((s) =>
        s.id === session.id ? { ...s, pendingAskUser: null } : s,
      ),
    }));
    useStore.setState({ projects });
  }, [session.id]);

  const handleSubmit = useCallback(
    async (answers: AskUserAnswers) => {
      try {
        await fetch('/api/respond-ask-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: pending.requestId, answers, cancelled: false }),
        });
      } catch (err) {
        console.error('[ask-user] Failed to submit answers:', err);
      }
      clearPending();
    },
    [pending.requestId, clearPending],
  );

  const handleCancel = useCallback(async () => {
    try {
      await fetch('/api/respond-ask-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: pending.requestId, cancelled: true }),
      });
    } catch (err) {
      console.error('[ask-user] Failed to cancel:', err);
    }
    clearPending();
  }, [pending.requestId, clearPending]);

  return (
    <AskUserWizard
      sessionId={session.id}
      requestId={pending.requestId}
      questions={pending.questions}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
}
