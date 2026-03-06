import React, { useEffect } from 'react';
import { useStore } from './state/store';
import { api } from './api';
import { connectStatusWs, connectSettingsWs, connectSessionWs, connectAgentWs, sendAgentCommand, setPendingAgentCreation, getSessionWs } from './api/websocket';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TopBar } from './components/TopBar/TopBar';
import { Overview } from './components/Overview/Overview';
import { Workspace } from './components/Layout/Workspace';
import { StartPage } from './components/Layout/StartPage';
import { ToastContainer } from './components/Layout/Toast';
import { ModalContainer } from './components/Modals/ModalContainer';
import { ContextMenu } from './components/Modals/ContextMenu';
import { SessionLoadingOverlay } from './components/Modals/SessionLoadingOverlay';
import { getMonacoLang, debounce, getServerIp } from './utils';

export function App() {
  const {
    activeProjectId, activeEnvironmentId, projects,
  } = useStore();

  useEffect(() => {
    registerGlobalFunctions();
    init();

    // Save project settings on page unload
    window.addEventListener('beforeunload', flushProjectSettings);

    // Auto-save project settings periodically
    const autoSaveInterval = setInterval(() => {
      const s = useStore.getState();
      if (s.activeProjectEnvironmentId) {
        saveProjectSettings(gatherProjectSettings());
      }
    }, 5000);

    return () => {
      window.removeEventListener('beforeunload', flushProjectSettings);
      clearInterval(autoSaveInterval);
    };
  }, []);

  const showStart = !activeEnvironmentId;
  const showOverview = activeEnvironmentId && !activeProjectId;
  const showWorkspace = activeEnvironmentId && activeProjectId;

  return (
    <>
      {showStart && <StartPage />}
      <div id="app" style={{ display: showStart ? 'none' : '' }}>
        <Sidebar />
        <div className="sidebar-vsplit" id="sidebar-vsplit" onMouseDown={(e) => (window as any).startSidebarSplitDrag(e.nativeEvent)}></div>
        <TopBar />
        <div id="main">
          {showOverview && <Overview />}
          {showWorkspace && <Workspace />}
        </div>
      </div>
      <ToastContainer />
      <ModalContainer />
      <ContextMenu />
    </>
  );
}

async function init() {
  const store = useStore.getState();

  // 1. Fetch environments
  try {
    const envs = await api('GET', '/api/environments');
    store.setEnvironments(envs);
  } catch (e) {
    console.error('Failed to load environments:', e);
    store.setEnvironments([]);
  }

  // 2. Auto-create "Default" if no environments exist
  const envs = useStore.getState().environments;
  if (envs.length === 0) {
    try {
      const env = await api('POST', '/api/environments', { name: 'Default' });
      store.setEnvironments([env]);
    } catch (e) {
      console.error('Failed to create default environment:', e);
    }
  }

  // 3. Route handling
  await handleRoute();

  // 4. Resolve server IP for nip.io URLs (async, cached)
  getServerIp();

  // 5. Connect WebSockets
  connectStatusWs();
  connectSettingsWs();

  // 5. Listen for popstate
  window.addEventListener('popstate', () => handleRoute());
}

async function handleRoute() {
  const path = window.location.pathname;

  if (path === '/' || path === '') {
    const envs = useStore.getState().environments;
    if (envs.length === 1) {
      await selectEnvironment(envs[0].id, true);
    } else {
      showStartPage();
    }
    return;
  }

  const envMatch = path.match(/^\/vccenv\/([^/]+)$/);
  if (envMatch) {
    const envId = envMatch[1];
    const store = useStore.getState();
    if (store.activeEnvironmentId !== envId) {
      await selectEnvironment(envId, true);
    } else if (store.activeProjectId) {
      showOverviewDirect();
    }
    return;
  }

  const projMatch = path.match(/^\/project\/([^/]+)$/);
  if (projMatch) {
    const peId = projMatch[1];
    const store = useStore.getState();
    if (store.activeProjectEnvironmentId === peId) return;
    try {
      const pe = await api('GET', `/api/project-links/${peId}`);
      if (store.activeEnvironmentId !== pe.environment_id) {
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

  history.replaceState(null, '', '/');
  showStartPage();
}

function showStartPage() {
  useStore.setState({ activeEnvironmentId: null, activeProjectId: null, activeProjectEnvironmentId: null });
}

function showOverviewDirect() {
  const store = useStore.getState();
  saveProjectViewState(store.activeProjectId);
  if (store.activeProjectId && store.activeProjectEnvironmentId) {
    flushProjectSettings();
  }
  store.setActiveProjectId(null);
  store.setActiveProjectEnvironmentId(null);
}

async function selectEnvironment(envId: string, fromRouter = false) {
  const store = useStore.getState();
  store.setActiveEnvironmentId(envId);
  store.setActiveProjectEnvironmentId(null);
  store.setActiveProjectId(null);

  // Load environment settings
  try {
    const settings = await api('GET', `/api/environments/${envId}/settings`);
    store.setEnvironmentSettings(settings || {});
  } catch {}

  // Load projects
  try {
    const projects = await api('GET', `/api/environments/${envId}/projects`);
    store.setProjects(projects.map((p: any) => ({
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
    })));
  } catch (e) {
    console.error('Failed to load projects for environment:', e);
    store.setProjects([]);
  }

  if (!fromRouter) {
    history.pushState(null, '', '/vccenv/' + envId);
  }
}

async function selectProject(projectId: string, peId?: string, fromRouter = false) {
  const store = useStore.getState();

  // Save current project's view state before switching
  saveProjectViewState(store.activeProjectId);
  if (store.activeProjectId && store.activeProjectEnvironmentId) {
    flushProjectSettings();
  }

  store.setActiveProjectId(projectId);

  if (peId) {
    store.setActiveProjectEnvironmentId(peId);
  } else {
    const proj = store.projects.find(p => p.id === projectId);
    store.setActiveProjectEnvironmentId(proj?.pe_id || null);
  }

  const proj = useStore.getState().projects.find(p => p.id === projectId);
  if (!proj) return;

  // Load settings from DB
  const apeId = useStore.getState().activeProjectEnvironmentId;
  if (apeId) {
    try {
      const dbSettings = await api('GET', `/api/project-links/${apeId}/settings`);
      if (dbSettings && Object.keys(dbSettings).length > 0) {
        applyProjectSettings(dbSettings, proj);
      }
    } catch {}
  }

  if (!fromRouter && apeId) {
    history.pushState(null, '', '/project/' + apeId);
  }

  // Determine effective path (worktree or project root)
  const cwdParam = proj.worktreePath ? `?cwd=${encodeURIComponent(proj.worktreePath)}` : '';
  const rootPathParam = proj.worktreePath ? `?rootPath=${encodeURIComponent(proj.worktreePath)}` : '';

  // Lazy-load file tree
  if (!proj._filesLoaded) {
    try {
      const files = await api('GET', `/api/projects/${proj.id}/files${rootPathParam}`);
      useStore.getState().updateProject(proj.id, p => ({ ...p, files, _filesLoaded: true }));
    } catch (e) {
      useStore.getState().updateProject(proj.id, p => ({ ...p, files: [], _filesLoaded: true }));
    }
  }

  // Lazy-load git data
  if (proj.isGit && !proj._gitLoaded) {
    try {
      const [status, branches, stashes, remotes] = await Promise.all([
        api('GET', `/api/projects/${proj.id}/git/status${cwdParam}`),
        api('GET', `/api/projects/${proj.id}/git/branches${cwdParam}`),
        api('GET', `/api/projects/${proj.id}/git/stash${cwdParam}`),
        api('GET', `/api/projects/${proj.id}/git/remotes${cwdParam}`),
      ]);
      let commits: any[] = [];
      try {
        const log = await api('GET', `/api/projects/${proj.id}/git/log${cwdParam}`);
        commits = log.map((c: any, i: number) => ({
          ...c,
          refs: i === 0 ? [{ type: 'head', label: 'HEAD' }, { type: 'branch', label: branches.currentBranch }] : [],
        }));
      } catch {}

      useStore.getState().updateProject(proj.id, p => ({
        ...p,
        gitChanges: status,
        gitLog: { branches: branches.branches, currentBranch: branches.currentBranch, remotes, commits },
        stashes,
        _gitLoaded: true,
      }));
    } catch (e) {
      useStore.getState().updateProject(proj.id, p => ({
        ...p,
        gitChanges: [],
        gitLog: { branches: [], currentBranch: '', commits: [], remotes: [] },
        stashes: [],
        _gitLoaded: true,
      }));
    }
  }

  // Lazy-load sessions + historical
  if (!proj._sessionsLoaded) {
    try {
      const [sessions, historical] = await Promise.all([
        api('GET', `/api/projects/${proj.id}/sessions`),
        api('GET', '/api/historical-sessions').catch(() => []),
      ]);
      const mappedSessions = sessions.map((s: any) => ({
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
      const activeIds = new Set(mappedSessions.map((s: any) => s.id));
      const historicalSessions = historical
        .filter((h: any) => h.directory === proj.path && !activeIds.has(h.id))
        .map((h: any) => ({
          id: h.id,
          agentType: h.agentType,
          title: h.title || 'Untitled',
          lastModified: h.lastModified,
          eventCount: h.eventCount,
        }));

      for (const s of mappedSessions) {
        if (s.status !== 'ended') connectSessionWs(s.id);
      }

      useStore.getState().updateProject(proj.id, p => ({
        ...p,
        sessions: mappedSessions,
        historicalSessions,
        _sessionsLoaded: true,
      }));
    } catch {}
  }

  // Lazy-load terminals
  if (!proj._terminalsLoaded) {
    try {
      const terminals = await api('GET', '/api/terminals');
      const projTerminals = terminals.filter((t: any) => t.projectPath === proj.path || (proj.worktreePath && t.projectPath === proj.worktreePath));
      useStore.getState().updateProject(proj.id, p => {
        const existing = p.terminals || [];
        const newTerminals = [...existing];
        for (const t of projTerminals) {
          if (!newTerminals.find(x => x.shellId === t.id)) {
            newTerminals.push({ id: `shell-${t.id}`, name: `bash-${newTerminals.length}`, shellId: t.id });
          }
        }
        return { ...p, terminals: newTerminals, _terminalsLoaded: true };
      });
    } catch {}
  }
}

function applyProjectSettings(settings: any, proj: any) {
  const store = useStore.getState();
  if (settings.open_files) store.setOpenFiles(settings.open_files);
  if (settings.active_file_idx !== undefined) store.setActiveFileIdx(settings.active_file_idx);
  if (settings.active_tab_type) store.setActiveTabType(settings.active_tab_type);
  if (settings.file_filter) store.setFileFilter(settings.file_filter);
  if (settings.file_view) store.setFileView(settings.file_view);
  if (settings.stash_open !== undefined) store.setStashOpen(settings.stash_open);
  if (settings.preview_visible !== undefined) store.setPreviewVisible(settings.preview_visible);
  if (settings.preview_tabs) store.setPreviewTabs(settings.preview_tabs);
  if (settings.preview_active_idx !== undefined) store.setPreviewActiveIdx(settings.preview_active_idx);
  if (settings.preview_mode) store.setPreviewMode(settings.preview_mode);

  // Apply DOM-level layout settings
  setTimeout(() => {
    const workspace = document.getElementById('workspace');
    const editorArea = document.getElementById('editor-area');
    const rightPanel = document.getElementById('right-panel');
    const ghp = document.getElementById('git-history-panel');

    if (settings.editor_area_open) {
      editorArea?.classList.add('open');
      if (settings.editor_area_height && editorArea) editorArea.style.height = settings.editor_area_height;
    }
    if (settings.lp_width && workspace) workspace.style.setProperty('--lp-width', settings.lp_width);
    if (settings.rp_width && workspace) workspace.style.setProperty('--rp-width', settings.rp_width);
    if (settings.rp_collapsed) {
      rightPanel?.classList.add('collapsed');
      if (workspace) workspace.style.setProperty('--rp-width', '36px');
    }
    if (settings.pp_width && workspace) workspace.style.setProperty('--pp-width', settings.pp_width);
    if (settings.git_history_height && ghp) ghp.style.height = settings.git_history_height;
  }, 0);
}

function gatherProjectSettings(): Record<string, any> {
  const store = useStore.getState();
  const workspace = document.getElementById('workspace');
  const editorArea = document.getElementById('editor-area');
  const rightPanel = document.getElementById('right-panel');
  return {
    open_files: store.openFiles,
    active_file_idx: store.activeFileIdx,
    active_tab_type: store.activeTabType,
    editor_area_height: editorArea?.style.height || '',
    editor_area_open: editorArea?.classList.contains('open') || false,
    lp_width: workspace ? getComputedStyle(workspace).getPropertyValue('--lp-width').trim() : '',
    rp_width: workspace ? getComputedStyle(workspace).getPropertyValue('--rp-width').trim() : '',
    rp_collapsed: rightPanel?.classList.contains('collapsed') || false,
    pp_width: workspace ? getComputedStyle(workspace).getPropertyValue('--pp-width').trim() : '',
    git_history_height: document.getElementById('git-history-panel')?.style.height || '',
    file_filter: store.fileFilter,
    file_view: store.fileView,
    stash_open: store.stashOpen,
    preview_visible: store.previewVisible,
    preview_tabs: store.previewTabs,
    preview_active_idx: store.previewActiveIdx,
    preview_mode: store.previewMode,
  };
}

const saveProjectSettings = debounce((settings: Record<string, any>) => {
  const store = useStore.getState();
  if (!store.activeProjectEnvironmentId) return;
  api('PUT', `/api/project-links/${store.activeProjectEnvironmentId}/settings`, settings).catch(() => {});
}, 300);

function flushProjectSettings() {
  const store = useStore.getState();
  if (!store.activeProjectEnvironmentId) return;
  const settings = gatherProjectSettings();
  api('PUT', `/api/project-links/${store.activeProjectEnvironmentId}/settings`, settings).catch(() => {});
}

function saveProjectViewState(projectId: string | null) {
  if (!projectId) return;
  const store = useStore.getState();
  store.setProjectViewState(projectId, {
    openFiles: store.openFiles,
    activeFileIdx: store.activeFileIdx,
    activeTabType: store.activeTabType,
    editorAreaHeight: document.getElementById('editor-area')?.style.height || '',
    editorAreaOpen: document.getElementById('editor-area')?.classList.contains('open') || false,
  });
}

function restoreProjectViewState(projectId: string) {
  const store = useStore.getState();
  const saved = store.projectViewStates[projectId];
  if (saved) {
    store.setOpenFiles(saved.openFiles || []);
    store.setActiveFileIdx(saved.activeFileIdx ?? -1);
    store.setActiveTabType(saved.activeTabType || 'session');
    setTimeout(() => {
      const editorArea = document.getElementById('editor-area');
      if (saved.editorAreaOpen) {
        editorArea?.classList.add('open');
        if (saved.editorAreaHeight && editorArea) editorArea.style.height = saved.editorAreaHeight;
      } else {
        editorArea?.classList.remove('open');
        if (editorArea) editorArea.style.height = '0';
      }
    }, 0);
  } else {
    store.setOpenFiles([]);
    store.setActiveFileIdx(-1);
    store.setActiveTabType('session');
    setTimeout(() => {
      const editorArea = document.getElementById('editor-area');
      editorArea?.classList.remove('open');
      if (editorArea) editorArea.style.height = '0';
    }, 0);
  }
}

// Bridge: register global functions that legacy HTML onclick handlers and
// splitter/terminal code still need. Over time these can be migrated to pure React.
function registerGlobalFunctions() {
  const win = window as any;

  // Global Ctrl+S: save current editor file, prevent browser save dialog
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      win.saveCurrentFile?.();
    }
  });

  win.selectProject = selectProject;
  win.showOverview = () => {
    const store = useStore.getState();
    store.setActiveProjectId(null);
    store.setActiveProjectEnvironmentId(null);
    if (store.activeEnvironmentId) {
      history.pushState(null, '', '/vccenv/' + store.activeEnvironmentId);
    }
  };
  win.navigate = (path: string, replace = false) => {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    handleRoute();
  };

  // Session management
  win.newSession = async () => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;
    const proj = store.projects.find(p => p.id === store.activeProjectId);
    if (!proj) return;

    try {
      setPendingAgentCreation(true);
      const result = await api('POST', '/api/agent-sessions', {
        agentType: 'claude-code',
        cwd: proj.worktreePath || proj.path,
        skipPermissions: true,
      });
      setPendingAgentCreation(false);

      const sessionId = result.sessionId;
      const existing = proj.sessions.find(s => s.id === sessionId);
      if (existing) {
        connectAgentWs(sessionId);
        return;
      }
      const session = {
        id: sessionId,
        title: 'New session',
        status: 'waiting' as const,
        startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        messages: [],
        lastMessage: '',
        viewMode: 'chat' as const,
        permissionMode: result.mode || 'bypassPermissions',
        model: result.model || null,
        _capabilities: result.capabilities,
      };
      store.updateProject(proj.id, p => ({
        ...p,
        sessions: [...p.sessions, session],
        activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
      }));
      store.setActiveTabType('session');
      connectAgentWs(sessionId);
      store.addToast(proj.name, 'New session created', 'success');
    } catch (e: any) {
      setPendingAgentCreation(false);
      // Fallback to legacy
      try {
        const result = await api('POST', '/api/sessions', { cwd: proj.path, skip_permissions: true });
        const session = {
          id: result.id,
          title: result.title || 'New session',
          status: 'waiting' as const,
          startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          messages: [],
          lastMessage: '',
          viewMode: 'chat' as const,
          permissionMode: result.permission_mode || 'bypassPermissions',
          model: result.model || null,
        };
        store.updateProject(proj.id, p => ({
          ...p,
          sessions: [...p.sessions, session],
          activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
        }));
        store.setActiveTabType('session');
        connectSessionWs(session.id);
        store.addToast(proj.name, 'New session created', 'success');
      } catch (e2: any) {
        store.addToast(proj.name, `Failed: ${e2.message}`, 'attention');
      }
    }
  };

  win.switchToSession = (projId: string, idx: number) => {
    const store = useStore.getState();
    store.setActiveTabType('session');
    store.updateProject(projId, p => ({ ...p, activeSessionIdx: idx }));
  };

  win.switchToTerminal = (projId: string, idx: number) => {
    const store = useStore.getState();
    store.setActiveTabType('terminal');
    store.updateProject(projId, p => ({ ...p, activeTerminalIdx: idx }));
  };

  win.addTerminal = async () => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;
    const proj = store.projects.find(p => p.id === store.activeProjectId);
    if (!proj) return;
    try {
      const result = await api('POST', '/api/terminals', { cwd: proj.worktreePath || proj.path });
      const termId = `shell-${result.id}`;
      if (proj.terminals.find(x => x.shellId === result.id)) return;
      store.updateProject(proj.id, p => ({
        ...p,
        terminals: [...p.terminals, { id: termId, name: `bash-${p.terminals.length}`, shellId: result.id }],
        activeTerminalIdx: p.terminals.length,
      }));
      store.setActiveTabType('terminal');
    } catch (e: any) {
      store.addToast(proj.name, `Failed to create terminal: ${e.message}`, 'attention');
    }
  };

  // Git actions
  win.gitCommit = () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    store.setModal({
      type: 'input',
      props: {
        title: 'Commit',
        placeholder: 'Enter commit message...',
        confirmLabel: 'Commit',
        inputType: 'textarea',
        onConfirm: async (message: string) => {
          try {
            await api('POST', `/api/projects/${proj.id}/git/commit`, { message });
            await refreshGitData(proj.id);
            store.addToast(proj.name, 'Committed', 'success');
          } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
        },
      },
    });
  };

  win.gitPush = async () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    try {
      await api('POST', `/api/projects/${proj.id}/git/push`);
      store.addToast(proj.name, 'Pushed to remote', 'success');
    } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  win.gitRevertAll = () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    store.setModal({
      type: 'confirm',
      props: {
        title: 'Revert all changes',
        message: 'Revert ALL changes? This cannot be undone.',
        confirmLabel: 'Revert All',
        danger: true,
        onConfirm: async () => {
          try {
            await api('POST', `/api/projects/${proj.id}/git/revert`, {});
            await refreshGitData(proj.id);
            store.updateProject(proj.id, p => ({ ...p, _filesLoaded: false }));
            await selectProject(proj.id);
            store.addToast(proj.name, 'Reverted all changes', 'info');
          } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
        },
      },
    });
  };

  win.gitStashAll = async () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    try {
      await api('POST', `/api/projects/${proj.id}/git/stash`);
      await refreshGitData(proj.id);
      store.updateProject(proj.id, p => ({ ...p, _filesLoaded: false }));
      await selectProject(proj.id);
      store.addToast(proj.name, 'Stashed changes', 'success');
    } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  win.applyStash = async (id: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    try {
      await api('POST', `/api/projects/${proj.id}/git/stash/apply`, { id });
      await refreshGitData(proj.id);
      store.updateProject(proj.id, p => ({ ...p, _filesLoaded: false }));
      await selectProject(proj.id);
      store.addToast(proj.name, `Applied ${id}`, 'success');
    } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  win.dropStash = async (id: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    try {
      await api('POST', `/api/projects/${proj.id}/git/stash/drop`, { id });
      await refreshGitData(proj.id);
      store.addToast(proj.name, `Dropped ${id}`, 'info');
    } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  win.switchGitBranch = async (branch: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    try {
      await api('POST', `/api/projects/${proj.id}/git/checkout`, { branch });
      await refreshGitData(proj.id);
      store.addToast(proj.name, `Switched to ${branch}`, 'info');
    } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  win.createBranch = () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    store.setModal({
      type: 'input',
      props: {
        title: 'New Branch',
        placeholder: 'Branch name...',
        confirmLabel: 'Create',
        onConfirm: async (name: string) => {
          try {
            await api('POST', `/api/projects/${proj.id}/git/branch`, { name });
            await refreshGitData(proj.id);
            store.addToast(proj.name, `Created ${name}`, 'success');
          } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
        },
      },
    });
  };

  win.fetchRemote = async () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    try {
      await api('POST', `/api/projects/${proj.id}/git/fetch`);
      await refreshGitData(proj.id);
      store.addToast(proj.name, 'Fetched from remotes', 'success');
    } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  win.getWorktrees = async () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj?.isGit) return [];
    try {
      return await api('GET', `/api/projects/${proj.id}/git/worktrees`);
    } catch { return []; }
  };

  win.createWorktree = async () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj?.isGit) return;
    const branches = (proj.gitLog?.branches || []).filter((b: string) => !b.startsWith('remotes/'));
    let usedBranches: string[] = [];
    try {
      const wts = await api('GET', `/api/projects/${proj.id}/git/worktrees`);
      usedBranches = (wts || []).map((w: any) => w.branch).filter(Boolean);
    } catch {}
    store.setModal({
      type: 'worktree',
      props: {
        branches,
        usedBranches,
        projectPath: proj.path,
        onConfirm: async (wtPath: string, branch: string, isNewBranch: boolean) => {
          try {
            await api('POST', `/api/projects/${proj.id}/git/worktrees`, { path: wtPath, branch, newBranch: isNewBranch });
            await refreshGitData(proj.id);
            store.addToast(proj.name, `Created worktree at ${wtPath}`, 'success');
          } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
        },
      },
    });
  };

  win.removeWorktree = async (wtPath: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj?.isGit) return;
    // If we're in the worktree being removed, close it first
    if (proj.worktreePath === wtPath) {
      store.updateProject(proj.id, p => ({ ...p, worktreePath: null, worktreeParentBranch: null, _filesLoaded: false, _gitLoaded: false }));
    }
    try {
      await api('DELETE', `/api/projects/${proj.id}/git/worktrees?path=${encodeURIComponent(wtPath)}`);
      await refreshGitData(proj.id);
      // Reload files if we were in the removed worktree
      if (proj.worktreePath === wtPath) await selectProject(proj.id);
      store.addToast(proj.name, `Removed worktree`, 'info');
    } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
  };

  win.switchWorktree = async (wtPath: string, wtBranch: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    const parentBranch = proj.gitLog?.currentBranch || 'main';
    store.updateProject(proj.id, p => ({
      ...p,
      worktreePath: wtPath,
      worktreeParentBranch: parentBranch,
      _filesLoaded: false,
      _gitLoaded: false,
    }));
    // Reload project data with worktree path
    await selectProject(proj.id);
    store.addToast(proj.name, `Switched to worktree: ${wtBranch}`, 'info');
  };

  win.closeWorktree = async () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj?.worktreePath) return;
    store.updateProject(proj.id, p => ({
      ...p,
      worktreePath: null,
      worktreeParentBranch: null,
      _filesLoaded: false,
      _gitLoaded: false,
    }));
    await selectProject(proj.id);
    store.addToast(proj.name, `Returned to main project`, 'info');
  };

  // File editor
  win.openFileInEditor = async (filePath: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;

    let files = [...store.openFiles];
    let idx = files.findIndex(f => f.path === filePath);
    if (idx >= 0) {
      store.setActiveFileIdx(idx);
    } else {
      const fullPath = (proj.worktreePath || proj.path) + '/' + filePath;
      try {
        const gitMap: Record<string, string> = {};
        (proj.gitChanges || []).forEach(c => { gitMap[c.file] = c.status; });
        const gitStatus = gitMap[filePath] || '';
        const isDeleted = gitStatus === 'D';
        const isUntracked = gitStatus === '??';
        const isGitModified = !!gitStatus && !isDeleted && !isUntracked;

        let content: string;
        let originalContent: string;
        let lang: string;

        if (isDeleted && proj.isGit) {
          // Deleted file: fetch content from last commit
          const headData = await api('GET', `/api/projects/${proj.id}/git/show?file=${encodeURIComponent(filePath)}`);
          content = headData.content;
          originalContent = content;
          lang = getMonacoLang(filePath);
        } else {
          const data = await api('GET', `/api/files?path=${encodeURIComponent(fullPath)}`);
          content = data.content;
          originalContent = data.content;
          lang = data.lang || getMonacoLang(filePath);

          // For git-modified files (not untracked), fetch HEAD version for diff
          if (isGitModified && proj.isGit) {
            try {
              const headData = await api('GET', `/api/projects/${proj.id}/git/show?file=${encodeURIComponent(filePath)}`);
              originalContent = headData.content;
            } catch {}
          }
        }

        files.push({
          path: filePath, fullPath, content, originalContent,
          isModified: isGitModified, lang, viewMode: 'source',
          _gitStatus: gitStatus || undefined,
        });
        idx = files.length - 1;
        store.setOpenFiles(files);
        store.setActiveFileIdx(idx);
      } catch (e: any) {
        store.addToast(proj.name, `Failed to open: ${e.message}`, 'attention');
        return;
      }
    }
  };

  // Control responses
  win.approveControl = async (sessionId: string) => {
    const store = useStore.getState();
    let requestId: string | undefined;
    const projects = store.projects.map(proj => ({
      ...proj,
      sessions: proj.sessions.map(s => {
        if (s.id !== sessionId) return s;
        const msgs = [...s.messages];
        const lastCtrl = [...msgs].reverse().find(m => m.role === 'control_request' && !m._responded);
        if (lastCtrl) {
          lastCtrl._responded = true;
          requestId = lastCtrl._requestId;
        }
        return { ...s, messages: msgs };
      }),
    }));
    useStore.setState({ projects });

    if (requestId && sendAgentCommand(sessionId, { action: 'approve', requestId })) {
      // OK
    } else {
      try { await api('POST', `/api/sessions/${sessionId}/control-response`, { permission: 'allow' }); } catch {}
    }
  };

  win.denyControl = async (sessionId: string) => {
    const store = useStore.getState();
    let requestId: string | undefined;
    const projects = store.projects.map(proj => ({
      ...proj,
      sessions: proj.sessions.map(s => {
        if (s.id !== sessionId) return s;
        const msgs = [...s.messages];
        const lastCtrl = [...msgs].reverse().find(m => m.role === 'control_request' && !m._responded);
        if (lastCtrl) {
          lastCtrl._responded = true;
          requestId = lastCtrl._requestId;
        }
        return { ...s, messages: msgs };
      }),
    }));
    useStore.setState({ projects });

    if (requestId && sendAgentCommand(sessionId, { action: 'deny', requestId })) {
      // OK
    } else {
      try { await api('POST', `/api/sessions/${sessionId}/control-response`, { permission: 'deny' }); } catch {}
    }
  };

  win.submitQuestion = async (uuid: string, sessionId: string) => {
    const store = useStore.getState();
    const answers = store.questionAnswers[uuid] || {};
    const cleanAnswers: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers)) {
      if (!k.startsWith('_custom')) cleanAnswers[k] = v;
    }

    // Mark as responded
    const projects = store.projects.map(proj => ({
      ...proj,
      sessions: proj.sessions.map(s => ({
        ...s,
        messages: s.messages.map(m =>
          m._eventUuid === uuid && m.role === 'control_request' ? { ...m, _responded: true } : m
        ),
      })),
    }));
    useStore.setState({ projects });

    let requestId: string | undefined;
    for (const proj of store.projects) {
      const sess = proj.sessions.find(s => s.id === sessionId);
      if (sess) {
        const msg = sess.messages.find(m => m._eventUuid === uuid);
        if (msg) requestId = msg._requestId;
      }
    }

    if (requestId && sendAgentCommand(sessionId, { action: 'answer_question', requestId, answers: cleanAnswers })) {
      // OK
    } else {
      try { await api('POST', `/api/sessions/${sessionId}/control-response`, { permission: 'allow', updatedInput: { answers: cleanAnswers } }); } catch {}
    }
  };

  win.skipQuestion = async (uuid: string, sessionId: string) => {
    // Mark responded
    const store = useStore.getState();
    const projects = store.projects.map(proj => ({
      ...proj,
      sessions: proj.sessions.map(s => ({
        ...s,
        messages: s.messages.map(m =>
          m._eventUuid === uuid && m.role === 'control_request' ? { ...m, _responded: true } : m
        ),
      })),
    }));
    useStore.setState({ projects });

    let requestId: string | undefined;
    for (const proj of store.projects) {
      const sess = proj.sessions.find(s => s.id === sessionId);
      if (sess) {
        const msg = sess.messages.find(m => m._eventUuid === uuid);
        if (msg) requestId = msg._requestId;
      }
    }

    if (requestId && sendAgentCommand(sessionId, { action: 'deny', requestId })) {
      // OK
    } else {
      try { await api('POST', `/api/sessions/${sessionId}/control-response`, { permission: 'deny' }); } catch {}
    }
  };

  win.updateSessionMode = (value: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    const active = proj.sessions.filter(s => s.status !== 'ended');
    const session = active[proj.activeSessionIdx || 0];
    if (!session) return;
    store.updateProject(proj.id, p => ({
      ...p,
      sessions: p.sessions.map(s => s.id === session.id ? { ...s, permissionMode: value } : s),
    }));
    if (!sendAgentCommand(session.id, { action: 'set_mode', mode: value })) {
      api('POST', `/api/sessions/${session.id}/set-mode`, { mode: value }).catch(() => {});
    }
  };

  win.updateSessionModel = (value: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    const active = proj.sessions.filter(s => s.status !== 'ended');
    const session = active[proj.activeSessionIdx || 0];
    if (!session) return;
    store.updateProject(proj.id, p => ({
      ...p,
      sessions: p.sessions.map(s => s.id === session.id ? { ...s, model: value } : s),
    }));
    if (sendAgentCommand(session.id, { action: 'set_model', model: value })) {
      // agent handles it
    } else {
      const ws = getSessionWs(session.id);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'set_model', model: value } }));
      }
      setTimeout(() => { api('POST', `/api/sessions/${session.id}/refresh-context`).catch(() => {}); }, 1000);
    }
  };

  win.setSessionView = (mode: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    const active = proj.sessions.filter(s => s.status !== 'ended');
    const session = active[proj.activeSessionIdx || 0];
    if (!session) return;
    store.updateProject(proj.id, p => ({
      ...p,
      sessions: p.sessions.map(s => s.id === session.id ? { ...s, viewMode: mode as any } : s),
    }));
  };

  win.toggleVerbose = () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    const active = proj.sessions.filter(s => s.status !== 'ended');
    const session = active[proj.activeSessionIdx || 0];
    if (!session) return;
    store.updateProject(proj.id, p => ({
      ...p,
      sessions: p.sessions.map(s => s.id === session.id ? { ...s, showVerbose: !(s.showVerbose !== false) } : s),
    }));
  };

  win.togglePreviewPanel = () => {
    const store = useStore.getState();
    const newVisible = !store.previewVisible;
    store.setPreviewVisible(newVisible);
    if (newVisible && store.previewTabs.length === 0) {
      store.setPreviewTabs([{ id: 'pv-' + Date.now(), url: '', label: 'New tab' }]);
    }
  };

  win.resumeSession = async (projId: string, sessionId: string) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projId);
    if (!proj) return;
    const session = proj.sessions.find(s => s.id === sessionId);
    if (!session) return;
    if (session.status === 'running' || session.status === 'waiting') {
      const idx = proj.sessions.filter(s => s.status !== 'ended').indexOf(session);
      if (idx >= 0) win.switchToSession(projId, idx);
      return;
    }
    try {
      setPendingAgentCreation(true);
      const result = await api('POST', '/api/agent-sessions/resume', { sessionUuid: sessionId, cwd: proj.worktreePath || proj.path, skipPermissions: true });
      setPendingAgentCreation(false);
      const newSessionId = result.sessionId;
      const newSession = {
        id: newSessionId, title: session.title || 'Resumed session', status: 'waiting' as const,
        startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        messages: [], lastMessage: '', viewMode: 'chat' as const,
        permissionMode: result.mode || 'bypassPermissions', model: result.model || null, _capabilities: result.capabilities,
      };
      store.updateProject(projId, p => ({
        ...p,
        sessions: [...p.sessions.filter(s => s.id !== newSessionId), newSession],
        activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
      }));
      store.setActiveTabType('session');
      connectAgentWs(newSessionId);
      store.addToast(proj.name, 'Session resumed', 'success');
    } catch (e: any) {
      setPendingAgentCreation(false);
      store.addToast(proj.name, `Failed to resume: ${e.message}`, 'attention');
    }
  };

  win.resumeHistoricalSession = async (projId: string, sessionUuid: string) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projId);
    if (!proj) return;
    try {
      setPendingAgentCreation(true);
      const result = await api('POST', '/api/agent-sessions/resume', { sessionUuid, cwd: proj.worktreePath || proj.path, skipPermissions: true });
      setPendingAgentCreation(false);
      const sessionId = result.sessionId;
      const histEntry = (proj.historicalSessions || []).find(h => h.id === sessionUuid);
      const session = {
        id: sessionId, title: histEntry?.title || result.title || 'Resumed session', status: 'waiting' as const,
        startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        messages: [], lastMessage: '', viewMode: 'chat' as const,
        permissionMode: result.mode || 'bypassPermissions', model: result.model || null, _capabilities: result.capabilities,
      };
      store.updateProject(projId, p => ({
        ...p,
        sessions: [...p.sessions.filter(s => s.id !== sessionId), session],
        historicalSessions: (p.historicalSessions || []).filter(h => h.id !== sessionUuid),
        activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
      }));
      store.setActiveTabType('session');
      connectAgentWs(sessionId);
      store.addToast(proj.name, 'Session resumed', 'success');
    } catch (e: any) {
      setPendingAgentCreation(false);
      store.addToast(proj.name, `Failed to resume: ${e.message}`, 'attention');
    }
  };

  // Modals and context menus — keep as simple DOM manipulation for now
  win.showNewProjectModal = () => useStore.getState().setModal({ type: 'new-project' });
  win.showOpenProjectModal = () => useStore.getState().setModal({ type: 'open-project' });
  win.showConnectProjectModal = () => useStore.getState().setModal({ type: 'connect-project' });
  win.showSshProjectModal = () => useStore.getState().setModal({ type: 'ssh-project' });
  win.createEnvironmentFromStart = createEnvironmentFromStart;
  win.createEnvironmentFromDropdown = createEnvironmentFromDropdown;
  win.showCtxMenu = buildFileCtxMenu;
  win.deleteFileOrFolder = (filePath: string, isDir: boolean) => {
    const proj = useStore.getState().getActiveProject();
    if (proj) ctxDelete(filePath, proj, isDir);
  };
  win.showCommitCtxMenu = buildCommitCtxMenu;
  win.showCommitInfoModal = (hash: string) => useStore.getState().setModal({ type: 'commit-info', props: { hash } });
  win.openRemoteManager = () => useStore.getState().setModal({ type: 'remote-manager' });
  win.closeModal = () => useStore.getState().setModal(null);

  // Drag & drop for file tree (exposed for FileTree.tsx)
  win.dragStart = onDragStart;
  win.dragEnd = onDragEnd;
  win.dragOverItem = onDragOverItem;
  win.dragLeaveItem = onDragLeaveItem;
  win.dropItem = onDropItem;
  win.dropRoot = onDropRoot;

  // Speech recognition
  win.toggleSpeech = toggleSpeech;
  win.showLangPicker = showLangPicker;

  // Folder browser is now a React component (FolderBrowser.tsx) used inside ProjectModal

  // Session loading overlay
  win.showSessionLoadingOverlay = (label = 'Starting session...') => useStore.getState().setSessionLoading(label);
  win.removeSessionLoadingOverlay = () => useStore.getState().setSessionLoading(null);

  // Terminal cleanup
  win.destroyTerminal = destroyTerminal;

  // Settings persistence
  win.flushProjectSettings = flushProjectSettings;

  // Splitter drags (keep as imperative for performance)
  win.startLpSplitterDrag = startLpSplitterDrag;
  win.startEditorSplitterDrag = startEditorSplitterDrag;
  win.startSidebarSplitDrag = startSidebarSplitDrag;
  win.startVSplitDrag = startVSplitDrag;

  // xterm.js terminal
  win.attachXterm = attachXterm;
}

// Splitter functions (imperative, kept as-is for performance)
function startLpSplitterDrag(e: MouseEvent) {
  e.preventDefault();
  const splitter = document.getElementById('lp-splitter');
  const historyPanel = document.getElementById('git-history-panel');
  const leftPanel = historyPanel?.closest('.left-panel');
  if (!splitter || !historyPanel || !leftPanel) return;
  splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = historyPanel.offsetHeight;
  const totalH = (leftPanel as HTMLElement).offsetHeight;
  const onMove = (ev: MouseEvent) => { historyPanel.style.height = Math.max(80, Math.min(totalH - 150, startH + (startY - ev.clientY))) + 'px'; };
  const onUp = () => { splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startEditorSplitterDrag(e: MouseEvent) {
  e.preventDefault();
  const splitter = document.getElementById('editor-splitter');
  const editorArea = document.getElementById('editor-area');
  const centerPanel = editorArea?.closest('.center-panel');
  if (!splitter || !editorArea || !centerPanel) return;
  splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = editorArea.offsetHeight;
  const totalH = (centerPanel as HTMLElement).offsetHeight;
  const onMove = (ev: MouseEvent) => { editorArea.style.height = Math.max(80, Math.min(totalH - 120, startH + (ev.clientY - startY))) + 'px'; };
  const onUp = () => { splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startSidebarSplitDrag(e: MouseEvent) {
  e.preventDefault();
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  if (!app || !sidebar) return;
  const startX = e.clientX;
  const startW = sidebar.offsetWidth;
  const onMove = (ev: MouseEvent) => { app.style.setProperty('--sidebar-w', Math.max(160, Math.min(400, startW + (ev.clientX - startX))) + 'px'); };
  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startVSplitDrag(e: MouseEvent, side: string) {
  e.preventDefault();
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  if (side === 'left') {
    const lp = workspace.querySelector('.left-panel') as HTMLElement;
    const startX = e.clientX, startW = lp.offsetWidth;
    const onMove = (ev: MouseEvent) => { workspace.style.setProperty('--lp-width', Math.max(140, Math.min(500, startW + (ev.clientX - startX))) + 'px'); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  } else if (side === 'right') {
    const rp = document.getElementById('right-panel');
    if (!rp || rp.classList.contains('collapsed')) return;
    const startX = e.clientX, startW = rp.offsetWidth;
    const onMove = (ev: MouseEvent) => { workspace.style.setProperty('--rp-width', Math.max(140, Math.min(500, startW + (startX - ev.clientX))) + 'px'); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  } else {
    const pp = document.getElementById('preview-panel');
    if (!pp) return;
    const startX = e.clientX, startW = pp.offsetWidth;
    const onMove = (ev: MouseEvent) => { const maxW = workspace.offsetWidth - 200; workspace.style.setProperty('--pp-width', Math.max(200, Math.min(maxW, startW + (startX - ev.clientX))) + 'px'); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }
}

async function refreshGitData(projectId: string) {
  const proj = useStore.getState().projects.find(p => p.id === projectId);
  if (!proj) return;
  const cwdParam = proj.worktreePath ? `?cwd=${encodeURIComponent(proj.worktreePath)}` : '';
  try {
    const [status, branches, stashes, log] = await Promise.all([
      api('GET', `/api/projects/${proj.id}/git/status${cwdParam}`),
      api('GET', `/api/projects/${proj.id}/git/branches${cwdParam}`),
      api('GET', `/api/projects/${proj.id}/git/stash${cwdParam}`),
      api('GET', `/api/projects/${proj.id}/git/log${cwdParam}`).catch(() => []),
    ]);
    useStore.getState().updateProject(proj.id, p => ({
      ...p,
      gitChanges: status,
      gitLog: {
        ...p.gitLog,
        branches: branches.branches,
        currentBranch: branches.currentBranch,
        commits: log.map((c: any, i: number) => ({
          ...c,
          refs: i === 0 ? [{ type: 'head', label: 'HEAD' }, { type: 'branch', label: branches.currentBranch }] : [],
        })),
      },
      stashes,
    }));
  } catch {}
}

// xterm.js terminal support
let xtermModule: any = null;
let fitAddonModule: any = null;
const terminalInstances: Record<string, any> = {};

async function loadXterm() {
  if (xtermModule) return;
  const [xterm, fit] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  xtermModule = xterm;
  fitAddonModule = fit;
}

function attachXterm(termId: string, targetId: string, container: HTMLElement, wsType = 'terminal') {
  if (terminalInstances[termId]) {
    const inst = terminalInstances[termId];
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
        background: '#0a0b0f', foreground: '#e0e0e0', cursor: '#5b8af5',
        selectionBackground: '#5b8af53a',
        black: '#1a1b25', brightBlack: '#3a3d52', blue: '#5b8af5', brightBlue: '#7ba4ff',
        cyan: '#5bbeaf', brightCyan: '#7dd8c9', green: '#59a86e', brightGreen: '#7bc48e',
        magenta: '#b07ee0', brightMagenta: '#c89ef0', red: '#e05555', brightRed: '#ff7777',
        white: '#e0e0e0', brightWhite: '#ffffff', yellow: '#d4a843', brightYellow: '#f0c060',
      },
      fontFamily: 'JetBrains Mono, monospace', fontSize: 13, cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsPath = wsType === 'shell' ? 'shell' : 'terminal';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${wsPath}/${targetId}`);

    ws.onopen = () => { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
    ws.onmessage = (e: any) => { try { const msg = JSON.parse(e.data); if (msg.type === 'output' && msg.data) term.write(msg.data); } catch {} };
    ws.onclose = () => { term.write('\r\n\x1b[90m[terminal disconnected]\x1b[0m\r\n'); };
    term.onData((data: string) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data })); });
    term.onResize(({ cols, rows }: any) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });

    const resizeHandler = () => fitAddon.fit();
    window.addEventListener('resize', resizeHandler);
    terminalInstances[termId] = { term, fitAddon, ws, el, container, resizeHandler };
    setTimeout(() => fitAddon.fit(), 100);
  }).catch((err: any) => {
    container.innerHTML = `<div style="color:var(--text-muted);padding:12px;font-size:12px">Failed to load terminal: ${err.message}</div>`;
  });
}

// Context menu builders — create store-driven menus
function buildFileCtxMenu(e: MouseEvent, filePath: string, fileType: string) {
  e.preventDefault();
  e.stopPropagation();
  const store = useStore.getState();
  const proj = store.getActiveProject();
  const isDir = fileType === 'dir';

  const gitMap: Record<string, string> = {};
  const stagedMap: Record<string, boolean> = {};
  (proj?.gitChanges || []).forEach((c: any) => { gitMap[c.file] = c.status; if (c.staged) stagedMap[c.file] = true; });
  const gitStatus = gitMap[filePath] || '';
  const isStaged = stagedMap[filePath] || false;

  const isDeleted = gitStatus === 'D';
  const items: any[] = [];
  if (!isDir) items.push({ label: 'Open', icon: '◇', action: () => (window as any).openFileInEditor(filePath) });
  items.push({ label: 'Copy Path', icon: '⊡', action: () => {
    navigator.clipboard?.writeText(proj ? (proj.worktreePath || proj.path) + '/' + filePath : filePath);
    store.addToast(proj?.name || '', 'Path copied', 'info');
  }});
  if (!isDeleted) {
    items.push({ separator: true, label: '', icon: '', action: () => {} });
    items.push({ label: 'Rename', icon: '✎', action: () => ctxRename(filePath, proj) });
    items.push({ label: 'Delete', icon: '✕', danger: true, action: () => ctxDelete(filePath, proj, isDir) });
  }
  if (proj?.isGit && gitStatus) {
    items.push({ separator: true, label: '', icon: '', action: () => {} });
    items.push({ groupLabel: 'Git', label: '', icon: '', action: () => {} });
    items.push({ label: 'Revert Changes', icon: '⟲', action: () => ctxRevertFile(filePath, proj) });
    if (isStaged) {
      items.push({ label: 'Unstage File', icon: '−', action: () => ctxUnstageFile(filePath, proj) });
    } else {
      items.push({ label: 'Stage File', icon: '+', action: () => ctxStageFile(filePath, proj) });
    }
  }
  if (isDir) {
    items.push({ separator: true, label: '', icon: '', action: () => {} });
    items.push({ label: 'New File', icon: '+', action: () => ctxNewFile(filePath, proj) });
    items.push({ label: 'New Folder', icon: '+', action: () => ctxNewFolder(filePath, proj) });
  }

  store.setCtxMenu({ x: e.clientX, y: e.clientY, items });
}

function buildCommitCtxMenu(e: MouseEvent, hash: string) {
  e.preventDefault();
  e.stopPropagation();
  const store = useStore.getState();
  store.setCtxMenu({
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Copy Hash', icon: '⊡', action: () => {
        navigator.clipboard?.writeText(hash);
        store.addToast('', 'Hash copied', 'info');
      }},
      { label: 'View Details', icon: '◇', action: () => {
        store.setModal({ type: 'commit-info', props: { hash } });
      }},
    ],
  });
}

// File context menu action helpers
function ctxRename(filePath: string, proj: any) {
  if (!proj) return;
  const store = useStore.getState();
  const oldName = filePath.split('/').pop() || '';
  store.setModal({
    type: 'input',
    props: {
      title: 'Rename',
      placeholder: 'New name...',
      defaultValue: oldName,
      confirmLabel: 'Rename',
      onConfirm: async (newName: string) => {
        if (newName === oldName) return;
        const parts = filePath.split('/'); parts.pop();
        const dir = parts.join('/');
        const effPath = proj.worktreePath || proj.path;
        const fromFull = effPath + '/' + filePath;
        const toFull = effPath + '/' + (dir ? dir + '/' : '') + newName;
        try {
          await api('POST', '/api/files/rename', { from: fromFull, to: toFull });
          store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
          await selectProject(proj.id);
          store.addToast(proj.name, `Renamed ${oldName} → ${newName}`, 'info');
        } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
      },
    },
  });
}

function ctxDelete(filePath: string, proj: any, isDir = false) {
  if (!proj) return;
  const store = useStore.getState();
  const name = filePath.split('/').pop();
  store.setModal({
    type: 'confirm',
    props: {
      title: `Delete ${isDir ? 'folder' : 'file'}`,
      message: `Are you sure you want to delete "${name}"?${isDir ? ' This will delete all contents inside it.' : ''}`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api('DELETE', `/api/files?path=${encodeURIComponent((proj.worktreePath || proj.path) + '/' + filePath)}`);
          // Close the file if it's open in editor
          const s = useStore.getState();
          const openIdx = s.openFiles.findIndex((f: any) => f.path === filePath);
          if (openIdx >= 0 && !proj.isGit) {
            const newFiles = s.openFiles.filter((_: any, i: number) => i !== openIdx);
            s.setOpenFiles(newFiles);
            if (s.activeFileIdx >= newFiles.length) s.setActiveFileIdx(newFiles.length - 1);
          }
          if (proj.isGit) {
            await refreshGitData(proj.id);
          }
          // Refresh file tree
          try {
            const files = await api('GET', `/api/projects/${proj.id}/files`);
            useStore.getState().updateProject(proj.id, (p: any) => ({ ...p, files }));
          } catch {}
          store.addToast(proj.name, `Deleted ${name}`, 'info');
        } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
      },
    },
  });
}

async function ctxRevertFile(filePath: string, proj: any) {
  if (!proj) return;
  const store = useStore.getState();
  try {
    await api('POST', `/api/projects/${proj.id}/git/revert`, { file: filePath });
    await refreshGitData(proj.id);
    store.addToast(proj.name, `Reverted ${filePath.split('/').pop()}`, 'info');
  } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
}

async function ctxStageFile(filePath: string, proj: any) {
  if (!proj) return;
  const store = useStore.getState();
  try {
    await api('POST', `/api/projects/${proj.id}/git/stage`, { file: filePath });
    store.addToast(proj.name, `Staged ${filePath.split('/').pop()}`, 'success');
  } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
}

async function ctxUnstageFile(filePath: string, proj: any) {
  if (!proj) return;
  const store = useStore.getState();
  try {
    await api('POST', `/api/projects/${proj.id}/git/unstage`, { file: filePath });
    store.addToast(proj.name, `Unstaged ${filePath.split('/').pop()}`, 'success');
  } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
}

function ctxNewFile(dirPath: string, proj: any) {
  if (!proj) return;
  const store = useStore.getState();
  store.setModal({
    type: 'input',
    props: {
      title: 'New File',
      placeholder: 'File name...',
      confirmLabel: 'Create',
      onConfirm: async (name: string) => {
        try {
          await api('POST', '/api/files/create', { path: (proj.worktreePath || proj.path) + '/' + dirPath + '/' + name, type: 'file' });
          store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
          await selectProject(proj.id);
          store.addToast(proj.name, `Created ${name}`, 'success');
        } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
      },
    },
  });
}

function ctxNewFolder(dirPath: string, proj: any) {
  if (!proj) return;
  const store = useStore.getState();
  store.setModal({
    type: 'input',
    props: {
      title: 'New Folder',
      placeholder: 'Folder name...',
      confirmLabel: 'Create',
      onConfirm: async (name: string) => {
        try {
          await api('POST', '/api/files/create', { path: (proj.worktreePath || proj.path) + '/' + dirPath + '/' + name, type: 'dir' });
          store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
          await selectProject(proj.id);
          store.addToast(proj.name, `Created folder ${name}`, 'success');
        } catch (e: any) { store.addToast(proj.name, `Failed: ${e.message}`, 'attention'); }
      },
    },
  });
}

// Drag & drop for file tree
const dragState = { srcPath: null as string | null, srcType: null as string | null };

function onDragStart(srcPath: string, srcType: string, el: HTMLElement, dataTransfer: DataTransfer | null) {
  dragState.srcPath = srcPath;
  dragState.srcType = srcType;
  el.classList.add('dragging');
  if (dataTransfer) {
    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData('text/plain', srcPath);
  }
}

function onDragEnd() {
  document.querySelectorAll('.dragging, .drop-target, .drop-above, .drop-below, .drop-root').forEach(el => {
    el.classList.remove('dragging', 'drop-target', 'drop-above', 'drop-below', 'drop-root');
  });
  dragState.srcPath = null;
  dragState.srcType = null;
}

function onDragOverItem(targetPath: string, targetType: string, el: HTMLElement, e: { preventDefault: () => void; clientY: number; dataTransfer?: DataTransfer | null }) {
  e.preventDefault();
  if (!dragState.srcPath || targetPath === dragState.srcPath) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drop-target, .drop-above, .drop-below').forEach(x => x.classList.remove('drop-target', 'drop-above', 'drop-below'));
  if (targetType === 'dir') {
    el.classList.add('drop-target');
  } else {
    const rect = el.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) el.classList.add('drop-above');
    else el.classList.add('drop-below');
  }
}

function onDragLeaveItem(el: HTMLElement) {
  el.classList.remove('drop-target', 'drop-above', 'drop-below');
}

async function onDropItem(targetPath: string, targetType: string) {
  document.querySelectorAll('.drop-target, .drop-above, .drop-below').forEach(x => x.classList.remove('drop-target', 'drop-above', 'drop-below'));
  if (!dragState.srcPath || targetPath === dragState.srcPath) return;
  const store = useStore.getState();
  const proj = store.getActiveProject();
  if (!proj) return;
  const srcName = dragState.srcPath.split('/').pop();
  let destDir: string;
  if (targetType === 'dir') {
    destDir = targetPath;
  } else {
    const parts = targetPath.split('/'); parts.pop();
    destDir = parts.join('/');
  }
  const effPath = proj.worktreePath || proj.path;
  const fromFull = effPath + '/' + dragState.srcPath;
  const toFull = effPath + '/' + (destDir ? destDir + '/' : '') + srcName;
  try {
    await api('POST', '/api/files/move', { from: fromFull, to: toFull });
    store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
    await selectProject(proj.id);
    store.addToast(proj.name, `Moved ${srcName}`, 'info');
  } catch (e2: any) { store.addToast(proj.name, `Failed: ${e2.message}`, 'attention'); }
}

function onDropRoot() {
  if (!dragState.srcPath) return;
  const store = useStore.getState();
  const proj = store.getActiveProject();
  if (!proj) return;
  const srcName = dragState.srcPath.split('/').pop();
  const effPath2 = proj.worktreePath || proj.path;
  const fromFull = effPath2 + '/' + dragState.srcPath;
  const toFull = effPath2 + '/' + srcName;
  api('POST', '/api/files/move', { from: fromFull, to: toFull }).then(() => {
    store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
    selectProject(proj.id);
  }).catch(() => {});
}

// Speech recognition
let speechRecognition: any = null;
let isRecording = false;
let speechLang = localStorage.getItem('speechLang') || navigator.language || 'en-US';
let micLongPressTimer: any = null;
const SPEECH_LANGUAGES = [
  { code: 'en-US', label: 'English' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'es-ES', label: 'Español' },
  { code: 'zh-CN', label: '中文' },
];

function toggleSpeech() {
  if (micLongPressTimer === 'fired') return;
  const btn = document.getElementById('chat-mic-btn');
  if (isRecording) {
    if (speechRecognition) speechRecognition.stop();
    speechRecognition = null;
    isRecording = false;
    if (btn) btn.classList.remove('recording');
    return;
  }
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) { alert('Speech recognition is not supported in this browser.'); return; }
  const rec = new SpeechRecognition();
  rec.continuous = true; rec.interimResults = true; rec.lang = speechLang;
  rec.onresult = (event: any) => {
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    if (!input) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const transcript = event.results[i][0].transcript.trim();
        if (transcript) { input.value = input.value ? input.value + ' ' + transcript : transcript; input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; }
      }
    }
  };
  rec.onerror = () => { speechRecognition = null; isRecording = false; if (btn) btn.classList.remove('recording'); };
  rec.onend = () => { if (isRecording) { speechRecognition = null; isRecording = false; if (btn) btn.classList.remove('recording'); } };
  rec.start();
  speechRecognition = rec; isRecording = true;
  if (btn) btn.classList.add('recording');
}

function showLangPicker() {
  document.getElementById('mic-lang-picker')?.remove();
  const btn = document.getElementById('chat-mic-btn');
  if (!btn) return;
  const picker = document.createElement('div');
  picker.id = 'mic-lang-picker'; picker.className = 'mic-lang-picker';
  SPEECH_LANGUAGES.forEach(l => {
    const opt = document.createElement('button');
    opt.className = 'mic-lang-option' + (l.code === speechLang ? ' active' : '');
    opt.textContent = l.label;
    opt.onclick = (e) => { e.stopPropagation(); speechLang = l.code; localStorage.setItem('speechLang', l.code); picker.remove(); };
    picker.appendChild(opt);
  });
  btn.parentElement!.style.position = 'relative';
  btn.parentElement!.appendChild(picker);
  const close = (e: any) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('pointerdown', close); } };
  setTimeout(() => document.addEventListener('pointerdown', close), 0);
}

function createEnvironmentFromStart() {
  const store = useStore.getState();
  store.setModal({
    type: 'input',
    props: {
      title: 'New Environment',
      placeholder: 'Environment name...',
      confirmLabel: 'Create',
      onConfirm: async (name: string) => {
        try {
          const env = await api('POST', '/api/environments', { name });
          const s = useStore.getState();
          s.setEnvironments([...s.environments, env]);
          await selectEnvironment(env.id);
        } catch (e: any) {
          useStore.getState().addToast('Error', `Failed to create environment: ${e.message}`, 'attention');
        }
      },
    },
  });
}

function createEnvironmentFromDropdown() {
  const store = useStore.getState();
  store.setModal({
    type: 'input',
    props: {
      title: 'New Environment',
      placeholder: 'Environment name...',
      confirmLabel: 'Create',
      onConfirm: async (name: string) => {
        try {
          const env = await api('POST', '/api/environments', { name });
          const s = useStore.getState();
          s.setEnvironments([...s.environments, env]);
          await selectEnvironment(env.id);
        } catch (e: any) {
          useStore.getState().addToast('Error', `Failed to create environment: ${e.message}`, 'attention');
        }
      },
    },
  });
}

// All modals (ProjectModal, RemoteManager, CommitInfoModal, ConnectProjectModal,
// FolderBrowser, SessionLoadingOverlay) are now React components in components/Modals/.
// Context menus are rendered by ContextMenu.tsx driven by store.ctxMenu state.

// Terminal cleanup
function destroyTerminal(termId: string) {
  const inst = terminalInstances[termId];
  if (!inst) return;
  try { inst.ws?.close(); } catch {}
  try { inst.term?.dispose(); } catch {}
  window.removeEventListener('resize', inst.resizeHandler);
  delete terminalInstances[termId];
}

// Connect project workflow, modals, context menus, folder browser, session loading
// are now all React components in components/Modals/
