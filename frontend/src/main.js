import '@xterm/xterm/css/xterm.css';
import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
const state = {
  projects: [],
  activeProjectId: null,
  activeProjectEnvironmentId: null,
  previewVisible: false,
  fileFilter: 'all',
  fileView: 'tree',
  stashOpen: false,
  activeTabType: 'session',
  // Environment state
  environments: [],
  activeEnvironmentId: null,
  environmentSettings: {},
};

// Per-project view state: editor tabs, active tab type, etc.
const projectViewStates = {};

const editorState = {
  openFiles: [],
  activeFileIdx: -1,
  monacoEditor: null,
  monacoDiffEditor: null,
  monacoReady: false,
};

const previewState = {
  tabs: [],
  activeIdx: 0,
};

const chatAttachments = [];

let selectedFilePath = null;
let selectedFileType = null;
let selectedFileEl = null;

let dragState = {
  srcPath: null,
  srcType: null,
  ghostEl: null,
  expandTimer: null,
};

// WebSocket connections
let statusWs = null;
let sessionWsMap = {};
let agentWsMap = {}; // sessionId → agent WebSocket (abstract layer)
let pendingAgentCreation = false; // suppress legacy session_created handling during agent creation

// Terminal state: Map of terminal id -> { term, fitAddon, ws, container }
const terminalInstances = {};
let xtermModule = null;
let fitAddonModule = null;

// ═══════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════
function connectStatusWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  statusWs = new WebSocket(`${proto}//${location.host}/ws/status`);
  statusWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'agent_status') {
        // Update session status in our state
        for (const proj of state.projects) {
          const sess = proj.sessions.find(s => s.id === msg.session_id);
          if (sess) {
            if (msg.status === 'active') sess.status = 'running';
            else if (msg.status === 'waiting') sess.status = 'waiting';
            else if (msg.status === 'idle') sess.status = 'idle';
            renderSidebarProjects();
            updateGlobalCounts();
            if (proj.id === state.activeProjectId) {
              renderCenterTabs(proj);
            }
          }
        }
      } else if (msg.type === 'session_created' && msg.session) {
        // Skip if we're in the middle of creating an agent session —
        // the CLI's internal session_created would create a duplicate entry
        // with the CLI session ID. The agent session will be added by newSession().
        if (pendingAgentCreation) { /* suppress */ }
        else {
        // New session created (possibly from another browser) — refresh sessions
        const s = msg.session;
        for (const proj of state.projects) {
          // Match by directory path, skip if we already know this session
          if (proj.path === s.directory && !proj.sessions.find(x => x.id === s.id)) {
            // Add session immediately for instant UI feedback
            proj.sessions.push({
              id: s.id,
              title: s.title || 'New session',
              status: s.status === 'active' ? 'running' : 'idle',
              startedAt: new Date(s.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              messages: [],
              lastMessage: '',
              viewMode: 'chat',
              permissionMode: s.permission_mode || null,
              model: s.model || null,
            });
            connectSessionWs(s.id);
            renderSidebarProjects();
            updateGlobalCounts();
            if (proj.id === state.activeProjectId) {
              renderCenterTabs(proj);
              renderCenterContent(proj);
              renderSessions(proj);
            }
            break;
          }
        }
        // Also handle case where no project path matched — re-fetch sessions for active project
        if (state.activeProjectId) {
          const activeProj = state.projects.find(p => p.id === state.activeProjectId);
          if (activeProj && !activeProj.sessions.find(x => x.id === s.id)) {
            // Path didn't match — try fetching sessions from API as fallback
            api('GET', `/api/projects/${activeProj.id}/sessions`).then(sessions => {
              const newSess = sessions.find(x => x.id === s.id);
              if (newSess && !activeProj.sessions.find(x => x.id === s.id)) {
                activeProj.sessions.push({
                  id: newSess.id,
                  title: newSess.title || 'New session',
                  status: newSess.agent_status === 'active' ? 'running' : newSess.agent_status === 'waiting' ? 'waiting' : 'idle',
                  startedAt: new Date(newSess.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                  messages: [],
                  lastMessage: '',
                  viewMode: 'chat',
                  permissionMode: newSess.permission_mode || null,
                  model: newSess.model || null,
                });
                connectSessionWs(newSess.id);
                renderSidebarProjects();
                updateGlobalCounts();
                renderCenterTabs(activeProj);
                renderCenterContent(activeProj);
                renderSessions(activeProj);
              }
            }).catch(() => {});
          }
        }
      } // end else (not pendingAgentCreation)
      }
      else if (msg.type === 'terminal_created' && msg.terminal) {
        const t = msg.terminal;
        for (const proj of state.projects) {
          if (proj.path === t.projectPath && !proj.terminals?.find(x => x.shellId === t.id)) {
            if (!proj.terminals) proj.terminals = [];
            proj.terminals.push({ id: `shell-${t.id}`, name: `bash-${proj.terminals.length}`, shellId: t.id });
            if (proj.id === state.activeProjectId) {
              renderCenterTabs(proj);
            }
            break;
          }
        }
      }
      else if (msg.type === 'terminal_exited' && msg.terminal) {
        for (const proj of state.projects) {
          const idx = proj.terminals?.findIndex(x => x.shellId === msg.terminal.id);
          if (idx >= 0) {
            proj.terminals.splice(idx, 1);
            if (proj.id === state.activeProjectId) {
              renderCenterTabs(proj);
              renderCenterContent(proj);
            }
            break;
          }
        }
      }
      else if (msg.type === 'context_usage' && msg.session_id) {
        // Store token usage on the session object
        for (const proj of state.projects) {
          const sess = proj.sessions.find(s => s.id === msg.session_id);
          if (sess) {
            sess.contextUsage = { model: msg.model, usedTokens: msg.usedTokens, totalTokens: msg.totalTokens, percent: msg.percent, freePercent: msg.freePercent };
            if (proj.id === state.activeProjectId) {
              const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
              const activeSession = activeSessions[proj.activeSessionIdx || 0];
              if (activeSession && activeSession.id === msg.session_id) {
                updateChatStatusBar(sess);
              }
            }
            break;
          }
        }
      }
      else if (msg.type === 'context_in_progress' && msg.session_id) {
        for (const proj of state.projects) {
          const sess = proj.sessions.find(s => s.id === msg.session_id);
          if (sess) {
            sess.contextInProgress = !!msg.inProgress;
            if (proj.id === state.activeProjectId) {
              const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
              const activeSession = activeSessions[proj.activeSessionIdx || 0];
              if (activeSession && activeSession.id === msg.session_id) {
                setChatInputsDisabled(msg.inProgress);
              }
            }
            break;
          }
        }
      }
    } catch (err) { console.error('[ws:status] handler error:', err); }
  };
  statusWs.onclose = () => { setTimeout(connectStatusWs, 3000); };
}

function connectSessionWs(sessionId) {
  if (sessionWsMap[sessionId]) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
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

function handleSessionEvent(sessionId, event) {
  // Find the project and session
  for (const proj of state.projects) {
    const sess = proj.sessions.find(s => s.id === sessionId);
    if (!sess) continue;

    // Helper: extract text from event content (string or array of content blocks)
    function getEventText(content) {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(b => b.text || b.content || '').join('');
      }
      return '';
    }
    // Helper: check if text contains ANSI escape codes
    function hasAnsi(text) { return /\x1b\[/.test(text); }

    // DEBUG: log all events to help diagnose what the CLI sends
    console.log('[event]', event.type, JSON.stringify(event).substring(0, 300));

    // Normalize event into chat message format
    if (event.type === 'user' && event.message) {
      // Skip synthetic events (injected by CLI for slash commands)
      if (event.isSynthetic) return;
      const text = getEventText(event.message.content);
      // Skip slash commands, CLI XML-tagged commands, and ANSI output
      if (text.startsWith('/') || hasAnsi(text)) return;
      if (/<command-name>|<local-command-caveat>|<command-message>/.test(text)) return;
      // Skip tool_result blocks (these are internal, not user-visible chat)
      if (Array.isArray(event.message.content) && event.message.content.every(b => b.type === 'tool_result')) return;
      // Skip if we already have this message (sent by us or already received)
      if (sess.messages.some(m => m._eventUuid === event.uuid)) return;
      const displayContent = typeof event.message.content === 'string' ? event.message.content : text;
      // Extract image attachments from content blocks
      let attachments;
      if (Array.isArray(event.message.content)) {
        attachments = event.message.content
          .filter(b => b.type === 'image' && b.source)
          .map(b => ({ media_type: b.source.media_type, data: b.source.data }));
        if (!attachments.length) attachments = undefined;
      }
      sess.messages.push({ role: 'user', content: displayContent, _eventUuid: event.uuid, _rawEvent: event, _attachments: attachments });
    } else if (event.type === 'assistant' && event.message) {
      const msg = event.message;
      if (msg.content) {
        // Handle content array or string
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text') {
              if (hasAnsi(block.text)) continue;
              sess.messages.push({ role: 'assistant', content: block.text, _eventUuid: event.uuid, _rawEvent: event });
            } else if (block.type === 'tool_use') {
              sess.messages.push({ role: 'tool', content: `${block.name}: ${JSON.stringify(block.input).substring(0, 100)}`, _eventUuid: event.uuid, _toolUseId: block.id, _rawEvent: event });
            }
          }
        } else if (typeof msg.content === 'string') {
          if (!hasAnsi(msg.content)) {
            sess.messages.push({ role: 'assistant', content: msg.content, _eventUuid: event.uuid, _rawEvent: event });
          }
        }
      }
    } else if (event.type === 'result') {
      // Tool result — skip raw ANSI output (e.g. from auto /context)
      if (event.message?.content) {
        const raw = typeof event.message.content === 'string' ? event.message.content : JSON.stringify(event.message.content);
        if (hasAnsi(raw)) return;
        const content = raw.substring(0, 200);
        sess.messages.push({ role: 'tool', content: content, _eventUuid: event.uuid, _rawEvent: event });
      }
    } else if (event.type === 'system' && event.subtype === 'init') {
      // Capture model and permission mode from CLI's system init event
      if (event.model) sess.model = event.model;
      if (event.permissionMode) sess.permissionMode = event.permissionMode;
      // Update status bar if this is the active session
      if (proj.id === state.activeProjectId) {
        const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
        const activeSession = activeSessions[proj.activeSessionIdx || 0];
        if (activeSession && activeSession.id === sess.id) {
          updateChatStatusBar(sess);
        }
      }
    } else if (event.type === 'system' && event.subtype === 'status') {
      // Status updates can carry permissionMode changes
      if (event.permissionMode) {
        sess.permissionMode = event.permissionMode;
        if (proj.id === state.activeProjectId) {
          const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
          const activeSession = activeSessions[proj.activeSessionIdx || 0];
          if (activeSession && activeSession.id === sess.id) {
            updateChatStatusBar(sess);
          }
        }
      }
    } else if (event.type === 'control_request') {
      // Tool approval needed
      sess.status = 'waiting';
      sess._pendingControl = event;
      sess.messages.push({
        role: 'control_request',
        content: event.request || event,
        _eventUuid: event.uuid,
        _rawEvent: event,
      });
    }

    // Update title from first user message
    if (!sess.title || sess.title === 'New session') {
      const firstUser = sess.messages.find(m => m.role === 'user');
      if (firstUser) {
        sess.title = firstUser.content.substring(0, 50);
      }
    }

    // Re-render if this is the active project
    if (proj.id === state.activeProjectId) {
      renderChat(proj);
      renderCenterTabs(proj);
      renderSessions(proj);
    }
    renderSidebarProjects();
    updateGlobalCounts();
    return;
  }
}

// ═══════════════════════════════════════════════════════
// AGENT WEBSOCKET (Abstract Layer)
// ═══════════════════════════════════════════════════════

function connectAgentWs(sessionId) {
  if (agentWsMap[sessionId]) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
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

function sendAgentCommand(sessionId, command) {
  const ws = agentWsMap[sessionId];
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(command));
    return true;
  }
  return false;
}

function handleAgentMessage(sessionId, msg) {
  // Find the project and session
  for (const proj of state.projects) {
    const sess = proj.sessions.find(s => s.id === sessionId);
    if (!sess) continue;

    console.log('[agent]', msg.type, JSON.stringify(msg).substring(0, 300));

    if (msg.type === 'agent_info') {
      // Initial agent info — update capabilities, mode, model
      sess._agentInfo = msg;
      if (msg.mode) sess.permissionMode = msg.mode;
      if (msg.model) sess.model = msg.model;
      if (msg.capabilities) sess._capabilities = msg.capabilities;
      if (proj.id === state.activeProjectId) {
        updateChatStatusBar(sess);
      }
      return;
    }

    if (msg.type === 'user_message') {
      if (sess.messages.some(m => m._eventUuid === msg.id)) return;
      sess.messages.push({ role: 'user', content: msg.text, _eventUuid: msg.id, _attachments: msg.attachments });
    } else if (msg.type === 'assistant_message') {
      sess.messages.push({ role: 'assistant', content: msg.text, _eventUuid: msg.id });
    } else if (msg.type === 'tool_request') {
      sess.status = 'waiting';
      sess._pendingControl = msg;
      // Check if it's an AskUserQuestion-type by tool name
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
      sess.messages.push({
        role: 'tool',
        content: `${msg.toolName}: ${msg.output.substring(0, 100)}`,
        _eventUuid: msg.id,
      });
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
        _requestId: msg.requestId,
        _responded: msg.responded,
      });
    } else if (msg.type === 'status_update') {
      if (msg.mode) sess.permissionMode = msg.mode;
      if (msg.model) sess.model = msg.model;
      if (msg.status === 'active') sess.status = 'running';
      else if (msg.status === 'waiting') sess.status = 'waiting';
      else if (msg.status === 'idle') sess.status = 'idle';
      if (proj.id === state.activeProjectId) {
        updateChatStatusBar(sess);
      }
    } else if (msg.type === 'context_usage') {
      sess.contextUsage = {
        model: msg.model,
        usedTokens: msg.usedTokens,
        totalTokens: msg.totalTokens,
        percent: msg.percent,
        freePercent: msg.freePercent,
      };
      if (proj.id === state.activeProjectId) {
        const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
        const activeSession = activeSessions[proj.activeSessionIdx || 0];
        if (activeSession && activeSession.id === msg.sessionId) {
          updateChatStatusBar(sess);
        }
      }
      return; // Don't re-render chat for context updates
    } else if (msg.type === 'context_in_progress') {
      sess.contextInProgress = !!msg.inProgress;
      if (proj.id === state.activeProjectId) {
        const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
        const activeSession = activeSessions[proj.activeSessionIdx || 0];
        if (activeSession && activeSession.id === sess.id) {
          setChatInputsDisabled(msg.inProgress);
        }
      }
      return; // Don't re-render chat for context progress updates
    } else if (msg.type === 'result') {
      // Turn complete — mark idle
      sess.status = 'idle';
    } else if (msg.type === 'system_message') {
      sess.messages.push({ role: 'assistant', content: msg.text, _eventUuid: msg.id });
    } else if (msg.type === 'file_change') {
      // File change notifications — could update changes panel
      return;
    }

    // Update title from first user message
    if (!sess.title || sess.title === 'New session') {
      const firstUser = sess.messages.find(m => m.role === 'user');
      if (firstUser) {
        sess.title = firstUser.content.substring(0, 50);
      }
    }

    // Re-render
    if (proj.id === state.activeProjectId) {
      renderChat(proj);
      renderCenterTabs(proj);
      renderSessions(proj);
    }
    renderSidebarProjects();
    updateGlobalCounts();
    return;
  }
}

// ═══════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════
function getProjectStatus(proj) {
  if (proj.sessions.some(s => s.status === 'waiting')) return 'waiting';
  if (proj.sessions.some(s => s.status === 'running')) return 'running';
  return 'idle';
}

function renderSidebarProjects() {
  const list = document.getElementById('project-list');
  list.innerHTML = state.projects.map(p => {
    const status = getProjectStatus(p);
    const isActive = p.id === state.activeProjectId;
    const initials = p.name.substring(0, 2).toUpperCase();
    const waitingCount = p.sessions.filter(s => s.status === 'waiting').length;
    const runningCount = p.sessions.filter(s => s.status === 'running').length;
    const sessionCount = p.sessions.length;

    return `<div class="project-item ${isActive ? 'active' : ''}" onclick="selectProject('${p.id}', '${p.pe_id || ''}')" title="${p.name}">
      <div class="project-square-icon">
        ${initials}
        <span class="project-square-notif ${status}"></span>
      </div>
      <span class="project-dot ${status}"></span>
      <div class="project-info">
        <div class="project-name">${p.name}</div>
        <div class="project-path">${p.path}</div>
      </div>
      <div class="project-badges">
        ${waitingCount > 0 ? `<span class="badge badge-attention">${waitingCount}</span>` : ''}
        ${runningCount > 0 ? `<span class="badge badge-tui">${runningCount}</span>` : ''}
        ${p.isGit ? '<span class="badge badge-git">⑂</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

function updateGlobalCounts() {
  let attention = 0, active = 0;
  state.projects.forEach(p => {
    if (p.sessions.some(s => s.status === 'waiting')) attention++;
    if (p.sessions.some(s => s.status === 'running' || s.status === 'waiting')) active++;
  });
  document.getElementById('count-attention').textContent = attention;
  document.getElementById('count-active').textContent = active;
  document.getElementById('count-total').textContent = state.projects.length;
}

function toggleSidebarCollapse() {
  const sidebar = document.getElementById('sidebar');
  const app = document.getElementById('app');
  const isCollapsed = sidebar.classList.toggle('collapsed');
  if (isCollapsed) {
    sidebar._savedWidth = getComputedStyle(app).getPropertyValue('--sidebar-w').trim() || '260px';
    app.style.setProperty('--sidebar-w', '64px');
  } else {
    app.style.setProperty('--sidebar-w', sidebar._savedWidth || '260px');
  }
  saveEnvSettings({ sidebar_collapsed: isCollapsed ? 1 : 0, sidebar_width: isCollapsed ? sidebar._savedWidth : getComputedStyle(app).getPropertyValue('--sidebar-w').trim() });
}

// ═══════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════
function renderOverview() {
  const grid = document.getElementById('overview-grid');
  grid.innerHTML = state.projects.map(p => {
    const status = getProjectStatus(p);
    const hasAttention = p.sessions.some(s => s.status === 'waiting');
    const sessionCount = p.sessions.length;
    const changeCount = (p.gitChanges || []).length;

    const sessionsHtml = p.sessions.slice(0, 3).map(s => {
      const dotClass = s.status === 'ended' ? 'ended' : s.status === 'waiting' ? 'waiting' : s.status === 'running' ? 'live' : 'ended';
      return `<div class="oc-session-line">
        <span class="oc-session-dot ${dotClass}"></span>
        <span class="oc-session-name">${s.title}</span>
        <span class="oc-session-time">${s.startedAt || ''}</span>
      </div>`;
    }).join('');

    return `<div class="overview-card ${hasAttention ? 'has-attention' : ''}" onclick="selectProject('${p.id}', '${p.pe_id || ''}')">
      <div class="oc-header">
        <span class="oc-dot ${status}"></span>
        <span class="oc-name">${p.name}</span>
      </div>
      <div class="oc-path">${p.path}</div>
      <div class="oc-stats">
        <span class="oc-stat"><span class="oc-stat-icon">◉</span><span class="oc-stat-value">${sessionCount}</span> sessions</span>
        ${p.isGit ? `<span class="oc-stat"><span class="oc-stat-icon">Δ</span><span class="oc-stat-value">${changeCount}</span> changes</span>` : ''}
      </div>
      ${sessionsHtml ? `<div class="oc-sessions">${sessionsHtml}</div>` : ''}
    </div>`;
  }).join('');
}

function showOverview() {
  saveProjectViewState(state.activeProjectId);
  if (state.activeProjectId && state.activeProjectEnvironmentId) {
    flushProjectSettings();
  }
  state.activeProjectId = null;
  state.activeProjectEnvironmentId = null;
  document.getElementById('overview-screen').classList.remove('hidden');
  document.getElementById('workspace').classList.add('hidden');
  document.getElementById('topbar-project-name').textContent = 'Overview';
  document.getElementById('topbar-breadcrumb').textContent = '';
  renderSidebarProjects();
  renderOverview();
  if (state.activeEnvironmentId) {
    history.pushState(null, '', '/vccenv/' + state.activeEnvironmentId);
  }
}

// ═══════════════════════════════════════════════════════
// WORKSPACE / PROJECT SELECTION
// ═══════════════════════════════════════════════════════
function saveProjectViewState(projectId) {
  if (!projectId) return;
  projectViewStates[projectId] = {
    openFiles: editorState.openFiles.slice(),
    activeFileIdx: editorState.activeFileIdx,
    activeTabType: state.activeTabType,
    editorAreaHeight: document.getElementById('editor-area')?.style.height || '',
    editorAreaOpen: document.getElementById('editor-area')?.classList.contains('open') || false,
  };
}

function restoreProjectViewState(projectId) {
  const saved = projectViewStates[projectId];
  if (saved) {
    editorState.openFiles = saved.openFiles;
    editorState.activeFileIdx = saved.activeFileIdx;
    state.activeTabType = saved.activeTabType;
    const editorArea = document.getElementById('editor-area');
    if (saved.editorAreaOpen) {
      editorArea.classList.add('open');
      editorArea.style.height = saved.editorAreaHeight;
    } else {
      editorArea.classList.remove('open');
      editorArea.style.height = '0';
    }
  } else {
    // Fresh project — reset editor state
    editorState.openFiles = [];
    editorState.activeFileIdx = -1;
    state.activeTabType = 'session';
    const editorArea = document.getElementById('editor-area');
    editorArea.classList.remove('open');
    editorArea.style.height = '0';
  }
}

async function selectProject(projectId, peId, fromRouter = false) {
  // Save current project's view state before switching
  saveProjectViewState(state.activeProjectId);
  if (state.activeProjectId && state.activeProjectEnvironmentId) {
    flushProjectSettings();
  }

  state.activeProjectId = projectId;
  // Resolve pe_id: use explicit param, or look up from projects array
  if (peId) {
    state.activeProjectEnvironmentId = peId;
  } else {
    const proj = state.projects.find(p => p.id === projectId);
    state.activeProjectEnvironmentId = proj?.pe_id || null;
  }

  const proj = state.projects.find(p => p.id === projectId);
  if (!proj) return;

  // Load settings from DB if available
  if (state.activeProjectEnvironmentId) {
    try {
      const dbSettings = await api('GET', `/api/project-links/${state.activeProjectEnvironmentId}/settings`);
      if (dbSettings && Object.keys(dbSettings).length > 0) {
        applyProjectSettings(dbSettings);
      } else {
        restoreProjectViewState(projectId);
      }
    } catch {
      restoreProjectViewState(projectId);
    }
  } else {
    restoreProjectViewState(projectId);
  }

  if (!fromRouter && state.activeProjectEnvironmentId) {
    history.pushState(null, '', '/project/' + state.activeProjectEnvironmentId);
  }

  document.getElementById('overview-screen').classList.add('hidden');
  document.getElementById('workspace').classList.remove('hidden');
  document.getElementById('topbar-project-name').textContent = proj.name;
  document.getElementById('topbar-breadcrumb').textContent = proj.path;

  // Lazy-load file tree
  if (!proj._filesLoaded) {
    try {
      proj.files = await api('GET', `/api/projects/${proj.id}/files`);
      proj._filesLoaded = true;
    } catch (e) {
      proj.files = [];
      console.error('Failed to load files:', e);
    }
  }

  // Lazy-load git data
  if (proj.isGit && !proj._gitLoaded) {
    try {
      const [status, branches, stashes, remotes] = await Promise.all([
        api('GET', `/api/projects/${proj.id}/git/status`),
        api('GET', `/api/projects/${proj.id}/git/branches`),
        api('GET', `/api/projects/${proj.id}/git/stash`),
        api('GET', `/api/projects/${proj.id}/git/remotes`),
      ]);
      proj.gitChanges = status;
      proj.gitLog = {
        branches: branches.branches,
        currentBranch: branches.currentBranch,
        remotes: remotes,
        commits: [],
      };
      proj.stashes = stashes;
      proj._gitLoaded = true;

      // Load git log
      try {
        const log = await api('GET', `/api/projects/${proj.id}/git/log`);
        proj.gitLog.commits = log.map((c, i) => ({
          ...c,
          refs: i === 0 ? [{ type: 'head', label: 'HEAD' }, { type: 'branch', label: branches.currentBranch }] : [],
        }));
      } catch {}
    } catch (e) {
      proj.gitChanges = [];
      proj.gitLog = { branches: [], currentBranch: '', commits: [], remotes: [] };
      proj.stashes = [];
      console.error('Failed to load git data:', e);
    }
  }

  // Lazy-load sessions + historical sessions in parallel
  if (!proj._sessionsLoaded) {
    try {
      const [sessions, historical] = await Promise.all([
        api('GET', `/api/projects/${proj.id}/sessions`),
        api('GET', '/api/historical-sessions').catch(() => []),
      ]);
      proj.sessions = sessions.map(s => ({
        id: s.id,
        title: s.title || 'Untitled',
        status: s.agent_status === 'active' ? 'running' : s.agent_status === 'waiting' ? 'waiting' : 'idle',
        startedAt: new Date(s.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        messages: [],
        lastMessage: '',
        viewMode: 'chat',
        model: s.model || null,
        permissionMode: s.permission_mode || null,
      }));
      // Filter historical sessions for this project's directory, already sorted by date desc
      const activeIds = new Set(proj.sessions.map(s => s.id));
      proj.historicalSessions = historical
        .filter(h => h.directory === proj.path && !activeIds.has(h.id))
        .map(h => ({
          id: h.id,
          agentType: h.agentType,
          title: h.title || 'Untitled',
          lastModified: h.lastModified,
          eventCount: h.eventCount,
        }));
      // Connect WebSocket for each live session
      for (const s of proj.sessions) {
        if (s.status !== 'ended') {
          connectSessionWs(s.id);
        }
      }
      proj._sessionsLoaded = true;
    } catch {}
  }

  // Lazy-load terminals (restore from server)
  if (!proj._terminalsLoaded) {
    try {
      const terminals = await api('GET', '/api/terminals');
      const projTerminals = terminals.filter(t => t.projectPath === proj.path);
      for (const t of projTerminals) {
        if (!proj.terminals.find(x => x.shellId === t.id)) {
          proj.terminals.push({ id: `shell-${t.id}`, name: `bash-${proj.terminals.length}`, shellId: t.id });
        }
      }
      proj._terminalsLoaded = true;
    } catch {}
  }

  // Dispose current editors before switching (they belong to the previous project)
  disposeEditors();

  renderSidebarProjects();
  renderFileTree(proj);
  renderGitHistory(proj);
  renderCenterTabs(proj);
  renderCenterContent(proj);
  renderSessions(proj);
  renderEditorTabs();
  renderEditorContent();

  // Update stash button state
  const stashBtn = document.getElementById('tb-stash-toggle');
  if (proj.stashes && proj.stashes.length > 0) {
    stashBtn.classList.remove('disabled');
  } else {
    stashBtn.classList.add('disabled');
  }

  // Show/hide git actions
  const gitActions = document.getElementById('lp-git-actions');
  gitActions.style.display = proj.isGit ? '' : 'none';
}

// ═══════════════════════════════════════════════════════
// FILE EXPLORER
// ═══════════════════════════════════════════════════════
function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    ts: '⊤', tsx: '⊤', js: '◇', jsx: '◇', py: '⊕', rs: '⊗', go: '◈',
    json: '{}', yaml: '≡', yml: '≡', toml: '≡', md: '◉', txt: '◉',
    html: '◇', css: '◇', scss: '◇', astro: '✦', vue: '▽', svelte: '◈',
    svg: '▣', png: '▣', jpg: '▣', gif: '▣', webp: '▣',
    lock: '⊟', gitignore: '⊘',
  };
  return icons[ext] || '◇';
}

function setFileFilter(filter) {
  state.fileFilter = filter;
  document.getElementById('tb-filter-all')?.classList.toggle('active', filter === 'all');
  document.getElementById('tb-filter-changed')?.classList.toggle('active', filter === 'changed');
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (proj) renderFileTree(proj);
  saveProjectSettings({ file_filter: filter });
}

function setFileView(view) {
  state.fileView = view;
  document.getElementById('tb-view-tree')?.classList.toggle('active', view === 'tree');
  document.getElementById('tb-view-flat')?.classList.toggle('active', view === 'flat');
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (proj) renderFileTree(proj);
  saveProjectSettings({ file_view: view });
}

function toggleStashPanel() {
  state.stashOpen = !state.stashOpen;
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (proj) renderStashPanel(proj);
  saveProjectSettings({ stash_open: state.stashOpen });
}

function renderStashPanel(proj) {
  const panel = document.getElementById('stash-panel');
  panel.classList.toggle('open', state.stashOpen);
  if (!state.stashOpen || !proj.stashes || proj.stashes.length === 0) {
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = `
    <div class="stash-header">
      <span class="stash-header-title">Stashes (${proj.stashes.length})</span>
    </div>
    ${proj.stashes.map(s => `
      <div class="stash-item">
        <span class="stash-icon">⊟</span>
        <span class="stash-name">${s.name}</span>
        <div class="stash-actions">
          <button class="stash-action-btn apply" onclick="applyStash('${s.id}')">apply</button>
          <button class="stash-action-btn drop" onclick="dropStash('${s.id}')">drop</button>
        </div>
      </div>
    `).join('')}
  `;
}

function renderFileTree(proj) {
  const panel = document.getElementById('files-panel');
  const gitMap = {};
  (proj.gitChanges || []).forEach(c => { gitMap[c.file] = c.status; });

  // Update change count
  const changeCount = Object.keys(gitMap).length;
  const countEl = document.getElementById('lp-change-count');
  if (changeCount > 0) {
    countEl.style.display = '';
    countEl.textContent = changeCount;
  } else {
    countEl.style.display = 'none';
  }

  if (state.fileFilter === 'changed') {
    panel.innerHTML = renderChangedFilesTree(proj, gitMap);
  } else if (state.fileView === 'flat') {
    panel.innerHTML = renderFlatList(proj.files || [], '', gitMap);
  } else {
    panel.innerHTML = renderTreeNodes(proj.files || [], '', gitMap, 0);
  }

  // Enable drag-drop on all file items
  panel.querySelectorAll('[draggable="true"]').forEach(el => {
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOverItem);
    el.addEventListener('dragleave', onDragLeaveItem);
    el.addEventListener('drop', onDropItem);
  });

  // Panel drop root
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (dragState.srcPath) panel.classList.add('drop-root');
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('drop-root'));
  panel.addEventListener('drop', (e) => {
    panel.classList.remove('drop-root');
    onDropRoot(e);
  });

  renderStashPanel(proj);
}

function renderTreeNodes(nodes, parentPath, gitMap, depth) {
  if (!nodes) return '';
  return nodes.map(node => {
    const fullPath = parentPath ? parentPath + '/' + node.name : node.name;
    const isDir = node.type === 'dir';
    const icon = isDir ? '▸' : getFileIcon(node.name);
    const gitBadge = gitMap[fullPath] ? `<span class="file-git-badge ${gitMap[fullPath]}">${gitMap[fullPath]}</span>` : '';

    if (isDir) {
      const children = renderTreeNodes(node.children || [], fullPath, gitMap, depth + 1);
      return `<div class="file-tree-item" style="--depth:${depth}" data-path="${fullPath}" data-type="dir" draggable="true"
        onclick="toggleDir(this)" ondblclick="dblClickFile(this)" oncontextmenu="showCtxMenu(event,'${esc(fullPath)}','dir')">
        <span class="file-tree-icon">${icon}</span>
        <span class="file-tree-name folder">${node.name}</span>
        ${gitBadge}
      </div>
      <div class="dir-children" style="display:none">${children}</div>`;
    }

    return `<div class="file-tree-item" style="--depth:${depth}" data-path="${fullPath}" data-type="file" draggable="true"
      onclick="selectFileItem(this)" ondblclick="dblClickFile(this)" oncontextmenu="showCtxMenu(event,'${esc(fullPath)}','file')">
      <span class="file-tree-icon">${icon}</span>
      <span class="file-tree-name file">${node.name}</span>
      ${gitBadge}
    </div>`;
  }).join('');
}

function renderFlatList(nodes, parentPath, gitMap) {
  let html = '';
  function walk(items, prefix) {
    for (const node of items) {
      const fullPath = prefix ? prefix + '/' + node.name : node.name;
      if (node.type === 'dir' && node.children) {
        walk(node.children, fullPath);
      } else if (node.type === 'file') {
        const gitBadge = gitMap[fullPath] ? `<span class="file-git-badge ${gitMap[fullPath]}">${gitMap[fullPath]}</span>` : '';
        html += `<div class="file-flat-item" data-path="${fullPath}" data-type="file" draggable="true"
          onclick="selectFileItem(this)" ondblclick="dblClickFile(this)" oncontextmenu="showCtxMenu(event,'${esc(fullPath)}','file')">
          <span class="file-tree-icon">${getFileIcon(node.name)}</span>
          <span class="file-flat-path"><span class="file-flat-name">${node.name}</span> <span style="color:var(--text-muted)">${parentPath ? parentPath + '/' : ''}</span></span>
          ${gitBadge}
        </div>`;
      }
    }
  }
  walk(nodes, parentPath);
  return html;
}

function renderChangedFilesTree(proj, gitMap) {
  const changes = Object.entries(gitMap);
  if (changes.length === 0) {
    return '<div class="empty-state" style="padding:20px"><div class="empty-state-icon">✓</div><div class="empty-state-title">No changes</div></div>';
  }
  return changes.map(([file, status]) => {
    const name = file.split('/').pop();
    return `<div class="file-flat-item" data-path="${file}" data-type="file"
      onclick="selectFileItem(this)" ondblclick="dblClickFile(this)" oncontextmenu="showCtxMenu(event,'${esc(file)}','file')">
      <span class="file-git-badge ${status}">${status}</span>
      <span class="file-flat-path">${file}</span>
    </div>`;
  }).join('');
}

function toggleDir(el) {
  const children = el.nextElementSibling;
  if (children && children.classList.contains('dir-children')) {
    const isOpen = children.style.display !== 'none';
    children.style.display = isOpen ? 'none' : '';
    const icon = el.querySelector('.file-tree-icon');
    if (icon) icon.textContent = isOpen ? '▸' : '▾';
  }
}

// ═══════════════════════════════════════════════════════
// GIT HISTORY PANEL
// ═══════════════════════════════════════════════════════
function renderGitHistory(proj) {
  if (!proj.isGit || !proj.gitLog) {
    document.getElementById('git-history-panel').innerHTML = '<div class="gh-empty"><span class="gh-empty-icon">⊘</span><span class="gh-empty-title">Not a git repository</span></div>';
    return;
  }

  // Branches
  const select = document.getElementById('gh-branch-select');
  select.innerHTML = (proj.gitLog.branches || []).map(b => {
    const isRemote = b.startsWith('remotes/');
    const display = isRemote ? b.replace('remotes/', '') : b;
    return `<option value="${b}" ${b === proj.gitLog.currentBranch ? 'selected' : ''}>${display}</option>`;
  }).join('');

  // Commits
  const list = document.getElementById('gh-commit-list');
  const commits = proj.gitLog.commits || [];
  list.innerHTML = commits.map((c, i) => {
    const isHead = (c.refs || []).some(r => r.type === 'head');
    const isMerge = c.merge;
    const refsHtml = (c.refs || []).map(r => {
      let cls = 'gh-ref-badge ';
      if (r.type === 'head') cls += 'head-badge';
      else if (r.type === 'branch') cls += 'branch-badge';
      else if (r.type === 'tag') cls += 'tag-badge';
      else if (r.type === 'remote') cls += 'remote-badge';
      return `<span class="${cls}">${r.label}</span>`;
    }).join('');

    return `<div class="gh-commit ${isHead ? 'head' : ''} ${isMerge ? 'merge' : ''}" onclick="selectCommit('${c.hash}')" oncontextmenu="showCommitCtxMenu(event,'${c.hash}')">
      <div class="gh-graph">
        <div class="gh-graph-line"></div>
        <div class="gh-graph-dot"></div>
      </div>
      <div class="gh-commit-body">
        <div class="gh-commit-msg">${escHtml(c.msg)}${refsHtml ? '<span class="gh-commit-refs">' + refsHtml + '</span>' : ''}</div>
        <div class="gh-commit-meta">
          <span class="gh-commit-expand" onclick="event.stopPropagation();toggleCommitExpand('${c.hash}')">▸</span>
          <span class="gh-commit-hash" onclick="event.stopPropagation();copyHash('${c.hash}')">${c.hash}</span>
          <span class="gh-commit-author">${c.author}</span>
          ${(c.files || []).length > 0 ? `<span class="gh-commit-file-count">${c.files.length} files</span>` : ''}
          <span class="gh-commit-date">${c.date}</span>
        </div>
      </div>
    </div>
    <div class="gh-commit-files" id="cf-${c.hash}">${renderCommitFiles(c)}</div>`;
  }).join('');
}

function renderCommitFiles(commit) {
  return (commit.files || []).map(f => {
    const statusMap = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
    const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/') + 1) : '';
    const name = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
    return `<div class="gh-file-item" onclick="openFileInEditor('${esc(f.path)}')">
      <span class="gh-file-status ${statusMap[f.status] || ''}">${f.status}</span>
      <span class="gh-file-path">${dir ? '<span class="gh-file-path-dir">' + dir + '</span>' : ''}${name}</span>
      <span class="gh-file-stats">${f.additions ? '<span class="gh-file-add">+' + f.additions + '</span>' : ''}${f.deletions ? '<span class="gh-file-del">-' + f.deletions + '</span>' : ''}</span>
    </div>`;
  }).join('');
}

async function toggleCommitExpand(hash) {
  const el = document.getElementById('cf-' + hash);
  if (!el) return;
  const isOpen = el.classList.toggle('open');
  const commit = el.previousElementSibling;
  if (commit) {
    const arrow = commit.querySelector('.gh-commit-expand');
    if (arrow) arrow.classList.toggle('open');
  }
  // Lazy-load commit files on first expand
  if (isOpen && !el.dataset.loaded) {
    const proj = state.projects.find(p => p.id === state.activeProjectId);
    if (proj) {
      try {
        const files = await api('GET', `/api/projects/${proj.id}/git/commit-files?hash=${hash}`);
        const c = proj.gitLog.commits.find(c => c.hash === hash || c.fullHash === hash);
        if (c) c.files = files;
        el.innerHTML = renderCommitFiles({ files });
        el.dataset.loaded = '1';
      } catch {}
    }
  }
}

function selectCommit(hash) {
  document.querySelectorAll('.gh-commit.selected').forEach(el => el.classList.remove('selected'));
  const el = document.querySelector(`.gh-commit[onclick*="${hash}"]`);
  if (el) el.classList.add('selected');
  toggleCommitExpand(hash);
}

function copyHash(hash) {
  navigator.clipboard?.writeText(hash);
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  showToast(proj?.name || '', `Copied ${hash}`, 'info');
}

// ═══════════════════════════════════════════════════════
// GIT ACTIONS
// ═══════════════════════════════════════════════════════
async function switchGitBranch(branch) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/checkout`, { branch });
    proj.gitLog.currentBranch = branch;
    await refreshGitData(proj);
    showToast(proj.name, `Switched to ${branch}`, 'info');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function createBranch() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const name = prompt('New branch name:');
  if (!name?.trim()) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/branch`, { name: name.trim() });
    await refreshGitData(proj);
    showToast(proj.name, `Created ${name.trim()}`, 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function fetchRemote() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/fetch`);
    await refreshGitData(proj);
    showToast(proj.name, 'Fetched from remotes', 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function gitCommit() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const message = prompt('Commit message:');
  if (!message?.trim()) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/commit`, { message: message.trim() });
    await refreshGitData(proj);
    showToast(proj.name, 'Committed', 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function gitPush() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/push`);
    showToast(proj.name, 'Pushed to remote', 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function gitRevertAll() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  if (!confirm('Revert ALL changes? This cannot be undone.')) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/revert`, {});
    await refreshGitData(proj);
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, 'Reverted all changes', 'info');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function gitStashAll() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/stash`);
    await refreshGitData(proj);
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, 'Stashed changes', 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function applyStash(id) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/stash/apply`, { id });
    await refreshGitData(proj);
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, `Applied ${id}`, 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function dropStash(id) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/stash/drop`, { id });
    await refreshGitData(proj);
    showToast(proj.name, `Dropped ${id}`, 'info');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function refreshGitData(proj) {
  try {
    const [status, branches, stashes, log] = await Promise.all([
      api('GET', `/api/projects/${proj.id}/git/status`),
      api('GET', `/api/projects/${proj.id}/git/branches`),
      api('GET', `/api/projects/${proj.id}/git/stash`),
      api('GET', `/api/projects/${proj.id}/git/log`).catch(() => []),
    ]);
    proj.gitChanges = status;
    proj.gitLog.branches = branches.branches;
    proj.gitLog.currentBranch = branches.currentBranch;
    proj.stashes = stashes;
    proj.gitLog.commits = log.map((c, i) => ({
      ...c,
      refs: i === 0 ? [{ type: 'head', label: 'HEAD' }, { type: 'branch', label: branches.currentBranch }] : [],
    }));
  } catch {}
  renderFileTree(proj);
  renderGitHistory(proj);
}

// ═══════════════════════════════════════════════════════
// REMOTE MANAGER
// ═══════════════════════════════════════════════════════
function openRemoteManager() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj || !proj.gitLog) return;

  const container = document.getElementById('modal-container');
  container.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="width:460px">
        <div class="modal-title">Git Remotes</div>
        <div class="remote-list" id="remote-list"></div>
        <hr class="remote-sep">
        <div class="remote-add-form">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Add Remote</div>
          <div class="remote-add-row">
            <input type="text" id="remote-new-name" placeholder="name" style="font-family:var(--font-mono)">
            <input type="text" id="remote-new-url" placeholder="https://github.com/user/repo.git" style="font-family:var(--font-mono)">
          </div>
          <div style="display:flex;justify-content:flex-end">
            <button class="modal-btn confirm" onclick="addRemote()" style="padding:5px 14px;font-size:11px">Add</button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn cancel" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>`;
  renderRemoteList();
}

function renderRemoteList() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj || !proj.gitLog) return;
  const list = document.getElementById('remote-list');
  if (!list) return;
  const remotes = proj.gitLog.remotes || [];
  if (remotes.length === 0) {
    list.innerHTML = '<div class="remote-empty">No remotes configured</div>';
    return;
  }
  list.innerHTML = remotes.map((r, i) => {
    const icon = r.type === 'ssh' ? '🔑' : '🌐';
    return `<div class="remote-item">
      <span class="remote-item-icon">${icon}</span>
      <div class="remote-item-info">
        <div class="remote-item-name">${r.name}</div>
        <div class="remote-item-url">${r.url}</div>
      </div>
      <div class="remote-item-actions">
        <button class="remote-action-btn" onclick="editRemote('${r.name}')" title="Edit URL">✎</button>
        <button class="remote-action-btn delete" onclick="removeRemote('${r.name}')" title="Remove">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function addRemote() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const name = document.getElementById('remote-new-name').value.trim();
  const url = document.getElementById('remote-new-url').value.trim();
  if (!name || !url) { showToast(proj.name, 'Name and URL required', 'attention'); return; }
  try {
    await api('POST', `/api/projects/${proj.id}/git/remotes`, { name, url });
    proj.gitLog.remotes = await api('GET', `/api/projects/${proj.id}/git/remotes`);
    document.getElementById('remote-new-name').value = '';
    document.getElementById('remote-new-url').value = '';
    renderRemoteList();
    showToast(proj.name, `Added remote "${name}"`, 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function removeRemote(name) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('DELETE', `/api/projects/${proj.id}/git/remotes/${name}`);
    proj.gitLog.remotes = await api('GET', `/api/projects/${proj.id}/git/remotes`);
    renderRemoteList();
    showToast(proj.name, `Removed "${name}"`, 'info');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function editRemote(name) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const remote = (proj.gitLog.remotes || []).find(r => r.name === name);
  if (!remote) return;
  const newUrl = prompt(`Edit URL for "${name}":`, remote.url);
  if (!newUrl?.trim()) return;
  try {
    await api('PUT', `/api/projects/${proj.id}/git/remotes/${name}`, { url: newUrl.trim() });
    proj.gitLog.remotes = await api('GET', `/api/projects/${proj.id}/git/remotes`);
    renderRemoteList();
    showToast(proj.name, `Updated "${name}"`, 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

// ═══════════════════════════════════════════════════════
// COMMIT CONTEXT MENU
// ═══════════════════════════════════════════════════════
function showCommitCtxMenu(e, hash) {
  e.preventDefault();
  e.stopPropagation();
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = `
    <div class="ctx-item" onclick="showCommitInfoModal('${hash}')"><span class="ctx-icon">◉</span><span class="ctx-label">View Details</span></div>
    <div class="ctx-item" onclick="copyHash('${hash}')"><span class="ctx-icon">⊡</span><span class="ctx-label">Copy Hash</span></div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="hideCtxMenu();switchGitBranch('${hash}')"><span class="ctx-icon">⑂</span><span class="ctx-label">Checkout</span></div>
  `;
  menu.style.display = 'block';
  let x = e.clientX, y = e.clientY;
  if (x + 220 > window.innerWidth) x = window.innerWidth - 228;
  if (y + 200 > window.innerHeight) y = Math.max(8, window.innerHeight - 208);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  setTimeout(() => document.addEventListener('mousedown', function close(ev) {
    if (!menu.contains(ev.target)) { hideCtxMenu(); document.removeEventListener('mousedown', close); }
  }), 0);
}

function showCommitInfoModal(hash) {
  hideCtxMenu();
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj || !proj.gitLog) return;
  const commit = proj.gitLog.commits.find(c => c.hash === hash);
  if (!commit) return;

  const statusMap = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
  const filesHtml = (commit.files || []).map(f => {
    const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/') + 1) : '';
    const name = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
    return `<div class="gh-file-item" onclick="closeModal();openFileInEditor('${esc(f.path)}')">
      <span class="gh-file-status ${statusMap[f.status] || ''}">${f.status}</span>
      <span class="gh-file-path">${dir ? '<span class="gh-file-path-dir">' + dir + '</span>' : ''}${name}</span>
    </div>`;
  }).join('');

  const refsHtml = (commit.refs || []).map(r => {
    let cls = 'gh-ref-badge ';
    if (r.type === 'head') cls += 'head-badge';
    else if (r.type === 'branch') cls += 'branch-badge';
    return `<span class="${cls}">${r.label}</span>`;
  }).join(' ') || '—';

  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="width:520px">
        <div class="modal-title" style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--accent-cyan);font-family:var(--font-mono)">${commit.hash}</span>
        </div>
        <div class="commit-info-msg">${escHtml(commit.fullMessage || commit.msg).replace(/\n/g, '<br>')}</div>
        <div class="commit-info-grid">
          <span class="commit-info-label">Author</span><span class="commit-info-value">${commit.author}</span>
          <span class="commit-info-label">Date</span><span class="commit-info-value">${commit.date}</span>
          <span class="commit-info-label">Refs</span><span class="commit-info-value">${refsHtml}</span>
        </div>
        ${filesHtml ? `<div class="modal-label" style="margin-bottom:6px">Changed Files</div><div class="commit-info-file-list">${filesHtml}</div>` : ''}
        <div class="modal-actions"><button class="modal-btn cancel" onclick="closeModal()">Close</button></div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════
// FILE EDITOR
// ═══════════════════════════════════════════════════════
function initMonaco() {
  import('monaco-editor').then(monaco => {
    window.monaco = monaco;
    monaco.editor.defineTheme('vcc-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0a0b0f',
        'editor.lineHighlightBackground': '#1a1b2580',
        'editorLineNumber.foreground': '#3a3d52',
        'editorGutter.background': '#0a0b0f',
        'editor.selectionBackground': '#5b8af53a',
        'editorWidget.background': '#12131a',
        'input.background': '#1a1b25',
      },
    });
    editorState.monacoReady = true;
  }).catch(() => {
    console.warn('Monaco editor failed to load');
  });
}

function getMonacoLang(path) {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.html') || path.endsWith('.astro')) return 'html';
  if (path.endsWith('.css')) return 'css';
  return 'plaintext';
}

function isRenderable(path) {
  return /\.(md|html|astro|png|jpg|jpeg|gif|svg|webp)$/i.test(path);
}

async function openFileInEditor(filePath) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;

  let idx = editorState.openFiles.findIndex(f => f.path === filePath);
  if (idx >= 0) {
    editorState.activeFileIdx = idx;
  } else {
    // Fetch real file content
    const fullPath = proj.path + '/' + filePath;
    try {
      const data = await api('GET', `/api/files?path=${encodeURIComponent(fullPath)}`);
      const gitMap = {};
      (proj.gitChanges || []).forEach(c => { gitMap[c.file] = c.status; });
      const isModified = !!gitMap[filePath];

      editorState.openFiles.push({
        path: filePath,
        fullPath: fullPath,
        content: data.content,
        originalContent: data.content,
        isModified,
        lang: data.lang || getMonacoLang(filePath),
        viewMode: 'source',
      });
      idx = editorState.openFiles.length - 1;
      editorState.activeFileIdx = idx;
    } catch (e) {
      showToast(proj.name, `Failed to open: ${e.message}`, 'attention');
      return;
    }
  }

  const editorArea = document.getElementById('editor-area');
  if (!editorArea.classList.contains('open')) {
    editorArea.classList.add('open');
    editorArea.style.height = '45%';
  }

  renderEditorTabs();
  renderEditorContent();
}

function closeEditorTab(idx, evt) {
  if (evt) evt.stopPropagation();
  editorState.openFiles.splice(idx, 1);
  if (editorState.activeFileIdx >= editorState.openFiles.length) {
    editorState.activeFileIdx = editorState.openFiles.length - 1;
  }
  if (editorState.openFiles.length === 0) {
    editorState.activeFileIdx = -1;
    document.getElementById('editor-area').classList.remove('open');
    document.getElementById('editor-area').style.height = '0';
    disposeEditors();
  }
  renderEditorTabs();
  renderEditorContent();
}

function switchEditorTab(idx) {
  editorState.activeFileIdx = idx;
  renderEditorTabs();
  renderEditorContent();
}

function renderEditorTabs() {
  const tabs = document.getElementById('editor-tabs');
  tabs.innerHTML = editorState.openFiles.map((f, i) => {
    const name = f.path.split('/').pop();
    const icon = getFileIcon(name);
    const isActive = i === editorState.activeFileIdx;
    return `<div class="editor-tab ${isActive ? 'active' : ''}" onclick="switchEditorTab(${i})">
      <span class="editor-tab-icon">${icon}</span>
      <span class="editor-tab-name">${name}</span>
      ${f.isModified ? '<span class="editor-tab-modified"></span>' : ''}
      <span class="editor-tab-close" onclick="closeEditorTab(${i}, event)">×</span>
    </div>`;
  }).join('');
}

function renderEditorContent() {
  if (editorState.activeFileIdx < 0) {
    showEditorEmpty();
    return;
  }
  const file = editorState.openFiles[editorState.activeFileIdx];
  document.getElementById('editor-toolbar').style.display = '';
  document.getElementById('editor-filepath').textContent = file.path;

  document.getElementById('ev-source').classList.toggle('active', file.viewMode === 'source');
  const diffBtn = document.getElementById('ev-diff');
  diffBtn.classList.toggle('active', file.viewMode === 'diff');
  diffBtn.classList.toggle('disabled', !file.isModified);
  const renderedBtn = document.getElementById('ev-rendered');
  renderedBtn.classList.toggle('active', file.viewMode === 'rendered');
  renderedBtn.classList.toggle('disabled', !isRenderable(file.path));

  const monacoEl = document.getElementById('monaco-container');
  const diffEl = document.getElementById('monaco-diff-container');
  const renderedEl = document.getElementById('editor-rendered');
  const emptyEl = document.getElementById('editor-empty');
  monacoEl.style.display = 'none';
  diffEl.style.display = 'none';
  renderedEl.style.display = 'none';
  emptyEl.style.display = 'none';

  if (file.viewMode === 'diff' && file.isModified) {
    diffEl.style.display = '';
    showDiffEditor(file);
  } else if (file.viewMode === 'rendered' && isRenderable(file.path)) {
    renderedEl.style.display = '';
    showRenderedView(file);
  } else {
    monacoEl.style.display = '';
    showSourceEditor(file);
  }
}

function showEditorEmpty() {
  document.getElementById('monaco-container').style.display = 'none';
  document.getElementById('monaco-diff-container').style.display = 'none';
  document.getElementById('editor-rendered').style.display = 'none';
  document.getElementById('editor-empty').style.display = 'flex';
  document.getElementById('editor-toolbar').style.display = 'none';
  disposeEditors();
}

function showSourceEditor(file) {
  if (!editorState.monacoReady || !window.monaco) {
    document.getElementById('monaco-container').innerHTML = `<pre style="padding:12px;font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);white-space:pre-wrap;overflow:auto;height:100%">${escHtml(file.content)}</pre>`;
    return;
  }
  if (editorState.monacoDiffEditor) { editorState.monacoDiffEditor.dispose(); editorState.monacoDiffEditor = null; }
  const container = document.getElementById('monaco-container');
  if (editorState.monacoEditor) {
    editorState.monacoEditor.setModel(monaco.editor.createModel(file.content, file.lang));
  } else {
    editorState.monacoEditor = monaco.editor.create(container, {
      value: file.content, language: file.lang, theme: 'vcc-dark',
      fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
      minimap: { enabled: true, scale: 1 }, lineNumbers: 'on',
      renderLineHighlight: 'all', scrollBeyondLastLine: false,
      automaticLayout: true, padding: { top: 8 },
    });
  }
}

function showDiffEditor(file) {
  if (!editorState.monacoReady || !window.monaco) return;
  if (editorState.monacoEditor) { editorState.monacoEditor.dispose(); editorState.monacoEditor = null; }
  const container = document.getElementById('monaco-diff-container');
  if (editorState.monacoDiffEditor) { editorState.monacoDiffEditor.dispose(); }
  editorState.monacoDiffEditor = monaco.editor.createDiffEditor(container, {
    theme: 'vcc-dark', fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
    renderSideBySide: true, automaticLayout: true, readOnly: true,
    scrollBeyondLastLine: false, padding: { top: 8 },
  });
  editorState.monacoDiffEditor.setModel({
    original: monaco.editor.createModel(file.originalContent, file.lang),
    modified: monaco.editor.createModel(file.content, file.lang),
  });
}

function showRenderedView(file) {
  const el = document.getElementById('editor-rendered');
  const ext = file.path.split('.').pop().toLowerCase();
  if (ext === 'md') {
    let html = file.content
      .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- (.+)$/gm, '<li>$1</li>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
    el.innerHTML = `<div class="md-preview"><p>${html}</p></div>`;
  } else if (ext === 'html' || ext === 'astro') {
    el.innerHTML = `<iframe class="html-frame" srcdoc="${file.content.replace(/"/g, '&quot;')}" sandbox></iframe>`;
  } else {
    el.innerHTML = `<pre style="padding:16px;white-space:pre-wrap;font-family:var(--font-mono);font-size:12px">${escHtml(file.content)}</pre>`;
  }
}

function setEditorView(mode) {
  if (editorState.activeFileIdx < 0) return;
  const file = editorState.openFiles[editorState.activeFileIdx];
  if (mode === 'diff' && !file.isModified) return;
  if (mode === 'rendered' && !isRenderable(file.path)) return;
  file.viewMode = mode;
  renderEditorContent();
}

function disposeEditors() {
  if (editorState.monacoEditor) { editorState.monacoEditor.dispose(); editorState.monacoEditor = null; }
  if (editorState.monacoDiffEditor) { editorState.monacoDiffEditor.dispose(); editorState.monacoDiffEditor = null; }
}

// ═══════════════════════════════════════════════════════
// CENTER TABS & CONTENT
// ═══════════════════════════════════════════════════════
function renderCenterTabs(proj) {
  const tabs = document.getElementById('center-tabs');
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');

  let html = activeSessions.map((s, i) => {
    const isActive = state.activeTabType === 'session' && i === (proj.activeSessionIdx || 0);
    const warn = s.permissionMode === 'bypassPermissions' ? '<span class="tab-warn" title="--dangerously-skip-permissions">⚠</span>' : '';
    return `<div class="center-tab ${isActive ? 'active' : ''}" onclick="switchToSession('${proj.id}', ${i})">
      <span class="tab-dot ${s.status}"></span>
      <span>${s.title && s.title.length > 10 ? s.title.substring(0, 10) + '…' : (s.title || 'New session')}</span>${warn}
      <span class="tab-close" onclick="event.stopPropagation()">×</span>
    </div>`;
  }).join('');

  html += `<button class="center-tab-add" onclick="newSession()" title="New Claude session">+ <span class="add-label">Session</span></button>`;

  // Terminal tabs
  const terminals = proj.terminals || [];
  if (terminals.length > 0) html += `<div class="center-tab-sep"></div>`;
  html += terminals.map((t, i) => {
    const isActive = state.activeTabType === 'terminal' && i === (proj.activeTerminalIdx || 0);
    return `<div class="center-tab terminal-type ${isActive ? 'active' : ''}" onclick="switchToTerminal('${proj.id}', ${i})">
      <span class="tab-term-icon">›_</span>
      <span>${t.name || 'bash'}</span>
      <span class="tab-close" onclick="event.stopPropagation()">×</span>
    </div>`;
  }).join('');
  html += `<button class="center-tab-add" onclick="addTerminal()" title="New terminal">+ <span class="add-label">Term</span></button>`;

  tabs.innerHTML = html;
}

function renderCenterContent(proj) {
  const chatArea = document.getElementById('chat-area');
  const chatInputBar = document.getElementById('chat-input-bar');
  const chatStatusBar = document.getElementById('chat-status-bar');
  const termOutput = document.getElementById('terminal-output');
  const tuiView = document.getElementById('tui-view');
  const tuiInputBar = document.getElementById('tui-input-bar');
  const viewToggle = document.getElementById('session-view-toggle');

  chatArea.classList.add('hidden');
  chatInputBar.classList.add('hidden');
  chatStatusBar.classList.add('hidden');
  termOutput.classList.add('hidden');
  tuiView.classList.add('hidden');
  tuiInputBar.classList.add('hidden');
  viewToggle.classList.add('hidden');

  if (state.activeTabType === 'terminal') {
    termOutput.classList.remove('hidden');
    const terminals = proj.terminals || [];
    const termInfo = terminals[proj.activeTerminalIdx || 0];
    if (termInfo && termInfo.shellId) {
      attachXterm(termInfo.id, termInfo.shellId, termOutput, 'shell');
    } else if (termInfo && termInfo.sessionId) {
      attachXterm(termInfo.id, termInfo.sessionId, termOutput, 'terminal');
    } else {
      termOutput.innerHTML = '';
    }
    return;
  }

  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) {
    chatArea.classList.remove('hidden');
    chatArea.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◉</div><div class="empty-state-title">No active session</div><div class="empty-state-desc">Start a new Claude Code session</div></div>';
    return;
  }

  if (!session.viewMode) session.viewMode = 'chat';
  if (session.showVerbose === undefined) session.showVerbose = true;

  viewToggle.classList.remove('hidden');
  document.getElementById('svt-chat').classList.toggle('active', session.viewMode === 'chat');
  document.getElementById('svt-tui').classList.toggle('active', session.viewMode === 'tui');
  document.getElementById('svt-verbose').classList.toggle('active', session.showVerbose);

  if (session.viewMode === 'tui') {
    tuiView.classList.remove('hidden');
    // Show real Claude Code TUI via xterm.js connected to PTY
    const tuiTermId = `tui-${session.id}`;
    attachXterm(tuiTermId, session.id, tuiView);
  } else {
    chatArea.classList.remove('hidden');
    chatInputBar.classList.remove('hidden');
    chatStatusBar.classList.remove('hidden');
    renderChat(proj);
    updateChatStatusBar(session);
  }
}

// ═══════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════
function filterMessages(messages, showVerbose) {
  if (showVerbose) return messages.map((m, i) => ({ ...m, _idx: i, _collapsed: false }));
  const result = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'user') { result.push({ ...m, _idx: i, _collapsed: false }); i++; continue; }
    const blockStart = i;
    let lastAssistantIdx = -1, toolCount = 0, intermediateCount = 0;
    while (i < messages.length && messages[i].role !== 'user') {
      if (messages[i].role === 'tool') toolCount++;
      if (messages[i].role === 'assistant') lastAssistantIdx = i;
      i++;
    }
    for (let j = blockStart; j < i; j++) { if (j !== lastAssistantIdx) intermediateCount++; }
    if (intermediateCount > 0) {
      result.push({ role: '_collapsed', toolCount, intermediateCount, _idx: blockStart, _collapsed: true });
    }
    if (lastAssistantIdx >= 0) {
      result.push({ ...messages[lastAssistantIdx], _idx: lastAssistantIdx, _collapsed: false });
    }
  }
  return result;
}

function renderChat(proj) {
  const area = document.getElementById('chat-area');
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) {
    area.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◉</div><div class="empty-state-title">No active session</div></div>';
    return;
  }
  const showVerbose = session.showVerbose !== false;
  const filtered = filterMessages(session.messages, showVerbose);

  // Store filtered messages for raw inspection
  session._filteredMessages = filtered;

  area.innerHTML = filtered.map((m, fi) => {
    const rawBtn = m._rawEvent ? `<span class="chat-raw-btn" onclick="showRawEvent(${fi})" title="Show raw event JSON">raw</span>` : '';
    if (m.role === '_collapsed') {
      return `<div class="chat-collapsed-indicator" onclick="expandCollapsed()">
        <span>⋯</span>
        <span class="chat-collapsed-count">${m.toolCount > 0 ? m.toolCount + ' tool call' + (m.toolCount > 1 ? 's' : '') : ''}</span>
        <span style="font-size:10px">click to show</span>
      </div>`;
    }
    if (m.role === 'tool') {
      return `<div class="chat-tool-use"><span class="tool-icon">⚡</span>${escHtml(m.content)}${rawBtn}</div>`;
    }
    if (m.role === 'control_request') {
      return renderControlRequest(m, session);
    }
    const isUser = m.role === 'user';
    const attachHtml = (m._attachments && m._attachments.length)
      ? m._attachments.map(a => `<img class="chat-attachment-img" src="data:${a.media_type};base64,${a.data}" alt="attachment">`).join('')
      : '';
    let bubbleContent;
    if (isUser) {
      bubbleContent = escHtml(m.content);
    } else {
      const uuid = m._eventUuid || '';
      const mode = mdToggleState[uuid] || 'md';
      const toolbar = `<span class="chat-bubble-toolbar"><span class="chat-bubble-btn" onclick="event.stopPropagation(); copyBubble(this)" title="Copy">${svgCopy}</span><span class="chat-bubble-btn" onclick="event.stopPropagation(); toggleMd('${esc(uuid)}')" title="Toggle view mode">${mode}</span></span>`;
      const rawAttr = `data-raw-md="${escAttr(m.content)}"`;
      if (mode === 'txt') {
        bubbleContent = `${toolbar}<div class="chat-text-raw" ${rawAttr}>${escHtml(m.content)}</div>`;
      } else if (mode === 'raw') {
        const rawJson = m._rawEvent ? JSON.stringify(m._rawEvent, null, 2) : m.content;
        bubbleContent = `${toolbar}<div class="chat-text-raw" ${rawAttr}>${escHtml(rawJson)}</div>`;
      } else {
        bubbleContent = `${toolbar}<div class="md-content" ${rawAttr}>${renderMd(m.content)}</div>`;
      }
    }
    return `<div class="chat-msg ${m.role}">
      <div class="chat-avatar ${isUser ? 'you' : 'claude'}">${isUser ? 'Y' : 'C'}</div>
      <div class="chat-bubble">${attachHtml}${bubbleContent}</div>
    </div>`;
  }).join('');

  if (session.status === 'waiting') {
    area.innerHTML += `<div class="chat-status-line"><span class="waiting-indicator">⏳ Waiting for your input</span></div>`;
  } else if (session.status === 'running') {
    area.innerHTML += `<div class="chat-status-line" style="color: var(--accent-green)">● Claude is working...</div>`;
  }
  area.scrollTop = area.scrollHeight;
}

// Track question answers per event uuid
const questionAnswers = {};

function renderControlRequest(m, session) {
  const req = m.content;
  const toolName = req?.tool_name || req?.request?.tool_name || req?.name || '';
  const input = req?.input || req?.request?.input || {};
  const isResponded = m._responded;

  // AskUserQuestion — show radio button options
  if (toolName === 'AskUserQuestion') {
    return renderUserQuestion(m, session, input, isResponded);
  }

  // Already responded tool approval — show nothing
  if (isResponded) {
    return '';
  }

  // Tool approval — show formatted tool info + Allow/Deny
  return renderToolApproval(m, session, toolName, input);
}

function renderUserQuestion(m, session, input, isResponded) {
  const questions = input.questions || [];
  const uuid = m._eventUuid || '';

  if (isResponded) {
    const saved = questionAnswers[uuid];
    return `<div class="chat-question-answered">${questions.map(q => {
      const header = q.header || 'Q';
      const answer = saved?.[q.question] || 'Answered';
      return `<span><span class="chat-question-answered-header">${escHtml(header)}: </span><span class="chat-question-answered-value">${escHtml(answer)}</span></span>`;
    }).join('')}</div>`;
  }

  // Init answer state for this question
  if (!questionAnswers[uuid]) questionAnswers[uuid] = {};

  let html = '<div class="chat-question-panel">';
  questions.forEach((q, qi) => {
    const qKey = q.question;
    if (q.header) {
      html += `<div class="chat-question-header">${escHtml(q.header)}</div>`;
    }
    html += `<div class="chat-question-text">${escHtml(q.question)}</div>`;
    html += '<div class="chat-question-options">';

    (q.options || []).forEach((opt, oi) => {
      const selected = questionAnswers[uuid]?.[qKey] === opt.label && !questionAnswers[uuid]?.['_custom_' + qKey];
      html += `<div class="chat-question-option ${selected ? 'selected' : ''}" onclick="selectQuestionOption('${uuid}','${escAttr(qKey)}','${escAttr(opt.label)}','${session.id}')">
        <div class="chat-question-radio"><div class="chat-question-radio-inner"></div></div>
        <div>
          <div class="chat-question-option-label">${escHtml(opt.label)}</div>
          ${opt.description ? `<div class="chat-question-option-desc">${escHtml(opt.description)}</div>` : ''}
        </div>
      </div>`;
    });

    // "Other" option
    const isCustom = !!questionAnswers[uuid]?.['_custom_' + qKey];
    const customText = questionAnswers[uuid]?.['_customText_' + qKey] || '';
    html += `<div class="chat-question-option ${isCustom ? 'selected' : ''}" onclick="selectQuestionCustom('${uuid}','${escAttr(qKey)}','${session.id}')">
      <div style="display:flex;align-items:center;gap:10px;width:100%">
        <div class="chat-question-radio"><div class="chat-question-radio-inner"></div></div>
        <div class="chat-question-option-label">Other</div>
      </div>
      ${isCustom ? `<input type="text" class="chat-question-custom-input" placeholder="Type your answer..." value="${escAttr(customText)}" onclick="event.stopPropagation()" oninput="updateQuestionCustom('${uuid}','${escAttr(qKey)}',this.value,'${session.id}')" autofocus>` : ''}
    </div>`;

    html += '</div>';
  });

  const allAnswered = questions.every(q => questionAnswers[uuid]?.[q.question]);
  html += `<div class="chat-question-buttons">
    <button class="chat-question-submit" ${allAnswered ? '' : 'disabled'} onclick="submitQuestion('${uuid}','${session.id}')">Submit</button>
    <button class="chat-question-skip" onclick="skipQuestion('${uuid}','${session.id}')">Skip</button>
  </div>`;
  html += '</div>';
  return html;
}

function renderToolApproval(m, session, toolName, input) {
  const isBash = toolName === 'Bash';
  let html = '<div class="chat-tool-approval">';
  html += `<div class="chat-tool-approval-header">
    <span class="chat-tool-approval-icon">${isBash ? '>' : '\u26A0'}</span>
    <span class="chat-tool-approval-name">${escHtml(toolName || 'Tool')}</span>
  </div>`;

  if (isBash) {
    const command = input.command || '';
    const description = input.description || '';
    const timeout = input.timeout;
    const bgFlag = input.run_in_background;
    if (description) {
      html += `<div class="chat-tool-approval-desc">${escHtml(description)}</div>`;
    }
    html += `<div class="chat-tool-approval-command"><span class="chat-tool-approval-prompt">$ </span>${escHtml(command)}</div>`;
    if (timeout || bgFlag) {
      html += '<div class="chat-tool-approval-meta">';
      if (bgFlag) html += '<span class="chat-tool-approval-tag">background</span>';
      if (timeout) html += `<span class="chat-tool-approval-tag">timeout: ${timeout}ms</span>`;
      html += '</div>';
    }
  } else {
    // Generic tool — show primary fields prominently
    const primaryFields = {
      Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'],
      Glob: ['pattern', 'path'], Grep: ['pattern', 'path'],
      WebFetch: ['url'], WebSearch: ['query'],
    };
    const primaries = primaryFields[toolName] || [];
    const primaryEntries = [];
    const otherEntries = [];
    for (const [k, v] of Object.entries(input || {})) {
      if (primaries.includes(k)) primaryEntries.push([k, v]);
      else otherEntries.push([k, v]);
    }

    if (primaryEntries.length > 0) {
      for (const [k, v] of primaryEntries) {
        html += `<div class="chat-tool-approval-field"><span class="chat-tool-approval-field-label">${escHtml(k)}: </span><span class="chat-tool-approval-field-value">${escHtml(String(v))}</span></div>`;
      }
      if (otherEntries.length > 0) {
        html += `<details class="chat-tool-approval-other-params"><summary>${otherEntries.length} more param${otherEntries.length !== 1 ? 's' : ''}</summary><pre>${escHtml(JSON.stringify(Object.fromEntries(otherEntries), null, 2))}</pre></details>`;
      }
    } else {
      html += `<pre class="chat-tool-approval-command" style="white-space:pre-wrap">${escHtml(JSON.stringify(input, null, 2))}</pre>`;
    }
  }

  html += `<div class="chat-tool-approval-buttons">
    <button class="chat-tool-approval-allow" onclick="approveControl('${session.id}')">Allow</button>
    <button class="chat-tool-approval-deny" onclick="denyControl('${session.id}')">Deny</button>
  </div>`;
  html += '</div>';
  return html;
}

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function selectQuestionOption(uuid, question, label, sessionId) {
  if (!questionAnswers[uuid]) questionAnswers[uuid] = {};
  questionAnswers[uuid][question] = label;
  delete questionAnswers[uuid]['_custom_' + question];
  rerenderChat();
}

function selectQuestionCustom(uuid, question, sessionId) {
  if (!questionAnswers[uuid]) questionAnswers[uuid] = {};
  questionAnswers[uuid]['_custom_' + question] = true;
  questionAnswers[uuid][question] = questionAnswers[uuid]['_customText_' + question] || '';
  rerenderChat();
}

function updateQuestionCustom(uuid, question, value, sessionId) {
  if (!questionAnswers[uuid]) questionAnswers[uuid] = {};
  questionAnswers[uuid]['_customText_' + question] = value;
  questionAnswers[uuid][question] = value;
}

async function submitQuestion(uuid, sessionId) {
  const answers = questionAnswers[uuid] || {};
  // Build clean answers (strip internal keys)
  const cleanAnswers = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!k.startsWith('_custom')) cleanAnswers[k] = v;
  }
  // Find the message and mark as responded
  markControlResponded(sessionId, uuid);
  // Find the requestId from the message
  let requestId;
  for (const proj of state.projects) {
    const sess = proj.sessions.find(s => s.id === sessionId);
    if (sess) {
      const msg = sess.messages.find(m => m._eventUuid === uuid);
      if (msg) requestId = msg._requestId;
    }
  }
  if (requestId && sendAgentCommand(sessionId, { action: 'answer_question', requestId, answers: cleanAnswers })) {
    // Sent via agent WS
  } else {
    try {
      await api('POST', `/api/sessions/${sessionId}/control-response`, {
        permission: 'allow',
        updatedInput: { answers: cleanAnswers },
      });
    } catch {}
  }
  rerenderChat();
}

async function skipQuestion(uuid, sessionId) {
  questionAnswers[uuid] = questionAnswers[uuid] || {};
  markControlResponded(sessionId, uuid);
  // Find the requestId from the message
  let requestId;
  for (const proj of state.projects) {
    const sess = proj.sessions.find(s => s.id === sessionId);
    if (sess) {
      const msg = sess.messages.find(m => m._eventUuid === uuid);
      if (msg) requestId = msg._requestId;
    }
  }
  if (requestId && sendAgentCommand(sessionId, { action: 'deny', requestId })) {
    // Sent via agent WS
  } else {
    try {
      await api('POST', `/api/sessions/${sessionId}/control-response`, {
        permission: 'deny',
      });
    } catch {}
  }
  rerenderChat();
}

async function approveControl(sessionId) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  let requestId;
  if (proj) {
    const sess = proj.sessions.find(s => s.id === sessionId);
    if (sess) {
      const lastCtrl = [...sess.messages].reverse().find(m => m.role === 'control_request' && !m._responded);
      if (lastCtrl) {
        lastCtrl._responded = true;
        requestId = lastCtrl._requestId;
      }
    }
  }
  if (requestId && sendAgentCommand(sessionId, { action: 'approve', requestId })) {
    // Sent via agent WS
  } else {
    try {
      await api('POST', `/api/sessions/${sessionId}/control-response`, {
        permission: 'allow',
      });
    } catch {}
  }
  rerenderChat();
}

async function denyControl(sessionId) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  let requestId;
  if (proj) {
    const sess = proj.sessions.find(s => s.id === sessionId);
    if (sess) {
      const lastCtrl = [...sess.messages].reverse().find(m => m.role === 'control_request' && !m._responded);
      if (lastCtrl) {
        lastCtrl._responded = true;
        requestId = lastCtrl._requestId;
      }
    }
  }
  if (requestId && sendAgentCommand(sessionId, { action: 'deny', requestId })) {
    // Sent via agent WS
  } else {
    try {
      await api('POST', `/api/sessions/${sessionId}/control-response`, {
        permission: 'deny',
      });
    } catch {}
  }
  rerenderChat();
}

function markControlResponded(sessionId, uuid) {
  for (const proj of state.projects) {
    const sess = proj.sessions.find(s => s.id === sessionId);
    if (sess) {
      const msg = sess.messages.find(m => m._eventUuid === uuid && m.role === 'control_request');
      if (msg) msg._responded = true;
    }
  }
}

function rerenderChat() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (proj) renderChat(proj);
}

function showRawEvent(filteredIdx) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session || !session._filteredMessages) return;
  const m = session._filteredMessages[filteredIdx];
  if (!m?._rawEvent) return;
  const json = JSON.stringify(m._rawEvent, null, 2);
  console.log('[raw event]', m._rawEvent);
  // Show in a modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="modal" style="max-width:700px;max-height:80vh;overflow:auto">
    <div class="modal-header"><span>Raw Event</span><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
    <pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;padding:12px;margin:0;max-height:60vh;overflow:auto">${escHtml(json)}</pre>
  </div>`;
  document.body.appendChild(overlay);
}

function expandCollapsed() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) return;
  session.showVerbose = true;
  renderCenterContent(proj);
}

function setSessionView(mode) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) return;
  session.viewMode = mode;
  renderCenterContent(proj);
}

function toggleVerbose() {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) return;
  session.showVerbose = !session.showVerbose;
  renderCenterContent(proj);
}

function setChatInputsDisabled(disabled) {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const attachBtn = document.querySelector('.chat-attach-btn');
  const modeSelect = document.getElementById('cs-mode');
  const modelSelect = document.getElementById('cs-model');

  if (input) {
    input.disabled = !!disabled;
    if (disabled) {
      input.placeholder = 'Refreshing context...';
    } else {
      input.placeholder = 'Message Claude...';
    }
  }
  if (sendBtn) sendBtn.disabled = !!disabled;
  if (attachBtn) attachBtn.disabled = !!disabled;
  if (modeSelect) modeSelect.disabled = !!disabled;
  if (modelSelect) modelSelect.disabled = !!disabled;
}

function updateChatStatusBar(session) {
  if (!session) return;
  document.getElementById('cs-mode').value = session.permissionMode || 'default';
  const model = session.model || session.contextUsage?.model || 'claude-sonnet-4-6';
  document.getElementById('cs-model').value = model;
  updateTokenBar(session);
  setChatInputsDisabled(!!session.contextInProgress);
}

function updateTokenBar(session) {
  if (!session) return;
  const u = session.contextUsage;
  const textEl = document.getElementById('cs-token-text');
  const fillEl = document.getElementById('cs-token-fill');
  if (!textEl || !fillEl) return;
  if (!u) {
    textEl.textContent = 'Token usage: —';
    fillEl.style.width = '0%';
    return;
  }
  const usedK = u.usedTokens >= 1000 ? (u.usedTokens / 1000).toFixed(u.usedTokens >= 10000 ? 0 : 1) + 'k' : u.usedTokens;
  const totalK = u.totalTokens >= 1000 ? (u.totalTokens / 1000).toFixed(0) + 'k' : u.totalTokens;
  const free = u.freePercent != null ? u.freePercent : (100 - u.percent);
  textEl.textContent = `${u.model} · ${usedK}/${totalK} tokens (${u.percent}%) · Free: ${free.toFixed(1)}%`;
  // Fill bar shows used percentage
  const used = 100 - free;
  fillEl.style.width = used + '%';
  // Color based on free space: green > 50%, yellow 20-50%, red < 20%
  fillEl.style.background = free < 20 ? 'var(--accent-red, #e55)' : free < 50 ? 'var(--accent-yellow, #eb5)' : 'var(--accent-green, #5e5)';
}

function updateSessionMode(value) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) return;
  session.permissionMode = value;
  renderCenterTabs(proj);
  if (!sendAgentCommand(session.id, { action: 'set_mode', mode: value })) {
    // Fall back to HTTP
    api('POST', `/api/sessions/${session.id}/set-mode`, { mode: value }).catch(err => {
      console.error('[mode] Failed:', err);
    });
  }
}

function updateSessionModel(value) {
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) return;
  session.model = value;
  if (sendAgentCommand(session.id, { action: 'set_model', model: value })) {
    // Agent handles model change + context refresh
  } else {
    // Fall back to legacy: send set_model control request via session WS
    const ws = sessionWsMap[session.id];
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'control_request',
        request_id: crypto.randomUUID(),
        request: { subtype: 'set_model', model: value },
      }));
    }
    // Refresh context usage after model change so token bar updates
    setTimeout(() => {
      api('POST', `/api/sessions/${session.id}/refresh-context`).catch(() => {});
    }, 1000);
  }
}

// ═══════════════════════════════════════════════════════
// TUI VIEW
// ═══════════════════════════════════════════════════════
function renderTuiView(proj, session) {
  const tui = document.getElementById('tui-view');
  const showVerbose = session.showVerbose !== false;
  let html = `<div class="tui-line" style="color:var(--accent-purple);font-weight:700">╭─ Claude Code ──────────────────────╮</div>`;
  html += `<div class="tui-line" style="color:var(--accent-purple)">│ <span style="color:var(--text-muted)">Session:</span> <span style="color:var(--text-primary)">${session.title}</span></div>`;
  html += `<div class="tui-line" style="color:var(--accent-purple)">│ <span style="color:var(--text-muted)">Project:</span> <span style="color:var(--text-secondary)">${proj.path}</span></div>`;
  html += `<div class="tui-line" style="color:var(--accent-purple)">╰────────────────────────────────────╯</div><div class="tui-line">&nbsp;</div>`;

  const filtered = filterMessages(session.messages, showVerbose);
  filtered.forEach(m => {
    if (m.role === '_collapsed') {
      html += `<div class="tui-collapsed" onclick="expandCollapsed()">  ⋯ ${m.toolCount} tool calls (click to expand)</div>`;
    } else if (m.role === 'user') {
      html += `<div class="tui-line"><span class="tui-prompt">❯ </span><span class="tui-prompt-text">${escHtml(m.content)}</span></div><div class="tui-line">&nbsp;</div>`;
    } else if (m.role === 'tool') {
      html += `<div class="tui-tool"><span class="tui-tool-icon">✓</span> ${escHtml(m.content)}</div>`;
    } else if (m.role === 'assistant') {
      html += `<div class="tui-response">${escHtml(m.content)}</div><div class="tui-line">&nbsp;</div>`;
    }
  });

  if (session.status === 'waiting') html += `<div class="tui-status waiting">⏳ Awaiting input...</div>`;
  else if (session.status === 'running') html += `<div class="tui-status running">● Processing...</div>`;

  tui.innerHTML = html;
  tui.scrollTop = tui.scrollHeight;
}

// ═══════════════════════════════════════════════════════
// SEND MESSAGE
// ═══════════════════════════════════════════════════════
function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey) { e.preventDefault(); sendMessage(); }
}

function handleTuiKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTuiMessage(); }
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !state.activeProjectId) return;

  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) return;

  const msgUuid = crypto.randomUUID();
  session.status = 'running';
  input.value = '';

  // Collect attachments before clearing
  const attachments = chatAttachments
    .filter(a => a.data)
    .map(a => ({ media_type: a.type, data: a.data, name: a.name }));
  clearAttachments();

  const cmd = { action: 'send_message', text, attachments: attachments.length ? attachments : undefined };

  // Use agent WS if available, otherwise fall back to HTTP
  if (sendAgentCommand(session.id, cmd)) {
    // Agent WS will echo back user_message — no local push needed
  } else {
    session.messages.push({ role: 'user', content: text, _eventUuid: msgUuid });
    try {
      await api('POST', `/api/sessions/${session.id}/message`, {
        message: text, uuid: msgUuid,
        attachments: attachments.length ? attachments : undefined,
      });
    } catch (e) {
      showToast(proj.name, `Failed to send: ${e.message}`, 'attention');
    }
  }

  renderChat(proj);
  renderCenterTabs(proj);
  renderSidebarProjects();
  updateGlobalCounts();
}

async function sendTuiMessage() {
  const input = document.getElementById('tui-input');
  const text = input.value.trim();
  if (!text || !state.activeProjectId) return;
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
  const session = activeSessions[proj.activeSessionIdx || 0];
  if (!session) return;

  const msgUuid = crypto.randomUUID();
  session.messages.push({ role: 'user', content: text, _eventUuid: msgUuid });
  session.status = 'running';
  input.value = '';
  renderTuiView(proj, session);
  renderCenterTabs(proj);

  if (!sendAgentCommand(session.id, { action: 'send_message', text })) {
    try {
      await api('POST', `/api/sessions/${session.id}/message`, { message: text, uuid: msgUuid });
    } catch (e) {
      showToast(proj.name, `Failed: ${e.message}`, 'attention');
    }
  }
}

// ═══════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════
async function newSession() {
  if (!state.activeProjectId) return;
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;

  try {
    // Try agent-sessions endpoint first
    pendingAgentCreation = true;
    const result = await api('POST', '/api/agent-sessions', {
      agentType: 'claude-code',
      cwd: proj.path,
      skipPermissions: true,
    });
    pendingAgentCreation = false;

    const sessionId = result.sessionId;

    // If the statusWs session_created broadcast already added this session, update it
    const existing = proj.sessions.find(s => s.id === sessionId);
    if (existing) {
      existing.permissionMode = result.mode || 'bypassPermissions';
      if (result.model) existing.model = result.model;
      existing._capabilities = result.capabilities;
      connectAgentWs(sessionId);
      updateChatStatusBar(existing);
      return;
    }
    const session = {
      id: sessionId,
      title: 'New session',
      status: 'waiting',
      startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      messages: [],
      lastMessage: '',
      viewMode: 'chat',
      permissionMode: result.mode || 'bypassPermissions',
      model: result.model || null,
      _capabilities: result.capabilities,
    };
    proj.sessions.push(session);
    proj.activeSessionIdx = proj.sessions.filter(s => s.status !== 'ended').length - 1;
    state.activeTabType = 'session';

    connectAgentWs(sessionId);

    renderCenterTabs(proj);
    renderCenterContent(proj);
    renderSessions(proj);
    renderSidebarProjects();
    updateGlobalCounts();
    showToast(proj.name, 'New session created', 'success');
  } catch (e) {
    pendingAgentCreation = false;
    // Fall back to legacy session creation
    try {
      const result = await api('POST', '/api/sessions', { cwd: proj.path, skip_permissions: true });
      const existing = proj.sessions.find(s => s.id === result.id);
      if (existing) {
        existing.permissionMode = result.permission_mode || 'bypassPermissions';
        if (result.model) existing.model = result.model;
        updateChatStatusBar(existing);
        return;
      }
      const session = {
        id: result.id,
        title: result.title || 'New session',
        status: 'waiting',
        startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        messages: [],
        lastMessage: '',
        viewMode: 'chat',
        permissionMode: result.permission_mode || 'bypassPermissions',
        model: result.model || null,
      };
      proj.sessions.push(session);
      proj.activeSessionIdx = proj.sessions.filter(s => s.status !== 'ended').length - 1;
      state.activeTabType = 'session';
      connectSessionWs(session.id);
      renderCenterTabs(proj);
      renderCenterContent(proj);
      renderSessions(proj);
      renderSidebarProjects();
      updateGlobalCounts();
      showToast(proj.name, 'New session created', 'success');
    } catch (e2) {
      showToast(proj.name, `Failed: ${e2.message}`, 'attention');
    }
  }
}

async function resumeSession(projId, sessionId) {
  const proj = state.projects.find(p => p.id === projId);
  if (!proj) return;
  const session = proj.sessions.find(s => s.id === sessionId);
  if (!session) return;

  // If already running/waiting, just switch to it
  if (session.status === 'running' || session.status === 'waiting') {
    const idx = proj.sessions.filter(s => s.status !== 'ended').indexOf(session);
    if (idx >= 0) switchToSession(projId, idx);
    return;
  }

  // Resume idle/ended sessions via agent abstraction layer
  try {
    pendingAgentCreation = true;
    const result = await api('POST', '/api/agent-sessions/resume', {
      sessionUuid: sessionId,
      cwd: proj.path,
      skipPermissions: true,
    });
    pendingAgentCreation = false;

    const newSessionId = result.sessionId;
    const newSession = {
      id: newSessionId,
      title: session.title || 'Resumed session',
      status: 'waiting',
      startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      messages: [],
      lastMessage: '',
      viewMode: 'chat',
      permissionMode: result.mode || 'bypassPermissions',
      model: result.model || null,
      _capabilities: result.capabilities,
    };

    // Replace the old entry or add new one
    const existingIdx = proj.sessions.findIndex(s => s.id === newSessionId);
    if (existingIdx >= 0) {
      Object.assign(proj.sessions[existingIdx], newSession);
    } else {
      proj.sessions.push(newSession);
    }

    proj.activeSessionIdx = proj.sessions.filter(s => s.status !== 'ended').length - 1;
    state.activeTabType = 'session';
    connectAgentWs(newSessionId);

    renderCenterTabs(proj);
    renderCenterContent(proj);
    renderSessions(proj);
    renderSidebarProjects();
    updateGlobalCounts();
    showToast(proj.name, 'Session resumed', 'success');
  } catch (e) {
    pendingAgentCreation = false;
    showToast(proj.name, `Failed to resume: ${e.message}`, 'attention');
  }
}

async function resumeHistoricalSession(projId, sessionUuid) {
  const proj = state.projects.find(p => p.id === projId);
  if (!proj) return;

  try {
    // Resume via agent abstraction layer — no agent type needed
    pendingAgentCreation = true;
    const result = await api('POST', '/api/agent-sessions/resume', {
      sessionUuid,
      cwd: proj.path,
      skipPermissions: true,
    });
    pendingAgentCreation = false;

    const sessionId = result.sessionId;
    const histEntry = (proj.historicalSessions || []).find(h => h.id === sessionUuid);

    // Remove from historical list since it's now active
    if (proj.historicalSessions) {
      proj.historicalSessions = proj.historicalSessions.filter(h => h.id !== sessionUuid);
    }

    const existing = proj.sessions.find(s => s.id === sessionId);
    if (existing) {
      existing.status = 'waiting';
      existing.permissionMode = result.mode || 'bypassPermissions';
      if (result.model) existing.model = result.model;
      existing._capabilities = result.capabilities;
      connectAgentWs(sessionId);
    } else {
      const session = {
        id: sessionId,
        title: histEntry?.title || result.title || 'Resumed session',
        status: 'waiting',
        startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        messages: [],
        lastMessage: '',
        viewMode: 'chat',
        permissionMode: result.mode || 'bypassPermissions',
        model: result.model || null,
        _capabilities: result.capabilities,
      };
      proj.sessions.push(session);
      proj.activeSessionIdx = proj.sessions.filter(s => s.status !== 'ended').length - 1;
      state.activeTabType = 'session';
      connectAgentWs(sessionId);
    }

    renderCenterTabs(proj);
    renderCenterContent(proj);
    renderSessions(proj);
    renderSidebarProjects();
    updateGlobalCounts();
    showToast(proj.name, 'Session resumed', 'success');
  } catch (e) {
    pendingAgentCreation = false;
    showToast(proj.name, `Failed to resume: ${e.message}`, 'attention');
  }
}
window.resumeHistoricalSession = resumeHistoricalSession;

function switchToSession(projId, idx) {
  const proj = state.projects.find(p => p.id === projId);
  if (!proj) return;
  state.activeTabType = 'session';
  proj.activeSessionIdx = idx;
  renderCenterTabs(proj);
  renderCenterContent(proj);
}

function switchToTerminal(projId, idx) {
  const proj = state.projects.find(p => p.id === projId);
  if (!proj) return;
  state.activeTabType = 'terminal';
  proj.activeTerminalIdx = idx;
  renderCenterTabs(proj);
  renderCenterContent(proj);
}

function renderSessions(proj) {
  const list = document.getElementById('session-list');

  // Active/live sessions
  const activeHtml = proj.sessions.map(s =>
    `<div class="session-item ${s.status !== 'ended' ? 'active-session' : ''}">
      <div class="session-status-dot ${s.status === 'ended' ? 'ended' : s.status === 'waiting' ? 'waiting' : s.status === 'running' ? 'live' : 'ended'}"></div>
      <div class="session-info">
        <div class="session-title">${s.title}</div>
        <div class="session-meta"><span>${s.startedAt || ''}</span><span>${s.status}</span></div>
      </div>
      ${s.status === 'ended' || s.status === 'idle' ? `<button class="session-resume-btn" onclick="resumeSession('${proj.id}', '${s.id}')">Resume</button>` : ''}
    </div>`
  ).join('');

  // Historical sessions (from agent factories, already sorted by date desc)
  const historical = proj.historicalSessions || [];
  const historyHtml = historical.length ? `
    <div class="session-history-divider">History</div>
    ${historical.map(h => {
      const d = new Date(h.lastModified);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `<div class="session-item session-historical" onclick="resumeHistoricalSession('${proj.id}', '${h.id}')">
        <div class="session-status-dot ended"></div>
        <div class="session-info">
          <div class="session-title">${escapeHtml(h.title)}</div>
          <div class="session-meta"><span>${dateStr} ${timeStr}</span><span>${h.eventCount} events</span></div>
        </div>
        <button class="session-resume-btn" onclick="event.stopPropagation(); resumeHistoricalSession('${proj.id}', '${h.id}')">Resume</button>
      </div>`;
    }).join('')}` : '';

  list.innerHTML = activeHtml + historyHtml;
}

async function addTerminal() {
  if (!state.activeProjectId) return;
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  if (!proj.terminals) proj.terminals = [];

  try {
    // Spawn a new standalone bash shell on the backend
    const result = await api('POST', '/api/terminals', { cwd: proj.path });
    const termId = `shell-${result.id}`;
    // Skip if the statusWs broadcast already added this terminal
    if (proj.terminals.find(x => x.shellId === result.id)) return;
    proj.terminals.push({ id: termId, name: `bash-${proj.terminals.length}`, shellId: result.id });
    proj.activeTerminalIdx = proj.terminals.length - 1;
    state.activeTabType = 'terminal';
    renderCenterTabs(proj);
    renderCenterContent(proj);
  } catch (e) {
    showToast(proj.name, `Failed to create terminal: ${e.message}`, 'attention');
  }
}

// ═══════════════════════════════════════════════════════
// XTERM.JS TERMINAL
// ═══════════════════════════════════════════════════════
async function loadXterm() {
  if (xtermModule) return;
  const [xterm, fit] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  xtermModule = xterm;
  fitAddonModule = fit;
}

function attachXterm(termId, targetId, container, wsType = 'terminal') {
  // wsType: 'terminal' = /ws/terminal/:sessionId, 'shell' = /ws/shell/:shellId
  // If already created, swap DOM into the container
  if (terminalInstances[termId]) {
    const inst = terminalInstances[termId];
    // Always clear and re-attach — multiple terminals share the same container div
    container.innerHTML = '';
    container.appendChild(inst.el);
    inst.container = container;
    setTimeout(() => inst.fitAddon.fit(), 0);
    return;
  }

  container.innerHTML = '<div style="color:var(--text-muted);padding:12px;font-size:12px">Connecting terminal...</div>';

  loadXterm().then(() => {
    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%';
    container.innerHTML = '';
    container.appendChild(el);

    const Terminal = xtermModule.Terminal;
    const FitAddon = fitAddonModule.FitAddon;

    const term = new Terminal({
      theme: {
        background: '#0a0b0f',
        foreground: '#e0e0e0',
        cursor: '#5b8af5',
        selectionBackground: '#5b8af53a',
        black: '#1a1b25',
        brightBlack: '#3a3d52',
        blue: '#5b8af5',
        brightBlue: '#7ba4ff',
        cyan: '#5bbeaf',
        brightCyan: '#7dd8c9',
        green: '#59a86e',
        brightGreen: '#7bc48e',
        magenta: '#b07ee0',
        brightMagenta: '#c89ef0',
        red: '#e05555',
        brightRed: '#ff7777',
        white: '#e0e0e0',
        brightWhite: '#ffffff',
        yellow: '#d4a843',
        brightYellow: '#f0c060',
      },
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();

    // Connect WebSocket — /ws/terminal/:id for session PTY, /ws/shell/:id for standalone bash
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsPath = wsType === 'shell' ? 'shell' : 'terminal';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${wsPath}/${targetId}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output' && msg.data) {
          term.write(msg.data);
        }
      } catch {}
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[terminal disconnected]\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const resizeHandler = () => fitAddon.fit();
    window.addEventListener('resize', resizeHandler);

    terminalInstances[termId] = { term, fitAddon, ws, el, container, resizeHandler };

    setTimeout(() => fitAddon.fit(), 100);
  }).catch(err => {
    container.innerHTML = `<div style="color:var(--text-muted);padding:12px;font-size:12px">Failed to load terminal: ${err.message}</div>`;
  });
}

function destroyTerminal(termId) {
  const inst = terminalInstances[termId];
  if (!inst) return;
  window.removeEventListener('resize', inst.resizeHandler);
  if (inst.ws.readyState <= 1) inst.ws.close();
  inst.term.dispose();
  delete terminalInstances[termId];
}

// ═══════════════════════════════════════════════════════
// CONTEXT MENU (files)
// ═══════════════════════════════════════════════════════
function selectFileItem(el) {
  document.querySelectorAll('.file-tree-item.focused, .file-flat-item.focused').forEach(e => e.classList.remove('focused'));
  el.classList.add('focused');
  selectedFilePath = el.dataset.path;
  selectedFileType = el.dataset.type;
  selectedFileEl = el;
}

function dblClickFile(el) {
  if (el.dataset.type === 'file') openFileInEditor(el.dataset.path);
}

function showCtxMenu(e, filePath, fileType) {
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget;
  selectFileItem(el);
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const gitMap = {};
  (proj.gitChanges || []).forEach(c => { gitMap[c.file] = c.status; });
  const gitStatus = gitMap[filePath] || '';
  const isDir = fileType === 'dir';
  const fileName = filePath.split('/').pop();

  let items = '';
  if (!isDir) items += `<div class="ctx-item" onclick="ctxOpenFile('${esc(filePath)}')"><span class="ctx-icon">◇</span><span class="ctx-label">Open</span></div>`;
  items += `<div class="ctx-item" onclick="ctxCopyPath('${esc(filePath)}')"><span class="ctx-icon">⊡</span><span class="ctx-label">Copy Path</span></div>`;
  items += `<div class="ctx-sep"></div>`;
  items += `<div class="ctx-item" onclick="ctxRename('${esc(filePath)}','${fileType}')"><span class="ctx-icon">✎</span><span class="ctx-label">Rename</span></div>`;
  items += `<div class="ctx-item danger" onclick="ctxDelete('${esc(filePath)}','${fileType}')"><span class="ctx-icon">✕</span><span class="ctx-label">Delete</span></div>`;
  if (proj.isGit && gitStatus) {
    items += `<div class="ctx-sep"></div><div class="ctx-group-label">Git</div>`;
    items += `<div class="ctx-item" onclick="ctxRevertFile('${esc(filePath)}')"><span class="ctx-icon">⟲</span><span class="ctx-label">Revert Changes</span></div>`;
    items += `<div class="ctx-item" onclick="ctxStageFile('${esc(filePath)}')"><span class="ctx-icon">+</span><span class="ctx-label">Stage File</span></div>`;
  }
  if (isDir) {
    items += `<div class="ctx-sep"></div>`;
    items += `<div class="ctx-item" onclick="ctxNewFile('${esc(filePath)}')"><span class="ctx-icon">+</span><span class="ctx-label">New File</span></div>`;
    items += `<div class="ctx-item" onclick="ctxNewFolder('${esc(filePath)}')"><span class="ctx-icon">+</span><span class="ctx-label">New Folder</span></div>`;
  }

  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = items;
  menu.style.display = 'block';
  let x = e.clientX, y = e.clientY;
  if (x + 220 > window.innerWidth) x = window.innerWidth - 228;
  if (y + 300 > window.innerHeight) y = Math.max(8, window.innerHeight - 308);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  setTimeout(() => document.addEventListener('mousedown', function close(ev) {
    if (!menu.contains(ev.target)) { hideCtxMenu(); document.removeEventListener('mousedown', close); }
  }), 0);
}

function hideCtxMenu() { document.getElementById('ctx-menu').style.display = 'none'; }

function ctxOpenFile(p) { hideCtxMenu(); openFileInEditor(p); }
function ctxCopyPath(p) {
  hideCtxMenu();
  const proj = state.projects.find(pr => pr.id === state.activeProjectId);
  navigator.clipboard?.writeText(proj ? proj.path + '/' + p : p);
  showToast(proj?.name || '', 'Path copied', 'info');
}

async function ctxRename(filePath, fileType) {
  hideCtxMenu();
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const oldName = filePath.split('/').pop();
  const newName = prompt('Rename to:', oldName);
  if (!newName?.trim() || newName === oldName) return;
  const parts = filePath.split('/'); parts.pop();
  const dir = parts.join('/');
  const fromFull = proj.path + '/' + filePath;
  const toFull = proj.path + '/' + (dir ? dir + '/' : '') + newName;
  try {
    await api('POST', '/api/files/rename', { from: fromFull, to: toFull });
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, `Renamed ${oldName} → ${newName}`, 'info');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function ctxDelete(filePath, fileType) {
  hideCtxMenu();
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const name = filePath.split('/').pop();
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await api('DELETE', `/api/files?path=${encodeURIComponent(proj.path + '/' + filePath)}`);
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, `Deleted ${name}`, 'info');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function ctxRevertFile(filePath) {
  hideCtxMenu();
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/revert`, { file: filePath });
    await refreshGitData(proj);
    showToast(proj.name, `Reverted ${filePath.split('/').pop()}`, 'info');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function ctxStageFile(filePath) {
  hideCtxMenu();
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  try {
    await api('POST', `/api/projects/${proj.id}/git/stage`, { file: filePath });
    showToast(proj.name, `Staged ${filePath.split('/').pop()}`, 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function ctxNewFile(dirPath) {
  hideCtxMenu();
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const name = prompt('New file name:');
  if (!name) return;
  try {
    await api('POST', '/api/files/create', { path: proj.path + '/' + dirPath + '/' + name, type: 'file' });
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, `Created ${name}`, 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

async function ctxNewFolder(dirPath) {
  hideCtxMenu();
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    await api('POST', '/api/files/create', { path: proj.path + '/' + dirPath + '/' + name, type: 'dir' });
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, `Created folder ${name}`, 'success');
  } catch (e) {
    showToast(proj.name, `Failed: ${e.message}`, 'attention');
  }
}

// ═══════════════════════════════════════════════════════
// DRAG AND DROP
// ═══════════════════════════════════════════════════════
function onDragStart(e) {
  const el = e.currentTarget;
  dragState.srcPath = el.dataset.path;
  dragState.srcType = el.dataset.type;
  el.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragState.srcPath);
  el.addEventListener('dragend', onDragEnd, { once: true });
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  clearAllDropIndicators();
  dragState.srcPath = null;
  dragState.srcType = null;
}

function clearAllDropIndicators() {
  document.querySelectorAll('.drop-target, .drop-above, .drop-below, .drop-root').forEach(el => {
    el.classList.remove('drop-target', 'drop-above', 'drop-below', 'drop-root');
  });
}

function onDragOverItem(e) {
  e.preventDefault(); e.stopPropagation();
  if (!dragState.srcPath) return;
  const el = e.currentTarget;
  if (el.dataset.path === dragState.srcPath) return;
  e.dataTransfer.dropEffect = 'move';
  clearAllDropIndicators();
  if (el.dataset.type === 'dir') {
    el.classList.add('drop-target');
  } else {
    const rect = el.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) el.classList.add('drop-above');
    else el.classList.add('drop-below');
  }
}

function onDragLeaveItem(e) {
  e.currentTarget.classList.remove('drop-target', 'drop-above', 'drop-below');
}

async function onDropItem(e) {
  e.preventDefault(); e.stopPropagation();
  clearAllDropIndicators();
  if (!dragState.srcPath) return;
  const el = e.currentTarget;
  if (el.dataset.path === dragState.srcPath) return;

  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;

  const srcName = dragState.srcPath.split('/').pop();
  let destDir;
  if (el.dataset.type === 'dir') {
    destDir = el.dataset.path;
  } else {
    const parts = el.dataset.path.split('/'); parts.pop();
    destDir = parts.join('/');
  }

  const fromFull = proj.path + '/' + dragState.srcPath;
  const toFull = proj.path + '/' + (destDir ? destDir + '/' : '') + srcName;
  try {
    await api('POST', '/api/files/move', { from: fromFull, to: toFull });
    proj._filesLoaded = false;
    await selectProject(proj.id);
    showToast(proj.name, `Moved ${srcName}`, 'info');
  } catch (e2) {
    showToast(proj.name, `Failed: ${e2.message}`, 'attention');
  }
}

function onDropRoot(e) {
  if (!dragState.srcPath) return;
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (!proj) return;
  const srcName = dragState.srcPath.split('/').pop();
  const fromFull = proj.path + '/' + dragState.srcPath;
  const toFull = proj.path + '/' + srcName;
  api('POST', '/api/files/move', { from: fromFull, to: toFull }).then(() => {
    proj._filesLoaded = false;
    selectProject(proj.id);
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════
// SPLITTERS
// ═══════════════════════════════════════════════════════
function startLpSplitterDrag(e) {
  e.preventDefault();
  const splitter = document.getElementById('lp-splitter');
  const historyPanel = document.getElementById('git-history-panel');
  const leftPanel = historyPanel.closest('.left-panel');
  splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = historyPanel.offsetHeight;
  const totalH = leftPanel.offsetHeight;
  function onMove(ev) { historyPanel.style.height = Math.max(80, Math.min(totalH - 150, startH + (startY - ev.clientY))) + 'px'; }
  function onUp() {
    splitter.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveProjectSettings({ git_history_height: historyPanel.style.height });
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startEditorSplitterDrag(e) {
  e.preventDefault();
  const splitter = document.getElementById('editor-splitter');
  const editorArea = document.getElementById('editor-area');
  const centerPanel = editorArea.closest('.center-panel');
  splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = editorArea.offsetHeight;
  const totalH = centerPanel.offsetHeight;
  function onMove(ev) {
    editorArea.style.height = Math.max(80, Math.min(totalH - 120, startH + (ev.clientY - startY))) + 'px';
    if (editorState.monacoEditor) editorState.monacoEditor.layout();
    if (editorState.monacoDiffEditor) editorState.monacoDiffEditor.layout();
  }
  function onUp() {
    splitter.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveProjectSettings({ editor_area_height: editorArea.style.height });
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startSidebarSplitDrag(e) {
  e.preventDefault();
  const splitter = document.getElementById('sidebar-vsplit');
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  splitter.classList.add('dragging');
  const startX = e.clientX;
  const startW = sidebar.offsetWidth;
  function onMove(ev) { app.style.setProperty('--sidebar-w', Math.max(160, Math.min(400, startW + (ev.clientX - startX))) + 'px'); }
  function onUp() {
    splitter.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveEnvSettings({ sidebar_width: getComputedStyle(app).getPropertyValue('--sidebar-w').trim() });
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startVSplitDrag(e, side) {
  e.preventDefault();
  const workspace = document.getElementById('workspace');
  let splitter;
  if (side === 'left') splitter = document.getElementById('vsplit-left');
  else if (side === 'right') splitter = document.getElementById('vsplit-right');
  else splitter = document.getElementById('vsplit-preview');
  splitter.classList.add('dragging');

  if (side === 'left') {
    const lp = document.querySelector('.left-panel');
    const startX = e.clientX, startW = lp.offsetWidth;
    function onMove(ev) { workspace.style.setProperty('--lp-width', Math.max(140, Math.min(500, startW + (ev.clientX - startX))) + 'px'); }
    function onUp() {
      splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      saveProjectSettings({ lp_width: getComputedStyle(workspace).getPropertyValue('--lp-width').trim() });
    }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  } else if (side === 'right') {
    const rp = document.getElementById('right-panel');
    if (rp.classList.contains('collapsed')) return;
    const startX = e.clientX, startW = rp.offsetWidth;
    function onMove(ev) { workspace.style.setProperty('--rp-width', Math.max(140, Math.min(500, startW + (startX - ev.clientX))) + 'px'); }
    function onUp() {
      splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      saveProjectSettings({ rp_width: getComputedStyle(workspace).getPropertyValue('--rp-width').trim() });
    }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  } else {
    const pp = document.getElementById('preview-panel');
    const startX = e.clientX, startW = pp.offsetWidth;
    function onMove(ev) { workspace.style.setProperty('--pp-width', Math.max(200, Math.min(800, startW + (startX - ev.clientX))) + 'px'); }
    function onUp() {
      splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      saveProjectSettings({ pp_width: getComputedStyle(workspace).getPropertyValue('--pp-width').trim() });
    }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }
}

function toggleSessionsPanel() {
  const panel = document.getElementById('right-panel');
  const workspace = document.getElementById('workspace');
  panel.classList.toggle('collapsed');
  if (panel.classList.contains('collapsed')) {
    panel._savedWidth = getComputedStyle(workspace).getPropertyValue('--rp-width').trim() || '300px';
    workspace.style.setProperty('--rp-width', '36px');
  } else {
    workspace.style.setProperty('--rp-width', panel._savedWidth || '300px');
  }
  saveProjectSettings({ rp_collapsed: panel.classList.contains('collapsed'), rp_width: panel._savedWidth || '300px' });
}

// ═══════════════════════════════════════════════════════
// PREVIEW PANEL
// ═══════════════════════════════════════════════════════
function togglePreviewPanel() {
  state.previewVisible = !state.previewVisible;
  const workspace = document.getElementById('workspace');
  const preview = document.getElementById('preview-panel');
  if (state.previewVisible) {
    workspace.className = 'workspace layout-wide';
    preview.classList.remove('hidden');
    if (previewState.tabs.length === 0) addPreviewTab('');
    renderPreview();
  } else {
    workspace.className = 'workspace layout-default';
    preview.classList.add('hidden');
  }
  saveProjectSettings({ preview_visible: state.previewVisible });
}

function addPreviewTab(url) {
  url = url || '';
  const id = 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  let label = url ? url.replace(/^https?:\/\//, '').slice(0, 20) : 'New tab';
  previewState.tabs.push({ id, url, label });
  previewState.activeIdx = previewState.tabs.length - 1;
  renderPreview();
}

function closePreviewTab(idx, evt) {
  if (evt) evt.stopPropagation();
  previewState.tabs.splice(idx, 1);
  if (previewState.activeIdx >= previewState.tabs.length) previewState.activeIdx = Math.max(0, previewState.tabs.length - 1);
  if (previewState.tabs.length === 0) { addPreviewTab(''); return; }
  renderPreview();
}

function switchPreviewTab(idx) { previewState.activeIdx = idx; renderPreview(); }

function renderPreview() {
  const container = document.getElementById('preview-frames');
  const tabRow = document.getElementById('preview-tab-row');
  const urlInput = document.getElementById('preview-url');

  previewState.tabs.forEach((tab, i) => {
    let frame = document.getElementById(tab.id);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = tab.id;
      frame.className = 'preview-iframe hidden';
      frame.src = tab.url || 'about:blank';
      container.appendChild(frame);
    }
    frame.classList.toggle('hidden', i !== previewState.activeIdx);
  });

  container.querySelectorAll('.preview-iframe').forEach(f => {
    if (!previewState.tabs.some(t => t.id === f.id)) f.remove();
  });

  const active = previewState.tabs[previewState.activeIdx];
  urlInput.value = active ? active.url : '';

  tabRow.innerHTML = previewState.tabs.map((t, i) => {
    return `<div class="preview-tab ${i === previewState.activeIdx ? 'active' : ''}" onclick="switchPreviewTab(${i})">
      <span class="preview-tab-label">${t.label}</span>
      <span class="preview-tab-close" onclick="closePreviewTab(${i}, event)">×</span>
    </div>`;
  }).join('') + `<button class="preview-tab-add" onclick="addPreviewTab()" title="New preview tab">+</button>`;
}

function loadPreview() {
  const url = document.getElementById('preview-url').value.trim();
  if (!url) return;
  const tab = previewState.tabs[previewState.activeIdx];
  if (!tab) return;
  tab.url = url;
  tab.label = url.replace(/^https?:\/\//, '').slice(0, 20);
  const frame = document.getElementById(tab.id);
  if (frame) frame.src = url;
  renderPreview();
}

function openPreviewExternal() {
  const tab = previewState.tabs[previewState.activeIdx];
  const url = tab?.url || document.getElementById('preview-url').value.trim();
  if (url) window.open(url, '_blank');
}

// ═══════════════════════════════════════════════════════
// ATTACHMENTS
// ═══════════════════════════════════════════════════════
function handleFileAttach(fileList) {
  if (!fileList || fileList.length === 0) return;
  for (const file of fileList) addAttachment(file);
  document.getElementById('chat-file-input').value = '';
}

function handleChatPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) addAttachment(file);
    }
  }
}

function addAttachment(file) {
  const id = 'att-' + Date.now();
  const entry = { id, name: file.name, size: file.size, type: file.type, data: null };
  chatAttachments.push(entry);
  renderAttachments();
  // Read file content as base64
  const reader = new FileReader();
  reader.onload = () => {
    entry.data = reader.result.split(',')[1]; // strip data:...;base64, prefix
  };
  reader.readAsDataURL(file);
}

function removeAttachment(id) {
  const idx = chatAttachments.findIndex(a => a.id === id);
  if (idx >= 0) chatAttachments.splice(idx, 1);
  renderAttachments();
}

function renderAttachments() {
  const container = document.getElementById('chat-attachments');
  if (chatAttachments.length === 0) { container.classList.remove('has-items'); container.innerHTML = ''; return; }
  container.classList.add('has-items');
  container.innerHTML = chatAttachments.map(att => {
    const size = att.size < 1024 ? att.size + ' B' : att.size < 1048576 ? (att.size / 1024).toFixed(1) + ' KB' : (att.size / 1048576).toFixed(1) + ' MB';
    return `<div class="chat-attach-chip">
      <span class="chat-attach-chip-icon">📎</span>
      <span class="chat-attach-chip-name">${att.name}</span>
      <span class="chat-attach-chip-size">${size}</span>
      <span class="chat-attach-chip-remove" onclick="removeAttachment('${att.id}')">×</span>
    </div>`;
  }).join('');
}

function clearAttachments() { chatAttachments.length = 0; renderAttachments(); }

// ═══════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════
function toggleAddMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('add-menu');
  menu.classList.toggle('visible');
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.classList.remove('visible'); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function showNewProjectModal() {
  document.getElementById('add-menu').classList.remove('visible');
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-title">New Project</div>
        <div class="modal-field">
          <label class="modal-label">Project Name</label>
          <input type="text" id="modal-name" placeholder="my-project">
        </div>
        <div class="modal-field">
          <label class="modal-label">Path on Linux Machine</label>
          <div class="modal-path-row">
            <input type="text" id="modal-path" placeholder="/home/dev/projects/my-project">
            <button class="modal-browse-btn" onclick="toggleFolderBrowser('modal-path')">Browse</button>
          </div>
          <div id="folder-browser-modal-path"></div>
        </div>
        <div class="modal-field">
          <div class="git-toggle-row">
            <div class="git-toggle-label-group">
              <span class="git-toggle-main">Initialize Git Repository</span>
              <span class="git-toggle-sub">Run git init in project folder</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="modal-git" checked onchange="toggleRemoteUrl()">
              <span class="toggle-track"></span>
              <span class="toggle-thumb"></span>
            </label>
          </div>
          <div class="remote-url-field visible" id="remote-url-field">
            <label class="modal-label">Remote URL <span style="color:var(--text-muted);text-transform:none;letter-spacing:0">(optional)</span></label>
            <input type="text" id="modal-remote" placeholder="https://github.com/user/repo.git" style="width:100%;padding:8px 12px">
          </div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn cancel" onclick="closeModal()">Cancel</button>
          <button class="modal-btn confirm" onclick="addNewProject()">Create Project</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modal-name').focus();
}

function showOpenProjectModal() {
  document.getElementById('add-menu').classList.remove('visible');
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-title">Open Existing Project</div>
        <div class="modal-field">
          <label class="modal-label">Project Name</label>
          <input type="text" id="modal-name" placeholder="my-project">
        </div>
        <div class="modal-field">
          <label class="modal-label">Path to Project Folder</label>
          <div class="modal-path-row">
            <input type="text" id="modal-path" placeholder="/home/dev/projects/my-project">
            <button class="modal-browse-btn" onclick="toggleFolderBrowser('modal-path')">Browse</button>
          </div>
          <div id="folder-browser-modal-path"></div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn cancel" onclick="closeModal()">Cancel</button>
          <button class="modal-btn confirm" onclick="openExistingProject()">Open Project</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modal-name').focus();
}

function toggleRemoteUrl() {
  const checked = document.getElementById('modal-git').checked;
  const field = document.getElementById('remote-url-field');
  if (checked) {
    field.classList.add('visible');
  } else {
    field.classList.remove('visible');
  }
}

async function toggleFolderBrowser(inputId) {
  const container = document.getElementById('folder-browser-' + inputId);
  if (!container) return;
  if (container.innerHTML) {
    container.innerHTML = '';
    return;
  }
  const input = document.getElementById(inputId);
  const startPath = input.value.trim() || '';
  await loadFolderBrowser(inputId, startPath || undefined);
}

async function loadFolderBrowser(inputId, browsePath) {
  const container = document.getElementById('folder-browser-' + inputId);
  if (!container) return;
  try {
    const url = browsePath ? `/api/browse?path=${encodeURIComponent(browsePath)}` : '/api/browse';
    const data = await api('GET', url);
    let html = '<div class="folder-browser">';
    html += '<div class="folder-browser-bar">';
    if (data.parent && data.parent !== data.current) {
      html += `<button onclick="loadFolderBrowser('${inputId}','${data.parent.replace(/'/g, "\\'")}')">↑ Up</button>`;
    }
    html += `<span class="folder-browser-path">${data.current}</span>`;
    html += `<button onclick="selectBrowsePath('${inputId}','${data.current.replace(/'/g, "\\'")}')">Select</button>`;
    html += '</div>';
    html += '<div class="folder-browser-list">';
    if (data.dirs.length === 0) {
      html += '<div class="folder-browser-empty">No subdirectories</div>';
    } else {
      for (const d of data.dirs) {
        const escapedPath = d.path.replace(/'/g, "\\'");
        html += `<div class="folder-browser-item" onclick="loadFolderBrowser('${inputId}','${escapedPath}')" ondblclick="selectBrowsePath('${inputId}','${escapedPath}')">`;
        html += `<span class="folder-browser-icon">📁</span>`;
        html += `<span class="folder-browser-name">${d.name}</span>`;
        html += '</div>';
      }
    }
    html += '</div></div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="folder-browser"><div class="folder-browser-empty">Error: ${e.message}</div></div>`;
  }
}

function selectBrowsePath(inputId, selectedPath) {
  const input = document.getElementById(inputId);
  if (input) input.value = selectedPath;
  const container = document.getElementById('folder-browser-' + inputId);
  if (container) container.innerHTML = '';
}

function closeModal() { document.getElementById('modal-container').innerHTML = ''; }

async function addNewProject() {
  const name = document.getElementById('modal-name').value.trim();
  const projectPath = document.getElementById('modal-path').value.trim();
  const gitCheckbox = document.getElementById('modal-git');
  const initGit = gitCheckbox ? gitCheckbox.checked : false;
  const remoteInput = document.getElementById('modal-remote');
  const remoteUrl = remoteInput ? remoteInput.value.trim() : '';
  if (!name || !projectPath) return;
  if (!state.activeEnvironmentId) return;
  try {
    const project = await api('POST', `/api/environments/${state.activeEnvironmentId}/projects`, { name, path: projectPath, initGit, remoteUrl });
    state.projects.push({
      ...project,
      sessions: [],
      files: [],
      gitChanges: [],
      terminals: [],
      stashes: [],
      gitLog: { branches: [], currentBranch: '', commits: [], remotes: [] },
      activeSessionIdx: 0,
      activeTerminalIdx: 0,
    });
    closeModal();
    renderSidebarProjects();
    updateGlobalCounts();
    renderOverview();
    showToast(name, 'Project created', 'success');
  } catch (e) {
    showToast(name, `Failed: ${e.message}`, 'attention');
  }
}

async function openExistingProject() {
  const name = document.getElementById('modal-name').value.trim();
  const projectPath = document.getElementById('modal-path').value.trim();
  if (!name || !projectPath) return;
  if (!state.activeEnvironmentId) return;
  try {
    const project = await api('POST', `/api/environments/${state.activeEnvironmentId}/projects`, { name, path: projectPath });
    state.projects.push({
      ...project,
      sessions: [],
      files: [],
      gitChanges: [],
      terminals: [{ name: 'bash', output: `${project.path} $ ` }],
      stashes: [],
      gitLog: { branches: [], currentBranch: '', commits: [], remotes: [] },
      activeSessionIdx: 0,
      activeTerminalIdx: 0,
    });
    closeModal();
    renderSidebarProjects();
    updateGlobalCounts();
    renderOverview();
    showToast(name, 'Project opened', 'success');
  } catch (e) {
    showToast(name, `Failed: ${e.message}`, 'attention');
  }
}

// ═══════════════════════════════════════════════════════
// TOASTS
// ═══════════════════════════════════════════════════════
function showToast(project, message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-project">${project}</span><span class="toast-message">${message}</span>`;
  toast.onclick = () => toast.remove();
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function filterProjects(type) {
  if (type === 'attention') {
    const first = state.projects.find(p => p.sessions.some(s => s.status === 'waiting'));
    if (first) selectProject(first.id);
  } else if (type === 'active') {
    const first = state.projects.find(p => p.sessions.some(s => s.status === 'running' || s.status === 'waiting'));
    if (first) selectProject(first.id);
  } else {
    showOverview();
  }
}

// ═══════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════
function esc(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Copy icon SVG (inline, 14x14)
const svgCopy = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const svgCheck = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

// Markdown rendering for assistant messages
const mdRenderer = new marked.Renderer();
// Escape raw HTML so it renders as text, not DOM
mdRenderer.html = function({ text }) { return escHtml(text); };
// Syntax-highlight fenced code blocks
mdRenderer.code = function({ text, lang }) {
  let highlighted;
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(text, { language: lang }).value;
  } else {
    highlighted = escHtml(text);
  }
  const langLabel = lang ? `<span class="code-lang-label">${escHtml(lang)}</span>` : '';
  const copyBtn = `<span class="code-copy-btn" onclick="event.stopPropagation(); copyCode(this)" title="Copy code">${svgCopy}</span>`;
  return `<pre><div class="code-toolbar">${copyBtn}${langLabel}</div><code class="hljs${lang ? ' language-' + escHtml(lang) : ''}">${highlighted}</code></pre>`;
};
marked.setOptions({ breaks: true, gfm: true, renderer: mdRenderer });
function renderMd(text) {
  return marked.parse(text);
}

// Track per-message view mode: 'md' (default) → 'txt' → 'raw' → 'md'
const mdToggleState = {};
function toggleMd(uuid) {
  const cur = mdToggleState[uuid] || 'md';
  mdToggleState[uuid] = cur === 'md' ? 'txt' : cur === 'txt' ? 'raw' : 'md';
  const proj = state.projects.find(p => p.id === state.activeProjectId);
  if (proj) renderChat(proj);
}

function copyBubble(el) {
  const bubble = el.closest('.chat-bubble');
  if (!bubble) return;
  const content = bubble.querySelector('[data-raw-md]');
  if (!content) return;
  navigator.clipboard.writeText(content.dataset.rawMd).then(() => flashCopied(el));
}

function copyCode(el) {
  const pre = el.closest('pre');
  if (!pre) return;
  const code = pre.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.innerText).then(() => flashCopied(el));
}

function flashCopied(el) {
  const origHtml = el.innerHTML;
  el.innerHTML = svgCheck;
  el.classList.add('copied');
  setTimeout(() => { el.innerHTML = origHtml; el.classList.remove('copied'); }, 1500);
}

// ═══════════════════════════════════════════════════════
// ENVIRONMENTS
// ═══════════════════════════════════════════════════════
function renderStartPage() {
  const grid = document.getElementById('start-grid');
  grid.innerHTML = state.environments.map(env => `
    <div class="start-card" onclick="navigate('/vccenv/${env.id}')">
      <div class="start-card-name">${escHtml(env.name)}</div>
      <div class="start-card-count">${env.project_count || 0} projects</div>
    </div>
  `).join('');
}

function showStartPage() {
  document.getElementById('start-page').style.display = '';
  document.getElementById('app').style.display = 'none';
  renderStartPage();
}

function hideStartPage() {
  document.getElementById('start-page').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function selectEnvironment(envId, fromRouter = false) {
  // Save current env/project settings before switching
  if (state.activeEnvironmentId && state.activeProjectId) {
    flushProjectSettings();
  }

  state.activeEnvironmentId = envId;
  state.activeProjectEnvironmentId = null;
  const env = state.environments.find(e => e.id === envId);
  if (env) {
    document.getElementById('env-selector-name').textContent = env.name;
  }

  // Load environment settings
  try {
    state.environmentSettings = await api('GET', `/api/environments/${envId}/settings`);
    applyEnvironmentSettings(state.environmentSettings);
  } catch {}

  // Load projects for this environment
  try {
    const projects = await api('GET', `/api/environments/${envId}/projects`);
    state.projects = projects.map(p => ({
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
    }));
  } catch (e) {
    console.error('Failed to load projects for environment:', e);
    state.projects = [];
  }

  state.activeProjectId = null;
  hideStartPage();
  renderSidebarProjects();
  updateGlobalCounts();
  renderOverview();
  renderEnvDropdown();

  if (!fromRouter) {
    history.pushState(null, '', '/vccenv/' + envId);
  }
}

function applyEnvironmentSettings(settings) {
  if (!settings) return;
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  if (settings.sidebar_width) {
    app.style.setProperty('--sidebar-w', settings.sidebar_width);
  }
  if (settings.sidebar_collapsed) {
    sidebar.classList.add('collapsed');
    app.style.setProperty('--sidebar-w', '64px');
  } else {
    sidebar.classList.remove('collapsed');
  }
}

function renderEnvDropdown() {
  const list = document.getElementById('env-dropdown-list');
  list.innerHTML = state.environments.map(env => `
    <div class="env-dropdown-item ${env.id === state.activeEnvironmentId ? 'active' : ''}"
         onclick="navigate('/vccenv/${env.id}'); closeEnvDropdown()">
      <span class="env-dropdown-icon">◈</span>
      ${escHtml(env.name)}
      <span class="env-dropdown-count">${env.project_count || 0}</span>
    </div>
  `).join('');
}

function toggleEnvDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('env-dropdown');
  dd.classList.toggle('visible');
  if (dd.classList.contains('visible')) {
    renderEnvDropdown();
    const close = (ev) => {
      if (!dd.contains(ev.target) && !ev.target.closest('.env-selector-btn')) {
        dd.classList.remove('visible');
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

function closeEnvDropdown() {
  document.getElementById('env-dropdown').classList.remove('visible');
}

async function createEnvironmentFromStart() {
  const name = prompt('Environment name:');
  if (!name) return;
  try {
    const env = await api('POST', '/api/environments', { name });
    state.environments.push(env);
    await selectEnvironment(env.id);
  } catch (e) {
    showToast('Error', `Failed to create environment: ${e.message}`, 'attention');
  }
}

async function createEnvironmentFromDropdown() {
  closeEnvDropdown();
  const name = prompt('Environment name:');
  if (!name) return;
  try {
    const env = await api('POST', '/api/environments', { name });
    state.environments.push(env);
    await selectEnvironment(env.id);
  } catch (e) {
    showToast('Error', `Failed to create environment: ${e.message}`, 'attention');
  }
}

async function showConnectProjectModal() {
  document.getElementById('add-menu').classList.remove('visible');
  if (!state.activeEnvironmentId) return;

  // Fetch other environments
  let envs;
  try {
    envs = await api('GET', '/api/environments');
    envs = envs.filter(e => e.id !== state.activeEnvironmentId);
  } catch { envs = []; }

  if (envs.length === 0) {
    showToast('Connect', 'No other environments available', 'info');
    return;
  }

  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-title">Connect Project</div>
        <div class="modal-field">
          <label class="modal-label">Select Environment</label>
          <div class="connect-env-list" id="connect-env-list">
            ${envs.map(e => `
              <div class="connect-item" onclick="connectStep2('${e.id}', '${escHtml(e.name)}')">
                <div class="connect-item-name">${escHtml(e.name)}</div>
                <div class="connect-item-sub">${e.project_count || 0} projects</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn cancel" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>`;
}

async function connectStep2(envId, envName) {
  let projects;
  try {
    projects = await api('GET', `/api/environments/${envId}/projects`);
  } catch { projects = []; }

  // Filter out projects already in current environment
  const currentIds = new Set(state.projects.map(p => p.id));
  projects = projects.filter(p => !currentIds.has(p.id));

  if (projects.length === 0) {
    showToast('Connect', 'No new projects to connect from ' + envName, 'info');
    return;
  }

  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-title">Connect Project from ${escHtml(envName)}</div>
        <div class="modal-field">
          <button class="connect-back" onclick="showConnectProjectModal()">← Back to environments</button>
          <label class="modal-label">Select Project</label>
          <div class="connect-proj-list">
            ${projects.map(p => `
              <div class="connect-item" onclick="connectProject('${p.id}')">
                <div class="connect-item-name">${escHtml(p.name)}</div>
                <div class="connect-item-sub">${escHtml(p.path)}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn cancel" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>`;
}

async function connectProject(projectId) {
  try {
    await api('POST', `/api/environments/${state.activeEnvironmentId}/connect-project`, { project_id: projectId });
    closeModal();
    // Reload projects
    await selectEnvironment(state.activeEnvironmentId);
    showToast('Connect', 'Project connected', 'success');
  } catch (e) {
    showToast('Connect', `Failed: ${e.message}`, 'attention');
  }
}

// ═══════════════════════════════════════════════════════
// SETTINGS PERSISTENCE (debounced)
// ═══════════════════════════════════════════════════════
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const saveEnvSettings = debounce((settings) => {
  if (!state.activeEnvironmentId) return;
  api('PUT', `/api/environments/${state.activeEnvironmentId}/settings`, settings).catch(() => {});
}, 300);

const saveProjectSettings = debounce((settings) => {
  if (!state.activeProjectEnvironmentId) return;
  api('PUT', `/api/project-links/${state.activeProjectEnvironmentId}/settings`, settings).catch(() => {});
}, 300);

function flushProjectSettings() {
  // Immediate save of current project settings (for project/env switch)
  if (!state.activeProjectEnvironmentId) return;
  const settings = gatherProjectSettings();
  api('PUT', `/api/project-links/${state.activeProjectEnvironmentId}/settings`, settings).catch(() => {});
}

function gatherProjectSettings() {
  const workspace = document.getElementById('workspace');
  const editorArea = document.getElementById('editor-area');
  const rightPanel = document.getElementById('right-panel');
  return {
    open_files: editorState.openFiles,
    active_file_idx: editorState.activeFileIdx,
    active_tab_type: state.activeTabType,
    editor_area_height: editorArea?.style.height || '',
    editor_area_open: editorArea?.classList.contains('open') || false,
    lp_width: workspace ? getComputedStyle(workspace).getPropertyValue('--lp-width').trim() : '',
    rp_width: workspace ? getComputedStyle(workspace).getPropertyValue('--rp-width').trim() : '',
    rp_collapsed: rightPanel?.classList.contains('collapsed') || false,
    pp_width: workspace ? getComputedStyle(workspace).getPropertyValue('--pp-width').trim() : '',
    git_history_height: document.getElementById('git-history-panel')?.style.height || '',
    file_filter: state.fileFilter,
    file_view: state.fileView,
    stash_open: state.stashOpen,
    preview_visible: state.previewVisible,
    preview_tabs: previewState.tabs,
    preview_active_idx: previewState.activeIdx,
  };
}

function applyProjectSettings(settings) {
  if (!settings || Object.keys(settings).length === 0) return;
  const workspace = document.getElementById('workspace');
  const editorArea = document.getElementById('editor-area');
  const rightPanel = document.getElementById('right-panel');

  if (settings.open_files) editorState.openFiles = settings.open_files;
  if (settings.active_file_idx !== undefined) editorState.activeFileIdx = settings.active_file_idx;
  if (settings.active_tab_type) state.activeTabType = settings.active_tab_type;

  if (settings.editor_area_open) {
    editorArea?.classList.add('open');
    if (settings.editor_area_height) editorArea.style.height = settings.editor_area_height;
  } else {
    editorArea?.classList.remove('open');
    if (editorArea) editorArea.style.height = '0';
  }

  if (settings.lp_width && workspace) workspace.style.setProperty('--lp-width', settings.lp_width);
  if (settings.rp_width && workspace) workspace.style.setProperty('--rp-width', settings.rp_width);
  if (settings.rp_collapsed) {
    rightPanel?.classList.add('collapsed');
    if (workspace) workspace.style.setProperty('--rp-width', '36px');
  } else {
    rightPanel?.classList.remove('collapsed');
    if (settings.rp_width && workspace) workspace.style.setProperty('--rp-width', settings.rp_width);
  }
  if (settings.pp_width && workspace) workspace.style.setProperty('--pp-width', settings.pp_width);
  if (settings.git_history_height) {
    const ghp = document.getElementById('git-history-panel');
    if (ghp) ghp.style.height = settings.git_history_height;
  }
  // Apply file filter/view directly without triggering saveProjectSettings (avoid save loop)
  if (settings.file_filter) {
    state.fileFilter = settings.file_filter;
    document.getElementById('tb-filter-all')?.classList.toggle('active', settings.file_filter === 'all');
    document.getElementById('tb-filter-changed')?.classList.toggle('active', settings.file_filter === 'changed');
  }
  if (settings.file_view) {
    state.fileView = settings.file_view;
    document.getElementById('tb-view-tree')?.classList.toggle('active', settings.file_view === 'tree');
    document.getElementById('tb-view-flat')?.classList.toggle('active', settings.file_view === 'flat');
  }
  if (settings.file_filter || settings.file_view) {
    const proj = state.projects.find(p => p.id === state.activeProjectId);
    if (proj) renderFileTree(proj);
  }
  if (settings.stash_open !== undefined) state.stashOpen = settings.stash_open;
  if (settings.preview_visible !== undefined) state.previewVisible = settings.preview_visible;
  if (settings.preview_tabs) previewState.tabs = settings.preview_tabs;
  if (settings.preview_active_idx !== undefined) previewState.activeIdx = settings.preview_active_idx;
}

// Settings WebSocket for real-time sync
let settingsWs = null;
function connectSettingsWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  settingsWs = new WebSocket(`${proto}//${location.host}/ws/settings`);
  settingsWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'settings_change') {
        if (msg.scope === 'environment' && msg.key === state.activeEnvironmentId) {
          applyEnvironmentSettings(msg.settings);
        } else if (msg.scope === 'project' && msg.key === state.activeProjectEnvironmentId) {
          applyProjectSettings(msg.settings);
        }
      }
    } catch {}
  };
  settingsWs.onclose = () => { setTimeout(connectSettingsWs, 3000); };
}

// ═══════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  // Allow Escape through even from inputs
  if (e.key === 'Escape') {
    hideCtxMenu(); closeModal();
    // Forward Escape to CLI PTY for the active session
    const proj = state.projects.find(p => p.id === state.activeProjectId);
    if (proj) {
      const activeSessions = proj.sessions.filter(s => s.status !== 'ended');
      const session = activeSessions[proj.activeSessionIdx || 0];
      if (session) {
        if (!sendAgentCommand(session.id, { action: 'send_key', key: 'escape' })) {
          api('POST', `/api/sessions/${session.id}/send-key`, { key: 'escape' }).catch(() => {});
        }
      }
    }
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!selectedFilePath || !state.activeProjectId) return;
  if (e.key === 'F2') { e.preventDefault(); ctxRename(selectedFilePath, selectedFileType); }
  if (e.key === 'Delete') { e.preventDefault(); ctxDelete(selectedFilePath, selectedFileType); }
});

// ═══════════════════════════════════════════════════════
// EXPOSE TO WINDOW (for inline onclick handlers)
// ═══════════════════════════════════════════════════════
Object.assign(window, {
  toggleSidebarCollapse, startSidebarSplitDrag, selectProject, showOverview,
  filterProjects, toggleAddMenu, showNewProjectModal, showOpenProjectModal,
  showConnectProjectModal, connectStep2, connectProject,
  setFileFilter, setFileView, toggleStashPanel, toggleDir, selectFileItem, dblClickFile,
  showCtxMenu, ctxOpenFile, ctxCopyPath, ctxRename, ctxDelete, ctxRevertFile,
  ctxStageFile, ctxNewFile, ctxNewFolder,
  startLpSplitterDrag, startVSplitDrag, startEditorSplitterDrag,
  switchGitBranch, createBranch, fetchRemote, openRemoteManager,
  addRemote, removeRemote, editRemote,
  gitRevertAll, gitStashAll, gitCommit, gitPush, applyStash, dropStash,
  switchToSession, switchToTerminal, newSession, resumeSession, addTerminal,
  setSessionView, toggleVerbose, sendMessage, sendTuiMessage,
  handleChatKey, handleTuiKey, handleFileAttach, handleChatPaste, removeAttachment,
  setEditorView, switchEditorTab, closeEditorTab, openFileInEditor,
  togglePreviewPanel, addPreviewTab, closePreviewTab, switchPreviewTab, loadPreview, openPreviewExternal,
  toggleSessionsPanel, closeModal, addNewProject, openExistingProject,
  toggleRemoteUrl, toggleFolderBrowser, loadFolderBrowser, selectBrowsePath,
  expandCollapsed, showRawEvent, toggleMd, copyBubble, copyCode, selectCommit, copyHash, toggleCommitExpand,
  showCommitInfoModal, showCommitCtxMenu, hideCtxMenu,
  updateSessionMode, updateSessionModel, approveControl, denyControl,
  selectQuestionOption, selectQuestionCustom, updateQuestionCustom,
  submitQuestion, skipQuestion,
  // Environment functions
  selectEnvironment, toggleEnvDropdown, closeEnvDropdown,
  createEnvironmentFromStart, createEnvironmentFromDropdown,
  // Router
  navigate,
});

// ═══════════════════════════════════════════════════════
// CLIENT-SIDE ROUTER
// ═══════════════════════════════════════════════════════
let _routerActive = false;

function navigate(path, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  handleRoute();
}

async function handleRoute() {
  if (_routerActive) return;
  _routerActive = true;
  try {
    await _handleRouteInner();
  } finally {
    _routerActive = false;
  }
}

async function _handleRouteInner() {
  const path = location.pathname;

  if (path === '/') {
    state.activeProjectId = null;
    state.activeProjectEnvironmentId = null;
    state.activeEnvironmentId = null;
    showStartPage();
    return;
  }

  const envMatch = path.match(/^\/vccenv\/([^/]+)$/);
  if (envMatch) {
    const envId = envMatch[1];
    if (state.activeEnvironmentId !== envId) {
      await selectEnvironment(envId, true);
    } else if (state.activeProjectId) {
      // Was in a project, go back to overview
      showOverviewDirect();
    }
    return;
  }

  const projMatch = path.match(/^\/project\/([^/]+)$/);
  if (projMatch) {
    const peId = projMatch[1];
    if (state.activeProjectEnvironmentId === peId) return; // Already there
    try {
      const pe = await api('GET', `/api/project-links/${peId}`);
      if (state.activeEnvironmentId !== pe.environment_id) {
        await selectEnvironment(pe.environment_id, true);
      }
      await selectProject(pe.project_id, peId, true);
    } catch (e) {
      console.error('Failed to resolve project link:', e);
      history.replaceState(null, '', '/');
      showStartPage();
    }
    return;
  }

  // Unknown route → start page
  history.replaceState(null, '', '/');
  showStartPage();
}

// Show overview without triggering navigation (used by router)
function showOverviewDirect() {
  saveProjectViewState(state.activeProjectId);
  if (state.activeProjectId && state.activeProjectEnvironmentId) {
    flushProjectSettings();
  }
  state.activeProjectId = null;
  state.activeProjectEnvironmentId = null;
  document.getElementById('overview-screen').classList.remove('hidden');
  document.getElementById('workspace').classList.add('hidden');
  document.getElementById('topbar-project-name').textContent = 'Overview';
  document.getElementById('topbar-breadcrumb').textContent = '';
  renderSidebarProjects();
  renderOverview();
}

window.addEventListener('popstate', () => handleRoute());

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
async function init() {
  // 1. Fetch environments
  try {
    state.environments = await api('GET', '/api/environments');
  } catch (e) {
    console.error('Failed to load environments:', e);
    state.environments = [];
  }

  // 2. Auto-create "Default" if no environments exist
  if (state.environments.length === 0) {
    try {
      const env = await api('POST', '/api/environments', { name: 'Default' });
      state.environments.push(env);
    } catch (e) {
      console.error('Failed to create default environment:', e);
    }
  }

  // 3. Let the URL drive what's shown
  await handleRoute();

  // Connect WebSockets
  connectStatusWs();
  connectSettingsWs();

  // Initialize Monaco editor
  initMonaco();
}

init();
