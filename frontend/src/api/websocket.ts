import { useStore } from '../state/store';
import { api } from './index';
import type { Project, EditorFile } from '../types';

// WebSocket instances
let statusWs: WebSocket | null = null;
let settingsWs: WebSocket | null = null;
const sessionWsMap: Record<string, WebSocket> = {};
const agentWsMap: Record<string, WebSocket> = {};
let pendingAgentCreation = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function refreshOpenFiles(projectPath: string, openFiles: EditorFile[]) {
  // Debounce to avoid rapid re-fetches
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const s = useStore.getState();
    const currentFiles = s.openFiles;
    if (!currentFiles.length) return;

    const updates = await Promise.all(
      currentFiles.map(async (f) => {
        if (!f.fullPath.startsWith(projectPath)) return f;
        try {
          const data = await api('GET', `/api/files?path=${encodeURIComponent(f.fullPath)}`);
          if (data.content !== f.content) {
            return { ...f, content: data.content, originalContent: data.content, isModified: false };
          }
        } catch {}
        return f;
      })
    );

    // Only update if something actually changed
    if (updates.some((f, i) => f !== currentFiles[i])) {
      useStore.getState().setOpenFiles(updates);
    }
  }, 600);
}

export function setPendingAgentCreation(v: boolean) {
  pendingAgentCreation = v;
}

function getWsProto() {
  return location.protocol === 'https:' ? 'wss:' : 'ws:';
}

// --- Status WebSocket ---
export function connectStatusWs() {
  const proto = getWsProto();
  statusWs = new WebSocket(`${proto}//${location.host}/ws/status`);
  statusWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleStatusMessage(msg);
    } catch (err) {
      console.error('[ws:status] handler error:', err);
    }
  };
  statusWs.onclose = () => {
    setTimeout(connectStatusWs, 3000);
  };
}

function handleStatusMessage(msg: any) {
  const store = useStore.getState();

  if (msg.type === 'agent_status') {
    const projects = store.projects.map((proj) => {
      const sess = proj.sessions.find((s) => s.id === msg.session_id);
      if (!sess) return proj;
      const newStatus = msg.status === 'active' ? 'running' as const : msg.status === 'waiting' ? 'waiting' as const : 'idle' as const;
      return {
        ...proj,
        sessions: proj.sessions.map((s) =>
          s.id === msg.session_id ? { ...s, status: newStatus } : s
        ),
      };
    });
    useStore.setState({ projects });
  } else if (msg.type === 'session_created' && msg.session) {
    if (pendingAgentCreation) return;
    const s = msg.session;
    const projects = store.projects.map((proj) => {
      if (proj.path === s.directory && !proj.sessions.find((x) => x.id === s.id)) {
        connectSessionWs(s.id);
        return {
          ...proj,
          sessions: [
            ...proj.sessions,
            {
              id: s.id,
              title: s.title || 'New session',
              status: (s.status === 'active' ? 'running' : 'idle') as any,
              startedAt: new Date(s.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              messages: [],
              lastMessage: '',
              viewMode: 'chat' as const,
              permissionMode: s.permission_mode || null,
              model: s.model || null,
            },
          ],
        };
      }
      return proj;
    });
    useStore.setState({ projects });

    // Fallback: if no project path matched, try API
    if (store.activeProjectId) {
      const activeProj = projects.find((p) => p.id === store.activeProjectId);
      if (activeProj && !activeProj.sessions.find((x) => x.id === s.id)) {
        api('GET', `/api/projects/${activeProj.id}/sessions`).then((sessions) => {
          const newSess = sessions.find((x: any) => x.id === s.id);
          if (newSess) {
            const current = useStore.getState();
            const updated = current.projects.map((proj) => {
              if (proj.id === activeProj.id && !proj.sessions.find((x) => x.id === s.id)) {
                connectSessionWs(newSess.id);
                return {
                  ...proj,
                  sessions: [
                    ...proj.sessions,
                    {
                      id: newSess.id,
                      title: newSess.title || 'New session',
                      status: (newSess.agent_status === 'active' ? 'running' : newSess.agent_status === 'waiting' ? 'waiting' : 'idle') as any,
                      startedAt: new Date(newSess.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                      messages: [],
                      lastMessage: '',
                      viewMode: 'chat' as const,
                      permissionMode: newSess.permission_mode || null,
                      model: newSess.model || null,
                    },
                  ],
                };
              }
              return proj;
            });
            useStore.setState({ projects: updated });
          }
        }).catch(() => {});
      }
    }
  } else if (msg.type === 'terminal_created' && msg.terminal) {
    const t = msg.terminal;
    const projects = store.projects.map((proj) => {
      if (proj.path === t.projectPath && !proj.terminals?.find((x) => x.shellId === t.id)) {
        return {
          ...proj,
          terminals: [...(proj.terminals || []), { id: `shell-${t.id}`, name: `bash-${(proj.terminals || []).length}`, shellId: t.id }],
        };
      }
      return proj;
    });
    useStore.setState({ projects });
  } else if (msg.type === 'terminal_exited' && msg.terminal) {
    const projects = store.projects.map((proj) => {
      const idx = proj.terminals?.findIndex((x) => x.shellId === msg.terminal.id);
      if (idx !== undefined && idx >= 0) {
        return { ...proj, terminals: proj.terminals.filter((_, i) => i !== idx) };
      }
      return proj;
    });
    useStore.setState({ projects });
  } else if (msg.type === 'context_usage' && msg.session_id) {
    const projects = store.projects.map((proj) => {
      const sess = proj.sessions.find((s) => s.id === msg.session_id);
      if (!sess) return proj;
      return {
        ...proj,
        sessions: proj.sessions.map((s) =>
          s.id === msg.session_id
            ? { ...s, contextUsage: { model: msg.model, usedTokens: msg.usedTokens, totalTokens: msg.totalTokens, percent: msg.percent, freePercent: msg.freePercent } }
            : s
        ),
      };
    });
    useStore.setState({ projects });
  } else if (msg.type === 'context_in_progress' && msg.session_id) {
    const projects = store.projects.map((proj) => ({
      ...proj,
      sessions: proj.sessions.map((s) =>
        s.id === msg.session_id ? { ...s, contextInProgress: !!msg.inProgress } : s
      ),
    }));
    useStore.setState({ projects });
  } else if (msg.type === 'project_files_changed' && msg.projectId) {
    const s = useStore.getState();
    s.updateProject(msg.projectId, (p) => ({
      ...p,
      files: msg.files,
    }));
    // Refresh any open files that belong to this project
    const proj = s.projects.find((p) => p.id === msg.projectId);
    if (proj && s.openFiles.length > 0) {
      refreshOpenFiles(proj.path, s.openFiles);
    }
  } else if (msg.type === 'project_git_changed' && msg.projectId) {
    useStore.getState().updateProject(msg.projectId, (p) => ({
      ...p,
      gitChanges: msg.gitChanges,
      gitLog: msg.gitLog,
      stashes: msg.stashes,
    }));
  } else if (msg.type === 'service_started' && msg.services) {
    const proj = store.projects.find((p) => msg.cwd && msg.cwd.startsWith(p.path));
    const projName = proj?.name || msg.cwd || 'Unknown';
    for (const s of msg.services) {
      store.addToast(projName, `Started ${s.protocol} service "${s.name}" on port ${s.port}`, 'info');
    }
    // Auto-manage preview tabs for http/https/ws/wss services
    if (store.previewVisible) {
      const httpServices = msg.services.filter((s: any) =>
        ['http', 'https', 'ws', 'wss'].includes(s.protocol)
      );
      const getTabPort = (url: string): string | null => {
        try {
          const u = new URL(url);
          // Reverse proxy format: {port}.port.on.{host}.nip.io
          const portMatch = u.hostname.match(/^(\d+)\.port\.on\./);
          if (portMatch) return portMatch[1];
          return u.port || null;
        } catch { return null; }
      };
      for (const s of httpServices) {
        const port = String(s.port);
        const existingIdx = store.previewTabs.findIndex((t) => getTabPort(t.url) === port);
        if (existingIdx >= 0) {
          // Refresh existing tab by appending cache-buster
          const tabs = store.previewTabs.map((t, i) => {
            if (i !== existingIdx) return t;
            const base = t.url.replace(/#.*$/, '');
            return { ...t, url: `${base}#_r=${Date.now()}` };
          });
          useStore.setState({ previewTabs: tabs, previewActiveIdx: existingIdx });
        } else {
          // Add new tab using reverse proxy URL
          const host = location.hostname;
          const url = `${location.protocol}//${s.port}.port.on.${host}.nip.io:${location.port}/`;
          const id = 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
          const label = `${s.name} :${s.port}`;
          const newTabs = [...store.previewTabs, { id, url, label }];
          useStore.setState({ previewTabs: newTabs, previewActiveIdx: newTabs.length - 1 });
        }
      }
    }
  }
}

// --- Session WebSocket ---
export function connectSessionWs(sessionId: string) {
  if (sessionWsMap[sessionId]) return;
  const proto = getWsProto();
  const ws = new WebSocket(`${proto}//${location.host}/ws/sessions/${sessionId}`);
  sessionWsMap[sessionId] = ws;

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleSessionEvent(sessionId, event);
    } catch {}
  };
  ws.onclose = () => {
    delete sessionWsMap[sessionId];
  };
}

function getEventText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => b.text || b.content || '').join('');
  return '';
}

function hasAnsi(text: string): boolean {
  return /\x1b\[/.test(text);
}

function handleSessionEvent(sessionId: string, event: any) {
  const store = useStore.getState();
  const projects = store.projects.map((proj) => {
    const sessIdx = proj.sessions.findIndex((s) => s.id === sessionId);
    if (sessIdx === -1) return proj;
    const sess = { ...proj.sessions[sessIdx], messages: [...proj.sessions[sessIdx].messages] };

    console.log('[event]', event.type, JSON.stringify(event).substring(0, 300));

    if (event.type === 'user' && event.message) {
      if (event.isSynthetic) return proj;
      const text = getEventText(event.message.content);
      if (text.startsWith('/') || hasAnsi(text)) return proj;
      if (/<command-name>|<local-command-caveat>|<command-message>/.test(text)) return proj;
      if (Array.isArray(event.message.content) && event.message.content.every((b: any) => b.type === 'tool_result')) return proj;
      if (sess.messages.some((m) => m._eventUuid === event.uuid)) return proj;
      const displayContent = typeof event.message.content === 'string' ? event.message.content : text;
      let attachments;
      if (Array.isArray(event.message.content)) {
        attachments = event.message.content
          .filter((b: any) => (b.type === 'image' && b.source) || (b.type === 'document' && b.source))
          .map((b: any) => ({ media_type: b.source.media_type, data: b.source.data, name: b.name, kind: b.type === 'image' ? 'image' : 'pdf' }));
        if (!attachments.length) attachments = undefined;
      }
      sess.messages.push({ role: 'user', content: displayContent, _eventUuid: event.uuid, _rawEvent: event, _attachments: attachments });
    } else if (event.type === 'assistant' && event.message) {
      const msg = event.message;
      if (msg.model === '<synthetic>') return proj;
      if (msg.content) {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'thinking' && block.thinking) {
              sess.messages.push({ role: 'thinking', content: block.thinking, _eventUuid: event.uuid, _rawEvent: event });
            } else if (block.type === 'text') {
              if (hasAnsi(block.text)) continue;
              sess.messages.push({ role: 'assistant', content: block.text, _eventUuid: event.uuid, _rawEvent: event });
            } else if (block.type === 'tool_use') {
              sess.messages.push({ role: 'tool', content: `${block.name}: ${JSON.stringify(block.input).substring(0, 100)}`, _eventUuid: event.uuid, _toolUseId: block.id, _rawEvent: event, _toolName: block.name, _toolInput: block.input });
            }
          }
        } else if (typeof msg.content === 'string') {
          if (!hasAnsi(msg.content)) {
            sess.messages.push({ role: 'assistant', content: msg.content, _eventUuid: event.uuid, _rawEvent: event });
          }
        }
      }
    } else if (event.type === 'result') {
      if (event.message?.content) {
        const raw = typeof event.message.content === 'string' ? event.message.content : JSON.stringify(event.message.content);
        if (hasAnsi(raw)) return proj;
        const content = raw.substring(0, 200);
        sess.messages.push({ role: 'tool', content, _eventUuid: event.uuid, _rawEvent: event });
      }
    } else if (event.type === 'system' && event.subtype === 'init') {
      if (event.model) sess.model = event.model;
      if (event.permissionMode) sess.permissionMode = event.permissionMode;
    } else if (event.type === 'system' && event.subtype === 'status') {
      if (event.permissionMode) sess.permissionMode = event.permissionMode;
    } else if (event.type === 'control_request') {
      sess.status = 'waiting';
      sess._pendingControl = event;
      sess.messages.push({
        role: 'control_request',
        content: event.request || event,
        _eventUuid: event.uuid,
        _rawEvent: event,
      });
    } else {
      return proj;
    }

    // Update title from first user message
    if (!sess.title || sess.title === 'New session') {
      const firstUser = sess.messages.find((m) => m.role === 'user');
      if (firstUser) sess.title = firstUser.content.substring(0, 50);
    }

    return {
      ...proj,
      sessions: proj.sessions.map((s, i) => (i === sessIdx ? sess : s)),
    };
  });
  useStore.setState({ projects });
}

// --- Agent WebSocket ---
export function connectAgentWs(sessionId: string) {
  if (agentWsMap[sessionId]) return;
  const proto = getWsProto();
  const ws = new WebSocket(`${proto}//${location.host}/ws/agent/${sessionId}`);
  agentWsMap[sessionId] = ws;

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleAgentMessage(sessionId, msg);
    } catch {}
  };
  ws.onclose = () => {
    delete agentWsMap[sessionId];
  };
}

export function sendAgentCommand(sessionId: string, command: any): boolean {
  const ws = agentWsMap[sessionId];
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(command));
    return true;
  }
  return false;
}

function handleAgentMessage(sessionId: string, msg: any) {
  const store = useStore.getState();
  const projects = store.projects.map((proj) => {
    const sessIdx = proj.sessions.findIndex((s) => s.id === sessionId);
    if (sessIdx === -1) return proj;
    const sess = { ...proj.sessions[sessIdx], messages: [...proj.sessions[sessIdx].messages] };

    console.log('[agent]', msg.type, JSON.stringify(msg).substring(0, 300));

    if (msg.type === 'agent_info') {
      sess._agentInfo = msg;
      if (msg.mode) sess.permissionMode = msg.mode;
      if (msg.model) sess.model = msg.model;
      if (msg.capabilities) sess._capabilities = msg.capabilities;
      return { ...proj, sessions: proj.sessions.map((s, i) => (i === sessIdx ? sess : s)) };
    }

    if (msg.type === 'user_message') {
      if (sess.messages.some((m) => m._eventUuid === msg.id)) return proj;
      sess.messages.push({ role: 'user', content: msg.text, _eventUuid: msg.id, _rawEvent: msg.rawEvent, _attachments: msg.attachments });
    } else if (msg.type === 'assistant_message') {
      if (msg.rawEvent?.message?.model === '<synthetic>') return proj;
      sess.messages.push({ role: 'assistant', content: msg.text, _eventUuid: msg.id, _rawEvent: msg.rawEvent });
    } else if (msg.type === 'thinking') {
      sess.messages.push({ role: 'thinking', content: msg.text, _eventUuid: msg.id, _rawEvent: msg.rawEvent });
    } else if (msg.type === 'plan_approval') {
      sess.status = 'waiting';
      sess._pendingControl = msg;
      sess.messages.push({
        role: 'control_request',
        content: { subtype: 'plan_approval', plan: msg.plan },
        _eventUuid: msg.id,
        _rawEvent: msg.rawEvent,
        _requestId: msg.requestId,
        _responded: msg.responded,
      });
    } else if (msg.type === 'tool_request') {
      if (msg.responded) return proj;
      sess.status = 'waiting';
      sess._pendingControl = msg;
      sess.messages.push({
        role: 'control_request',
        content: {
          subtype: msg.toolName === 'AskUserQuestion' ? 'ask_user_question' : 'tool_use',
          tool_use: { name: msg.toolName, input: msg.input },
        },
        _eventUuid: msg.id,
        _rawEvent: msg.rawEvent,
        _requestId: msg.requestId,
        _responded: msg.responded,
      });
    } else if (msg.type === 'tool_result') {
      if (msg.isPending) {
        sess.messages.push({
          role: 'tool',
          content: `${msg.toolName}: running...`,
          _eventUuid: msg.id,
          _rawEvent: msg.rawEvent,
          _toolName: msg.toolName,
          _toolInput: msg.input,
          _requestId: msg.requestId,
          _pending: true,
        });
      } else {
        const pendingIdx = sess.messages.findIndex((m) => m._pending && m._requestId === msg.requestId);
        if (pendingIdx >= 0) {
          sess.messages[pendingIdx] = {
            ...sess.messages[pendingIdx],
            content: `${msg.toolName}: ${msg.output.substring(0, 100)}`,
            _toolOutput: msg.output,
            _toolInput: sess.messages[pendingIdx]._toolInput || msg.input,
            _isError: msg.isError,
            _pending: false,
            _rawEvent: msg.rawEvent || sess.messages[pendingIdx]._rawEvent,
          };
        } else {
          sess.messages.push({
            role: 'tool',
            content: `${msg.toolName}: ${msg.output.substring(0, 100)}`,
            _eventUuid: msg.id,
            _rawEvent: msg.rawEvent,
            _toolName: msg.toolName,
            _toolInput: msg.input,
            _toolOutput: msg.output,
            _isError: msg.isError,
          });
        }
      }
    } else if (msg.type === 'question') {
      sess.status = 'waiting';
      sess._pendingControl = msg;
      sess.messages.push({
        role: 'control_request',
        content: {
          subtype: 'ask_user_question',
          tool_use: { name: 'AskUserQuestion', input: { questions: msg.questions } },
        },
        _eventUuid: msg.id,
        _rawEvent: msg.rawEvent,
        _requestId: msg.requestId,
        _responded: msg.responded,
      });
    } else if (msg.type === 'status_update') {
      if (msg.mode) sess.permissionMode = msg.mode;
      if (msg.model) sess.model = msg.model;
      if (msg.status === 'active') sess.status = 'running';
      else if (msg.status === 'waiting') sess.status = 'waiting';
      else if (msg.status === 'idle') sess.status = 'idle';
    } else if (msg.type === 'context_usage') {
      sess.contextUsage = {
        model: msg.model,
        usedTokens: msg.usedTokens,
        totalTokens: msg.totalTokens,
        percent: msg.percent,
        freePercent: msg.freePercent,
      };
      return { ...proj, sessions: proj.sessions.map((s, i) => (i === sessIdx ? sess : s)) };
    } else if (msg.type === 'context_in_progress') {
      sess.contextInProgress = !!msg.inProgress;
      return { ...proj, sessions: proj.sessions.map((s, i) => (i === sessIdx ? sess : s)) };
    } else if (msg.type === 'result') {
      sess.status = 'idle';
    } else if (msg.type === 'system_message') {
      sess.messages.push({ role: 'assistant', content: msg.text, _eventUuid: msg.id });
    } else if (msg.type === 'file_change') {
      return proj;
    } else {
      return proj;
    }

    // Update title from first user message
    if (!sess.title || sess.title === 'New session') {
      const firstUser = sess.messages.find((m) => m.role === 'user');
      if (firstUser) sess.title = firstUser.content.substring(0, 50);
    }

    return { ...proj, sessions: proj.sessions.map((s, i) => (i === sessIdx ? sess : s)) };
  });
  useStore.setState({ projects });
}

// --- Settings WebSocket ---
export function connectSettingsWs() {
  const proto = getWsProto();
  settingsWs = new WebSocket(`${proto}//${location.host}/ws/settings`);
  settingsWs.onclose = () => {
    setTimeout(connectSettingsWs, 3000);
  };
}

// --- Session WS map access (for legacy fallback) ---
export function getSessionWs(sessionId: string): WebSocket | undefined {
  return sessionWsMap[sessionId];
}
