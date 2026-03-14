import { useStore } from '../state/store';
import { api } from './index';
import type { Project, EditorFile } from '../types';

// WebSocket instances
let statusWs: WebSocket | null = null;
let settingsWs: WebSocket | null = null;
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
      // Never revive a session that's already ended
      if (sess.status === 'ended') return proj;
      // Handle agent destruction — mark as ended
      if (msg.status === 'exited') {
        return {
          ...proj,
          sessions: proj.sessions.map((s) =>
            s.id === msg.session_id ? { ...s, status: 'ended' as const } : s
          ),
        };
      }
      const newStatus = msg.status === 'active' ? 'active' as const : msg.status === 'attention' ? 'attention' as const : 'open' as const;
      return {
        ...proj,
        sessions: proj.sessions.map((s) =>
          s.id === msg.session_id ? { ...s, status: newStatus } : s
        ),
      };
    });
    useStore.setState({ projects });

    // Browser notification when attention is triggered
    if (msg.status === 'attention' && document.hidden && Notification.permission === 'granted') {
      // Find session title for the notification body
      const sessionTitle = store.projects
        .flatMap(p => p.sessions)
        .find(s => s.id === msg.session_id)?.title || 'Agent session';
      const iconUrl = new URL('/logo_64x64.png', location.origin).href;
      new Notification('Agent needs attention', {
        body: sessionTitle,
        icon: iconUrl,
        badge: iconUrl,
        tag: `atoo-attention-${msg.session_id}`,
      });
    }
  } else if (msg.type === 'session_created' && msg.session) {
    if (pendingAgentCreation) return;
    const s = msg.session;
    const projects = store.projects.map((proj) => {
      if (proj.path === s.directory && !proj.sessions.find((x) => x.id === s.id)) {
        return {
          ...proj,
          sessions: [
            ...proj.sessions,
            {
              id: s.id,
              title: s.title || 'New session',
              status: (s.status === 'active' ? 'active' : 'open') as any,
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
                return {
                  ...proj,
                  sessions: [
                    ...proj.sessions,
                    {
                      id: newSess.id,
                      title: newSess.title || 'New session',
                      status: (newSess.agent_status === 'active' ? 'active' : newSess.agent_status === 'attention' ? 'attention' : 'open') as any,
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
    const proj = s.projects.find((p) => p.id === msg.projectId);
    if (s.showHidden) {
      // Watcher sends default (hidden-filtered) tree; re-fetch with showHidden
      api('GET', `/api/projects/${msg.projectId}/files?showHidden=true`).then((files: any) => {
        useStore.getState().updateProject(msg.projectId, (p) => ({ ...p, files }));
      }).catch(() => {});
    } else {
      s.updateProject(msg.projectId, (p) => ({
        ...p,
        files: msg.files,
      }));
    }
    if (proj && s.openFiles.length > 0) {
      refreshOpenFiles(proj.path, s.openFiles);
    }
  } else if (msg.type === 'project_git_changed' && msg.projectId) {
    const s = useStore.getState();
    s.updateProject(msg.projectId, (p) => ({
      ...p,
      gitChanges: msg.gitChanges,
      gitLog: msg.gitLog,
      stashes: msg.stashes,
    }));
  } else if (msg.type === 'worktrees_changed' && msg.parentProjectId) {
    // Reload environment to pick up added/removed worktree projects
    const s = useStore.getState();
    if (s.activeEnvironmentId) {
      // Dynamic import to avoid circular dependency
      api('GET', `/api/environments/${s.activeEnvironmentId}/projects`).then((projects: any[]) => {
        const current = useStore.getState();
        const newProjects = projects.map((p: any) => {
          // Preserve existing runtime state for known projects
          const existing = current.projects.find(ep => ep.id === p.id);
          if (existing) return { ...existing, ...p, parent_project_id: p.parent_project_id };
          return {
            ...p,
            sessions: [],
            files: [],
            gitChanges: [],
            terminals: [],
            stashes: [],
            gitLog: { branches: [], currentBranch: '', commits: [], remotes: [] },
            activeSessionIdx: 0,
            activeTerminalIdx: 0,
            _filesLoaded: false,
            _gitLoaded: false,
            _sessionsLoaded: false,
          };
        });
        useStore.setState({ projects: newProjects });
      }).catch(() => {});
    }
  } else if (msg.type === 'serial_request') {
    store.addSerialRequest({
      requestId: msg.requestId,
      baudRate: msg.baudRate,
      dataBits: msg.dataBits,
      stopBits: msg.stopBits,
      parity: msg.parity,
      description: msg.description,
      controlSignalsSupported: msg.controlSignalsSupported,
      status: 'pending',
    });
    // Show modal for user to connect a serial device
    useStore.setState({ modal: { type: 'serial-connect', props: { requestId: msg.requestId } } });
  } else if (msg.type === 'session_switch_request') {
    useStore.setState({
      modal: {
        type: 'session-switch',
        props: {
          requestId: msg.requestId,
          targetSessionUuid: msg.targetSessionUuid,
          refinedPrompt: msg.refinedPrompt,
          sourceSessionId: msg.sourceSessionId,
        },
      },
    });
  } else if (msg.type === 'open_file_request') {
    useStore.setState({
      modal: {
        type: 'open-file',
        props: {
          requestId: msg.requestId,
          filePath: msg.filePath,
        },
      },
    });
  } else if (msg.type === 'serial_closed' && msg.requestId) {
    const req = store.serialRequests.find((r) => r.requestId === msg.requestId);
    if (req && req.status === 'connected') {
      store.addToast('Serial', `Serial device disconnected`, 'warning');
    }
    store.removeSerialRequest(msg.requestId);
  } else if (msg.type === 'session_metadata_updated' && msg.sessionUuids) {
    const uuids = new Set<string>(msg.sessionUuids);
    const projects = store.projects.map((proj) => {
      const hasSessionMatch = proj.sessions.some((s) => uuids.has(s.id));
      const hasHistMatch = (proj.historicalSessions || []).some((h) => uuids.has(h.id));
      if (!hasSessionMatch && !hasHistMatch) return proj;
      return {
        ...proj,
        sessions: proj.sessions.map((s) =>
          uuids.has(s.id) ? {
            ...s,
            ...(msg.name !== undefined ? { metaName: msg.name } : {}),
            ...(msg.description !== undefined ? { metaDescription: msg.description } : {}),
            ...(msg.tags ? { tags: msg.tags } : {}),
          } : s
        ),
        historicalSessions: (proj.historicalSessions || []).map((h) =>
          uuids.has(h.id) ? {
            ...h,
            ...(msg.name !== undefined ? { metaName: msg.name } : {}),
            ...(msg.tags ? { tags: msg.tags } : {}),
          } : h
        ),
      };
    });
    useStore.setState({ projects });
  } else if (msg.type === 'service_started' && msg.services) {
    const proj = store.projects.find((p) => msg.cwd && msg.cwd.startsWith(p.path));
    const projName = proj?.name || msg.cwd || 'Unknown';
    for (const s of msg.services) {
      store.addToast(projName, `Started ${s.protocol} service "${s.name}" on port ${s.port}`, 'info');
    }
    store.addReportedServices(msg.services.map((s: any) => ({
      name: s.name,
      description: s.description,
      port: s.port,
      protocol: s.protocol,
      host: s.host,
      cwd: msg.cwd,
      projectName: projName,
      reportedAt: Date.now(),
    })));
    // Auto-manage preview tabs for http/https/ws/wss services
    if (store.previewVisible) {
      const httpServices = msg.services.filter((s: any) =>
        ['http', 'https', 'ws', 'wss'].includes(s.protocol)
      );
      for (const s of httpServices) {
        const port = s.port;
        const existingIdx = store.previewTabs.findIndex((t) => t.targetPort === port);
        if (existingIdx >= 0) {
          // Already have a tab for this port, just activate it
          useStore.setState({ previewActiveIdx: existingIdx });
        } else {
          // Add new streaming tab
          const id = 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
          const label = `${s.name} :${s.port}`;
          const protocol = (s.protocol === 'https' || s.protocol === 'wss') ? 'https' as const : 'http' as const;
          const newTabs = [...store.previewTabs, { id, targetPort: port, protocol, label, headerHost: s.host || undefined }];
          useStore.setState({ previewTabs: newTabs, previewActiveIdx: newTabs.length - 1 });
        }
      }
    }
  }
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

    // Extract sidechain metadata if present
    const sidechainMeta: any = {};
    if (msg._sidechain) {
      sidechainMeta._sidechain = true;
      sidechainMeta._parentToolUseId = msg._parentToolUseId;
      if (msg._agentId) sidechainMeta._agentId = msg._agentId;
    }

    if (msg.type === 'agent_info') {
      sess._agentInfo = msg;
      if (msg.mode) sess.permissionMode = msg.mode;
      if (msg.model) sess.model = msg.model;
      if (msg.capabilities) sess._capabilities = msg.capabilities;
      return { ...proj, sessions: proj.sessions.map((s, i) => (i === sessIdx ? sess : s)) };
    }

    if (msg.type === 'user_message') {
      if (sess.messages.some((m) => m._eventUuid === msg.id)) return proj;
      sess.messages.push({ role: 'user', content: msg.text, _eventUuid: msg.id, _attachments: msg.attachments });
    } else if (msg.type === 'assistant_message') {
      sess.messages.push({ role: 'assistant', content: msg.text, _eventUuid: msg.rawEventUuid || msg.id });
    } else if (msg.type === 'thinking') {
      sess.messages.push({ role: 'thinking', content: msg.text, _eventUuid: msg.rawEventUuid || msg.id });
    } else if (msg.type === 'plan_approval') {
      sess.status = 'attention';
      sess._pendingControl = msg;
      sess.messages.push({
        role: 'control_request',
        content: { subtype: 'plan_approval', plan: msg.plan },
        _eventUuid: msg.id,

        _requestId: msg.requestId,
        _responded: msg.responded,
      });
    } else if (msg.type === 'tool_request') {
      if (msg.responded) return proj;
      sess.status = 'attention';
      sess._pendingControl = msg;
      sess.messages.push({
        role: 'control_request',
        content: {
          subtype: msg.toolName === 'AskUserQuestion' ? 'ask_user_question' : 'tool_use',
          tool_use: { name: msg.toolName, input: msg.input },
        },
        _eventUuid: msg.id,

        _requestId: msg.requestId,
        _responded: msg.responded,
      });
    } else if (msg.type === 'tool_result') {
      if (msg.isPending) {
        sess.messages.push({
          role: 'tool',
          content: `${msg.toolName}: running...`,
          _eventUuid: msg.id,
  
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
                      };
        } else {
          sess.messages.push({
            role: 'tool',
            content: `${msg.toolName}: ${msg.output.substring(0, 100)}`,
            _eventUuid: msg.id,
    
            _toolName: msg.toolName,
            _toolInput: msg.input,
            _toolOutput: msg.output,
            _isError: msg.isError,
          });
        }
      }
    } else if (msg.type === 'question') {
      sess.status = 'attention';
      sess._pendingControl = msg;
      sess.messages.push({
        role: 'control_request',
        content: {
          subtype: 'ask_user_question',
          tool_use: { name: 'AskUserQuestion', input: { questions: msg.questions } },
        },
        _eventUuid: msg.id,

        _requestId: msg.requestId,
        _responded: msg.responded,
      });
    } else if (msg.type === 'status_update') {
      if (msg.mode) sess.permissionMode = msg.mode;
      if (msg.model) sess.model = msg.model;
      if (msg.status === 'active') sess.status = 'active';
      else if (msg.status === 'attention') sess.status = 'attention';
      else if (msg.status === 'open') sess.status = 'open';
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
      sess.status = 'open';
    } else if (msg.type === 'system_message') {
      sess.messages.push({ role: 'assistant', content: msg.text, _eventUuid: msg.id });
    } else if (msg.type === 'file_change') {
      return proj;
    } else {
      return proj;
    }

    // Tag sidechain metadata on any newly pushed messages
    if (sidechainMeta._sidechain && sess.messages.length > proj.sessions[sessIdx].messages.length) {
      for (let mi = proj.sessions[sessIdx].messages.length; mi < sess.messages.length; mi++) {
        sess.messages[mi] = { ...sess.messages[mi], ...sidechainMeta };
      }
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

