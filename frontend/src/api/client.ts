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
