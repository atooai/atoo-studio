const BASE = '';

export async function fetchStatus() {
  const res = await fetch(`${BASE}/api/status`);
  return res.json();
}

export async function fetchEnvironments() {
  const res = await fetch(`${BASE}/api/environments`);
  return res.json();
}

export async function fetchSessions() {
  const res = await fetch(`${BASE}/api/sessions`);
  return res.json();
}

export async function fetchSession(id: string) {
  const res = await fetch(`${BASE}/api/sessions/${id}`);
  return res.json();
}

export async function browseDirs(dirPath?: string): Promise<{ current: string; parent: string; dirs: { name: string; path: string }[] }> {
  const url = dirPath ? `${BASE}/api/browse?path=${encodeURIComponent(dirPath)}` : `${BASE}/api/browse`;
  const res = await fetch(url);
  return res.json();
}

export async function createSession(message: string, options?: { skipPermissions?: boolean; environmentId?: string; cwd?: string }) {
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      skip_permissions: options?.skipPermissions,
      environment_id: options?.environmentId,
      cwd: options?.cwd,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create session');
  }
  return res.json();
}

export async function sendMessage(sessionId: string, message: string) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return res.json();
}

export async function forkSession(sessionId: string, afterEventUuid: string, message?: string) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ afterEventUuid, message: message || undefined }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to fork session');
  }
  return res.json();
}

export async function fetchChanges(sessionId: string, from?: number, to?: number) {
  let url = `${BASE}/api/sessions/${sessionId}/changes`;
  const params = new URLSearchParams();
  if (from !== undefined) params.set('from', String(from));
  if (to !== undefined) params.set('to', String(to));
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchDiff(sessionId: string, changeId: string) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/changes/${changeId}/diff`);
  return res.json();
}

export async function revertChange(sessionId: string, changeId: string) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/changes/${changeId}/revert`, {
    method: 'POST',
  });
  return res.json();
}

export async function revertAllChanges(sessionId: string) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/changes/revert-all`, {
    method: 'POST',
  });
  return res.json();
}

export function objectUrl(hash: string): string {
  return `${BASE}/api/objects/${encodeURIComponent(hash)}`;
}

export async function fetchFsSessions() {
  const res = await fetch(`${BASE}/api/fs-sessions`);
  return res.json();
}

export async function resumeFsSession(uuid: string, options?: { skipPermissions?: boolean }) {
  const res = await fetch(`${BASE}/api/fs-sessions/${uuid}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skip_permissions: options?.skipPermissions }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to resume session');
  }
  return res.json();
}

export async function sendControlResponse(
  sessionId: string,
  requestId: string,
  approved: boolean,
  updatedInput?: string
) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/control-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subtype: 'success',
      request_id: requestId,
      response: approved
        ? { behavior: 'allow', updatedInput: updatedInput ?? {} }
        : { behavior: 'deny', message: 'User denied' },
    }),
  });
  return res.json();
}
