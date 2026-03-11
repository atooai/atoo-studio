export async function api(method: string, url: string, body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/api/auth/')) {
      // Session expired — trigger re-auth
      const { useAuthStore } = await import('../state/auth-store');
      useAuthStore.getState().setUser(null);
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
