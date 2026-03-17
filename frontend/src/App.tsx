import React, { useEffect } from 'react';
import { useStore } from './state/store';
import { useAuthStore } from './state/auth-store';
import { api } from './api';
import { connectStatusWs, connectSettingsWs, connectAgentWs, sendAgentCommand, setPendingAgentCreation } from './api/websocket';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TopBar } from './components/TopBar/TopBar';
import { Overview } from './components/Overview/Overview';
import { Workspace } from './components/Layout/Workspace';
import { CarouselWorkspace } from './components/Layout/CarouselWorkspace';
import { NiriWorkspace } from './components/Layout/NiriWorkspace';
import { StartPage } from './components/Layout/StartPage';
import { ToastContainer } from './components/Layout/Toast';
import { ModalContainer } from './components/Modals/ModalContainer';
import { ContextMenu } from './components/Modals/ContextMenu';
import { SessionLoadingOverlay } from './components/Modals/SessionLoadingOverlay';
import { LoginPage } from './components/Auth/LoginPage';
import { SetupPage } from './components/Auth/SetupPage';
import { MobileApp } from './components/Mobile';
import { getMonacoLang, debounce, getServerIp, isRenderable, isImageFile } from './utils';

const MOBILE_BREAKPOINT = 768;
const IS_STANDALONE = window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone === true;

function useIsMobile() {
  const setIsMobileLayout = useStore(s => s.setIsMobileLayout);

  useEffect(() => {
    const check = () => {
      const isMobile = window.innerWidth <= MOBILE_BREAKPOINT ||
        /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobileLayout(isMobile);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [setIsMobileLayout]);

  return useStore(s => s.isMobileLayout);
}

function WorkspaceRouter() {
  const layout = useStore(s => s.workspaceLayout);
  if (layout === 'niri') return <NiriWorkspace />;
  if (layout === 'carousel') return <CarouselWorkspace />;
  return <Workspace />;
}

export function App() {
  const {
    activeProjectId, activeEnvironmentId, projects,
  } = useStore();
  const sidebarCollapsed = useStore(s => s.sidebarCollapsed);
  const { user, setupRequired, loading: authLoading, checkAuth } = useAuthStore();
  const isMobile = useIsMobile();

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!user) return;
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
  }, [user]);

  // Auth gate
  if (authLoading) {
    return <div className="auth-loading">Loading...</div>;
  }
  if (setupRequired) {
    return <SetupPage />;
  }
  if (!user) {
    return <LoginPage />;
  }

  // Mobile layout
  if (isMobile) {
    const showStart = !activeEnvironmentId;
    return (
      <>
        {showStart ? <StartPage /> : <MobileApp />}
        <ToastContainer />
        <ModalContainer />
        <ContextMenu />
      </>
    );
  }

  // Desktop layout
  const showStart = !activeEnvironmentId;
  const showOverview = activeEnvironmentId && !activeProjectId;
  const showWorkspace = activeEnvironmentId && activeProjectId;

  return (
    <>
      {showStart && <StartPage />}
      <div id="app" className={`${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${IS_STANDALONE ? 'standalone' : ''}`} style={{ display: showStart ? 'none' : '' }}>
        <Sidebar />
        <div className="sidebar-vsplit" id="sidebar-vsplit" onMouseDown={(e) => (window as any).startSidebarSplitDrag(e.nativeEvent)}></div>
        <TopBar />
        <div id="main">
          {showOverview && <Overview />}
          {showWorkspace && <WorkspaceRouter />}
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

  // 6. Request browser notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // 7. Listen for popstate
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

  const envMatch = path.match(/^\/env\/([^/]+)$/);
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
    const mappedProjects = projects.map((p: any) => ({
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
    store.setProjects(mappedProjects);

  } catch (e) {
    console.error('Failed to load projects for environment:', e);
    store.setProjects([]);
  }

  if (!fromRouter) {
    history.pushState(null, '', '/env/' + envId);
  }
}

async function reloadProjects() {
  const store = useStore.getState();
  if (!store.activeEnvironmentId) return;
  try {
    const projects = await api('GET', `/api/environments/${store.activeEnvironmentId}/projects`);
    const current = store.projects;
    const newProjects = projects.map((p: any) => {
      const existing = current.find(ep => ep.id === p.id);
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
    store.setProjects(newProjects);
    // If the active project was removed (e.g. deleted from another tab), select another
    if (store.activeProjectId && !newProjects.find((p: any) => p.id === store.activeProjectId)) {
      if (newProjects.length > 0) {
        selectProject(newProjects[0].id, newProjects[0].pe_id);
      } else {
        useStore.setState({ activeProjectId: null, activeProjectEnvironmentId: null, openFiles: [], activeFileIdx: -1 });
      }
    }
  } catch {}
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

  // Restore in-memory view state immediately (instant switch, no flicker)
  restoreProjectViewState(projectId);

  // Then load persisted settings from DB (overrides in-memory cache on first load or if DB is newer)
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

  const cwdParam = '';
  const rootPathParams = new URLSearchParams();
  if (useStore.getState().showHidden) rootPathParams.set('showHidden', 'true');
  const rootPathParam = rootPathParams.toString() ? `?${rootPathParams.toString()}` : '';

  // Lazy-load file tree (shallow — 1 level; subdirs expand on demand)
  if (!proj._filesLoaded) {
    try {
      const sep = rootPathParam ? '&' : '?';
      const files = await api('GET', `/api/projects/${proj.id}/files${rootPathParam}${sep}maxDepth=1`);
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
          refs: c.refs || [],
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

  // Always reload sessions + historical on project switch (sessions are per-project)
  {
    try {
      const [sessions, agentSessions] = await Promise.all([
        api('GET', `/api/projects/${proj.id}/sessions`),
        api('GET', '/api/agent-sessions').catch(() => []),
      ]);
      // Historical sessions can be slow (scans JSONL files on first load) — load in background
      const historicalPromise = api('GET', `/api/historical-sessions?cwd=${encodeURIComponent(proj.path)}`).catch(() => []);
      const historical: any[] = [];

      // Build a map of existing sessions to preserve messages/state
      const existingSessions = new Map(
        (useStore.getState().projects.find(p => p.id === projectId)?.sessions || []).map(s => [s.id, s])
      );

      const mappedSessions = sessions.map((s: any) => {
        const existing = existingSessions.get(s.id);
        return {
          id: s.id,
          title: s.title || 'Untitled',
          status: s.agent_status === 'active' ? 'active' : s.agent_status === 'attention' ? 'attention' : 'open',
          startedAt: new Date(s.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          messages: existing?.messages || [],
          lastMessage: existing?.lastMessage || '',
          viewMode: existing?.viewMode || 'chat',
          model: s.model || null,
          permissionMode: s.permission_mode || null,
          cwd: proj.path,
          // Preserve runtime state from existing session
          ...(existing ? {
            showVerbose: existing.showVerbose,
            linkedIssue: existing.linkedIssue,
            _agentInfo: existing._agentInfo,
            _capabilities: existing._capabilities,
            _pendingControl: existing._pendingControl,
            _filteredMessages: existing._filteredMessages,
            contextUsage: existing.contextUsage,
            contextInProgress: existing.contextInProgress,
          } : {}),
        };
      });

      // Merge running agent sessions (e.g. claude-code-terminal) that match this project
      const effectivePath = proj.path;
      const legacyIds = new Set(mappedSessions.map((s: any) => s.id));
      const matchingAgentSessions = agentSessions
        .filter((a: any) => a.cwd === effectivePath && !legacyIds.has(a.sessionId) && a.status !== 'exited')
        .map((a: any) => {
          const existing = existingSessions.get(a.sessionId);
          const bs = a.browserState || {};
          return {
            id: a.sessionId,
            title: existing?.title || bs.title || 'Terminal session',
            status: a.status === 'active' ? 'active' as const : a.status === 'attention' ? 'attention' as const : 'open' as const,
            startedAt: existing?.startedAt || new Date(a.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            messages: existing?.messages || [],
            lastMessage: existing?.lastMessage || '',
            viewMode: existing?.viewMode || bs.viewMode || (a.agentMode === 'terminal' ? 'tui' as const : 'chat' as const),
            agentType: a.agentType,
            agentMode: a.agentMode,
            model: a.model || null,
            permissionMode: a.mode || null,
            cwd: a.cwd,
            _capabilities: existing?._capabilities || a.capabilities,
            linkedIssue: existing?.linkedIssue || a.linkedIssue,
            ...(bs.metaName ? { metaName: bs.metaName } : {}),
            ...(bs.metaDescription ? { metaDescription: bs.metaDescription } : {}),
            ...(bs.tags?.length ? { tags: bs.tags } : {}),
            ...(existing ? {
              showVerbose: existing.showVerbose,
              metaName: existing.metaName,
              metaDescription: existing.metaDescription,
              tags: existing.tags,
              _agentInfo: existing._agentInfo,
              _pendingControl: existing._pendingControl,
              _filteredMessages: existing._filteredMessages,
              contextUsage: existing.contextUsage,
              contextInProgress: existing.contextInProgress,
            } : {
              showVerbose: bs.showVerbose,
            }),
          };
        });

      for (const s of matchingAgentSessions) {
        connectAgentWs(s.id);
      }

      const allSessions = [...mappedSessions, ...matchingAgentSessions];
      useStore.getState().updateProject(proj.id, p => ({
        ...p,
        sessions: allSessions,
        historicalSessions: [],
        _sessionsLoaded: true,
      }));

      // Merge historical sessions when they arrive (deferred to avoid blocking startup)
      historicalPromise.then((historical: any[]) => {
        const activeIds = new Set([...allSessions.map((s: any) => s.id)]);
        const historicalSessions = historical
          .filter((h: any) => !activeIds.has(h.id))
          .map((h: any) => ({
            id: h.id,
            agentType: h.agentType,
            title: h.title || 'Untitled',
            lastModified: h.lastModified,
            eventCount: h.eventCount,
            ...(h.metaName ? { metaName: h.metaName } : {}),
            ...(h.tags?.length ? { tags: h.tags } : {}),
          }));
        useStore.getState().updateProject(proj.id, p => ({
          ...p,
          historicalSessions,
        }));
      });

      // Fetch metadata for all active sessions (also updates matching historical sessions)
      const fetchedChains = new Set<string>();
      for (const s of allSessions) {
        if (fetchedChains.has(s.id)) continue;
        api('POST', '/api/mcp/get-metadata', { session_uuid: s.id, cwd: proj.path }).then((data: any) => {
          if (data.name || data.description || data.tags?.length) {
            const chainIds = data.chainSessionIds as string[] | undefined;
            if (chainIds) chainIds.forEach(id => fetchedChains.add(id));
            const metaPatch: Record<string, any> = {};
            if (data.name) metaPatch.metaName = data.name;
            if (data.description) metaPatch.metaDescription = data.description;
            if (data.tags?.length) metaPatch.tags = data.tags;
            useStore.getState().updateProject(proj.id, p => ({
              ...p,
              sessions: p.sessions.map(sess =>
                chainIds?.includes(sess.id) ? { ...sess, ...metaPatch } : sess
              ),
              historicalSessions: (p.historicalSessions || []).map(h =>
                chainIds?.includes(h.id) ? {
                  ...h,
                  ...(data.name ? { metaName: data.name } : {}),
                  ...(data.tags?.length ? { tags: data.tags } : {}),
                } : h
              ),
            }));
            // Push metadata to server cache for each matching agent session
            if (Object.keys(metaPatch).length) {
              const agentIds = (chainIds || []).filter(id => id.startsWith('agent_'));
              for (const aid of agentIds) {
                api('PATCH', `/api/agent-sessions/${aid}/browser-state`, metaPatch).catch(() => {});
              }
            }
          }
        }).catch(() => {});
      }
    } catch {}
  }

  // Lazy-load terminals
  if (!proj._terminalsLoaded) {
    try {
      const terminals = await api('GET', '/api/terminals');
      const projTerminals = terminals.filter((t: any) => t.projectPath === proj.path);
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
  // Always reset preview tabs to the saved value (or empty) to avoid leaking tabs from other projects
  store.setPreviewTabs(settings.preview_tabs || []);
  store.setPreviewActiveIdx(settings.preview_active_idx ?? 0);
  if (settings.rightPanelTab) store.setRightPanelTab(settings.rightPanelTab);
  if (settings.workspace_layout) store.setWorkspaceLayout(settings.workspace_layout);
  if (settings.niri_layout) store.setNiriLayout(settings.niri_layout);
  // previewMode removed (streaming only, no iframe)

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
    if (settings.rp_collapsed) {
      store.setRightPanelCollapsed(true);
      // Restore expanded width so uncollapsing works correctly
      if (settings.rp_expanded_width && workspace) workspace.style.setProperty('--rp-width', settings.rp_expanded_width);
    } else {
      store.setRightPanelCollapsed(false);
      if (settings.rp_width && workspace) workspace.style.setProperty('--rp-width', settings.rp_width);
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
    rp_expanded_width: (() => {
      if (!workspace) return '';
      const w = getComputedStyle(workspace).getPropertyValue('--rp-width').trim();
      const collapsed = rightPanel?.classList.contains('collapsed') || false;
      // If collapsed, keep the current CSS var (which should be the expanded width), otherwise use it directly
      return collapsed ? (w && parseInt(w) > 50 ? w : '300px') : w;
    })(),
    rp_collapsed: rightPanel?.classList.contains('collapsed') || false,
    pp_width: workspace ? getComputedStyle(workspace).getPropertyValue('--pp-width').trim() : '',
    git_history_height: document.getElementById('git-history-panel')?.style.height || '',
    file_filter: store.fileFilter,
    file_view: store.fileView,
    stash_open: store.stashOpen,
    preview_visible: store.previewVisible,
    preview_tabs: store.previewTabs,
    preview_active_idx: store.previewActiveIdx,
    rightPanelTab: store.rightPanelTab,
    workspace_layout: store.workspaceLayout,
    niri_layout: store.niriLayout,
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
    previewTabs: store.previewTabs,
    previewActiveIdx: store.previewActiveIdx,
    previewVisible: store.previewVisible,
  });
}

function restoreProjectViewState(projectId: string) {
  const store = useStore.getState();
  const saved = store.projectViewStates[projectId];
  if (saved) {
    store.setOpenFiles(saved.openFiles || []);
    store.setActiveFileIdx(saved.activeFileIdx ?? -1);
    store.setActiveTabType(saved.activeTabType || 'session');
    store.setPreviewTabs(saved.previewTabs || []);
    store.setPreviewActiveIdx(saved.previewActiveIdx ?? 0);
    if (saved.previewVisible !== undefined) store.setPreviewVisible(saved.previewVisible);
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
    store.setPreviewTabs([]);
    store.setPreviewActiveIdx(0);
    store.setPreviewVisible(false);
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

  // Disable browser default context menu page-wide
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+S: save current editor file
    if (mod && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      win.saveCurrentFile?.();
    }
    // Ctrl+Shift+S: new session
    if (mod && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      win.newSession?.();
    }
    // Ctrl+Shift+T: new terminal
    if (mod && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      win.addTerminal?.();
    }
    // Ctrl+Shift+W: create worktree
    if (mod && e.shiftKey && e.key === 'W') {
      e.preventDefault();
      win.createWorktree?.();
    }
    // F1 or Ctrl+Shift+?: help
    if (e.key === 'F1' || (mod && e.shiftKey && e.key === '?')) {
      e.preventDefault();
      useStore.getState().setModal({ type: 'help' });
    }
  });

  win.selectProject = selectProject;
  win.showOverview = () => {
    const store = useStore.getState();
    store.setActiveProjectId(null);
    store.setActiveProjectEnvironmentId(null);
    if (store.activeEnvironmentId) {
      history.pushState(null, '', '/env/' + store.activeEnvironmentId);
    }
  };
  win.navigate = (path: string, replace = false) => {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    handleRoute();
  };

  // Session management
  // Internal: create agent session with a specific agent type/mode
  const createAgentSession = async (agentType: string, agentMode: string, initialMessage?: string, linkedIssue?: { type: 'issue' | 'pr'; number: number; title: string; url: string }): Promise<string | undefined> => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;
    const proj = store.projects.find(p => p.id === store.activeProjectId);
    if (!proj) return;

    try {
      setPendingAgentCreation(true);
      const result = await api('POST', '/api/agent-sessions', {
        agentType,
        cwd: proj.path,
        skipPermissions: true,
        ...(initialMessage ? { message: initialMessage } : {}),
        ...(linkedIssue ? { linkedIssue } : {}),
      });
      setPendingAgentCreation(false);

      const sessionId = result.sessionId;
      const existing = proj.sessions.find(s => s.id === sessionId);
      if (existing) {
        connectAgentWs(sessionId);
        return;
      }
      const defaultViewMode = (agentMode === 'terminal') ? 'tui' : 'chat';
      const session = {
        id: sessionId,
        title: 'New session',
        status: 'open' as const,
        startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        messages: [],
        lastMessage: '',
        viewMode: defaultViewMode as 'chat' | 'tui',
        agentType,
        agentMode: agentMode as any,
        permissionMode: result.mode || 'bypassPermissions',
        model: result.model || null,
        _capabilities: result.capabilities,
        cliSessionId: result.cliSessionId || null,
        ...(linkedIssue ? { linkedIssue } : {}),
      };
      store.updateProject(proj.id, p => ({
        ...p,
        sessions: [...p.sessions, session],
        activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
      }));
      store.setActiveTabType('session');
      connectAgentWs(sessionId);
      store.addToast(proj.name, 'New session created', 'success');
      return sessionId;
    } catch (e: any) {
      setPendingAgentCreation(false);
      store.addToast(proj.name, `Failed: ${e.message}`, 'attention');
    }
  };

  // Track sessions created by "Create New Issue" that are pending issue linking
  const pendingIssueCreateSessions = new Set<string>();

  win.newIssueCreate = async () => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;

    const message = `Create a new GitHub issue using the gh CLI. Ask the user what the issue should be about, then create it.\n\nIMPORTANT: After creating the issue, you MUST call the mcp__atoo-studio__github_issue_pr_changed tool to notify the UI.\n\nDescribe what you need below:`;

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: async (agent: any) => {
          store.setModal(null);
          const sessionId = await createAgentSession(agent.agentType, agent.mode, message);
          if (sessionId) {
            pendingIssueCreateSessions.add(sessionId);
          }
        },
      },
    });
  };

  // Listen for github-issue-pr-changed events and auto-link pending issue creation sessions
  const handleIssueCreated = async (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.itemType !== 'issue' || !detail.sessionUuid || !detail.number) return;

    const store = useStore.getState();
    // Find the session whose cliSessionId matches the event's sessionUuid
    for (const proj of store.projects) {
      for (const s of proj.sessions) {
        if (!pendingIssueCreateSessions.has(s.id)) continue;
        const sid = (s as any).cliSessionId || s.id;
        const sidHex = sid.replace(/^(agent_|sess_)/, '').replace(/-/g, '');
        const eventHex = detail.sessionUuid.replace(/^(agent_|sess_)/, '').replace(/-/g, '');
        if (sidHex !== eventHex) continue;

        // Match found — fetch issue details and convert to issue-linked session
        pendingIssueCreateSessions.delete(s.id);
        try {
          const issueDetail = await api('GET', `/api/projects/${proj.id}/github/issues/${detail.number}`);
          const linkedIssue = {
            type: 'issue' as const,
            number: detail.number,
            title: issueDetail.title || `Issue #${detail.number}`,
            url: issueDetail.url || `https://github.com/${detail.repository}/issues/${detail.number}`,
          };
          store.updateProject(proj.id, p => ({
            ...p,
            sessions: p.sessions.map(sess =>
              sess.id === s.id ? { ...sess, linkedIssue } : sess
            ),
          }));
          store.addToast(proj.name, `Linked to issue #${detail.number}`, 'success');
        } catch (err) {
          // Fallback: link with minimal info
          const linkedIssue = {
            type: 'issue' as const,
            number: detail.number,
            title: `Issue #${detail.number}`,
            url: `https://github.com/${detail.repository}/issues/${detail.number}`,
          };
          store.updateProject(proj.id, p => ({
            ...p,
            sessions: p.sessions.map(sess =>
              sess.id === s.id ? { ...sess, linkedIssue } : sess
            ),
          }));
        }
        return;
      }
    }
  };
  window.addEventListener('github-issue-pr-changed', handleIssueCreated);

  win.newSession = async () => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: (agent: any) => {
          store.setModal(null);
          createAgentSession(agent.agentType, agent.mode);
        },
      },
    });
  };

  win.newSessionWithMessage = async (message: string) => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: (agent: any) => {
          store.setModal(null);
          createAgentSession(agent.agentType, agent.mode, message);
        },
      },
    });
  };

  // Open issue-bound agent session
  win.newIssueSession = async (issue: { number: number; title: string; url: string }) => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;

    const linkedIssue = { type: 'issue' as const, ...issue };
    const message = `This session is dedicated to GitHub issue #${issue.number} ("${issue.title}"). ` +
      `Use the gh CLI to retrieve issue details and work with this issue as needed.`;

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: (agent: any) => {
          store.setModal(null);
          createAgentSession(agent.agentType, agent.mode, message, linkedIssue);
        },
      },
    });
  };

  // Open PR-bound agent session
  win.newPrSession = async (pr: { number: number; title: string; url: string }) => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;

    const linkedIssue = { type: 'pr' as const, ...pr };
    const message = `This session is dedicated to GitHub PR #${pr.number} ("${pr.title}"). ` +
      `Use the gh CLI to retrieve PR details and work with this pull request as needed.`;

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: (agent: any) => {
          store.setModal(null);
          createAgentSession(agent.agentType, agent.mode, message, linkedIssue);
        },
      },
    });
  };

  // Send a message to a specific session (used by issue detail panel)
  win.sendMessageToSession = (sessionId: string, text: string) => {
    sendAgentCommand(sessionId, { action: 'send_message', text });
  };

  /**
   * Create a chain continuation from the current active session.
   * Shows agent picker, then creates a chain link and opens the new session.
   */
  win.chainSession = async (agentSessionId: string) => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;
    const proj = store.projects.find(p => p.id === store.activeProjectId);
    if (!proj) return;

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: async (agent: any) => {
          store.setModal(null);
          try {
            setPendingAgentCreation(true);
            const result = await api('POST', '/api/agent-sessions/chain', {
              agentSessionId,
              cwd: proj.path,
              skipPermissions: true,
              agentType: agent.agentType,
            });
            setPendingAgentCreation(false);

            const sessionId = result.sessionId;
            const defaultViewMode = (agent.mode === 'terminal') ? 'tui' : 'chat';
            // Carry forward linkedIssue from old session
            const oldSess = proj.sessions.find(s => s.id === agentSessionId);
            const oldLinkedIssue = oldSess?.linkedIssue;
            const session = {
              id: sessionId,
              title: 'Chain continuation',
              status: 'open' as const,
              startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              messages: [],
              lastMessage: '',
              viewMode: defaultViewMode as 'chat' | 'tui',
              agentType: agent.agentType,
              agentMode: agent.mode as any,
              permissionMode: result.mode || 'bypassPermissions',
              model: result.model || null,
              _capabilities: result.capabilities,
              cliSessionId: result.cliSessionId || null,
              ...(oldLinkedIssue ? { linkedIssue: oldLinkedIssue } : {}),
            };
            if (oldLinkedIssue) {
              api('PATCH', `/api/agent-sessions/${sessionId}/browser-state`, { linkedIssue: oldLinkedIssue }).catch(() => {});
            }
            store.updateProject(proj.id, p => {
              // Remove the old session (backend destroys it), add the new one
              const oldSession = p.sessions.find(s => s.id === agentSessionId);
              const remaining = p.sessions.filter(s => s.id !== agentSessionId);

              // Move the old session's cliSessionId into historicalSessions so chain
              // link detection can find the parent and group them in the carousel
              let historicalSessions = p.historicalSessions || [];
              const oldCliId = oldSession?.cliSessionId;
              if (oldCliId && !historicalSessions.some(h => h.id === oldCliId)) {
                historicalSessions = [...historicalSessions, {
                  id: oldCliId,
                  agentType: oldSession?.agentType,
                  title: oldSession?.title || 'Untitled',
                  lastModified: new Date().toISOString(),
                  eventCount: oldSession?.messages?.length || 0,
                }];
              }

              return {
                ...p,
                sessions: [...remaining, session],
                historicalSessions,
                activeSessionIdx: remaining.filter(s => s.status !== 'ended').length,
              };
            });
            store.setActiveTabType('session');
            connectAgentWs(sessionId);
            fetchAndApplyMetadata(proj.id, sessionId, proj.path);
            store.addToast(proj.name, 'Chain continuation created', 'success');
          } catch (e: any) {
            setPendingAgentCreation(false);
            store.addToast(proj.name, `Failed: ${e.message}`, 'attention');
          }
        },
      },
    });
  };

  win.switchToSession = (projId: string, idx: number) => {
    const store = useStore.getState();
    store.setActiveTabType('session');
    store.updateProject(projId, p => ({ ...p, activeSessionIdx: idx }));

    // Notify agent that session was viewed (clears attention badge)
    const proj = store.projects.find(p => p.id === projId);
    if (proj) {
      const active = proj.sessions.filter(s => s.status !== 'ended');
      const session = active[idx];
      if (session) {
        sendAgentCommand(session.id, { action: 'session_viewed' });
      }
    }
  };

  win.switchToTerminal = (projId: string, idx: number) => {
    const store = useStore.getState();
    store.setActiveTabType('terminal');
    store.updateProject(projId, p => ({ ...p, activeTerminalIdx: idx }));
  };

  win.closeTerminal = async (projId: string, idx: number) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projId);
    if (!proj) return;
    const term = proj.terminals[idx];
    if (!term) return;
    // Kill backend process
    if (term.shellId) {
      try { await api('DELETE', `/api/terminals/${term.shellId}`); } catch {}
    }
    // Cleanup frontend xterm instance
    destroyTerminal(term.id);
    // The WebSocket 'terminal_exited' event will remove it from the store
  };

  win.closeSession = async (projId: string, idx: number) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projId);
    if (!proj) return;
    const activeSessions = proj.sessions.filter((s: any) => s.status !== 'ended');
    const session = activeSessions[idx];
    if (!session) return;
    // Destroy the agent session
    try { await api('DELETE', `/api/agent-sessions/${session.id}`); } catch {}
    // Mark session as ended in the store (removes from active tabs)
    store.updateProject(projId, p => ({
      ...p,
      sessions: p.sessions.map((s: any) => s.id === session.id ? { ...s, status: 'ended' } : s),
      activeSessionIdx: Math.max(0, idx - 1),
    }));
    // Cleanup frontend xterm instance for TUI
    destroyTerminal(`tui-${session.id}`);
  };

  win.addTerminal = async () => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;
    const proj = store.projects.find(p => p.id === store.activeProjectId);
    if (!proj) return;
    try {
      // Just create via API — the WebSocket 'terminal_created' event handles adding to store
      const result = await api('POST', '/api/terminals', { cwd: proj.path });
      // Set active tab to terminal and select the new terminal once it appears
      store.setActiveTabType('terminal');
      // Wait briefly for the WebSocket event to add the terminal, then set the active index
      const waitForTerminal = () => {
        const p = useStore.getState().projects.find(x => x.id === proj.id);
        const idx = p?.terminals.findIndex(x => x.shellId === result.id);
        if (idx !== undefined && idx >= 0) {
          useStore.getState().updateProject(proj.id, pp => ({ ...pp, activeTerminalIdx: idx }));
        } else {
          setTimeout(waitForTerminal, 50);
        }
      };
      waitForTerminal();
    } catch (e: any) {
      store.addToast(proj.name, `Failed to create terminal: ${e.message}`, 'attention');
    }
  };

  // ── Tab reordering ──

  win.reorderSessions = (projId: string, fromIdx: number, toIdx: number) => {
    const store = useStore.getState();
    store.updateProject(projId, p => {
      const active = p.sessions.filter((s: any) => s.status !== 'ended');
      const ended = p.sessions.filter((s: any) => s.status === 'ended');
      const [moved] = active.splice(fromIdx, 1);
      active.splice(toIdx, 0, moved);
      // Adjust active index to follow the currently selected session
      let newIdx = p.activeSessionIdx ?? 0;
      if (newIdx === fromIdx) {
        newIdx = toIdx;
      } else if (fromIdx < newIdx && toIdx >= newIdx) {
        newIdx--;
      } else if (fromIdx > newIdx && toIdx <= newIdx) {
        newIdx++;
      }
      return { ...p, sessions: [...active, ...ended], activeSessionIdx: newIdx };
    });
  };

  win.reorderTerminals = (projId: string, fromIdx: number, toIdx: number) => {
    const store = useStore.getState();
    store.updateProject(projId, p => {
      const terms = [...p.terminals];
      const [moved] = terms.splice(fromIdx, 1);
      terms.splice(toIdx, 0, moved);
      let newIdx = p.activeTerminalIdx ?? 0;
      if (newIdx === fromIdx) {
        newIdx = toIdx;
      } else if (fromIdx < newIdx && toIdx >= newIdx) {
        newIdx--;
      } else if (fromIdx > newIdx && toIdx <= newIdx) {
        newIdx++;
      }
      return { ...p, terminals: terms, activeTerminalIdx: newIdx };
    });
  };

  win.revealInExplorer = (fullPath: string) => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;

    // Ensure we're in tree view + all files filter for reveal
    if (store.fileFilter !== 'all') store.setFileFilter('all');
    if (store.fileView !== 'tree') store.setFileView('tree');

    // Convert absolute path to relative path within project
    const relativePath = fullPath.startsWith(proj.path + '/') ? fullPath.slice(proj.path.length + 1) : fullPath;

    // Expand parent directories by clicking them open from root to leaf
    const parts = relativePath.split('/');
    let expandIdx = 0;

    function expandNext() {
      if (expandIdx >= parts.length - 1) {
        // Final file — select and scroll into view
        requestAnimationFrame(() => {
          const fileEl = document.querySelector(`[data-path="${CSS.escape(relativePath)}"][data-type="file"]`) as HTMLElement;
          if (fileEl) {
            fileEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
            fileEl.classList.add('file-tree-highlight');
            fileEl.click();
            setTimeout(() => fileEl.classList.remove('file-tree-highlight'), 2000);
          }
        });
        return;
      }

      const dirPath = parts.slice(0, expandIdx + 1).join('/');
      const dirEl = document.querySelector(`[data-path="${CSS.escape(dirPath)}"][data-type="dir"]`) as HTMLElement;
      expandIdx++;

      if (dirEl) {
        // Check if dir is already expanded (has visible children)
        const isExpanded = dirEl.nextElementSibling?.classList.contains('dir-children');
        if (!isExpanded) {
          dirEl.click(); // expand
          // Wait for React to render children before continuing
          requestAnimationFrame(() => expandNext());
        } else {
          expandNext();
        }
      } else {
        // Dir element not in DOM yet, wait a frame and retry
        requestAnimationFrame(() => {
          expandIdx--;
          expandNext();
        });
      }
    }

    expandNext();
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

  win.commitPushAndPR = async (projId?: string) => {
    const store = useStore.getState();
    const proj = projId ? store.projects.find(p => p.id === projId) : store.getActiveProject();
    if (!proj) return;

    const promptCommitPush =
      `Review all uncommitted changes in this worktree using git diff and git status. ` +
      `Then:\n` +
      `1. Stage all changes and create a commit with a comprehensive, well-structured commit message that describes what changed and why.\n` +
      `2. Push the branch to the remote.\n` +
      `After completing all steps, confirm the push was successful.`;

    const promptCommitPushPR =
      `Review all uncommitted changes in this worktree using git diff and git status. ` +
      `Then:\n` +
      `1. Stage all changes and create a commit with a comprehensive, well-structured commit message that describes what changed and why.\n` +
      `2. Push the branch to the remote.\n` +
      `3. Create a Pull Request using "gh pr create" with a comprehensive PR title and description body that summarizes all the changes, their purpose, and any relevant context.\n` +
      `After completing all steps, report the PR URL.`;

    const openAgentWithPrompt = (prompt: string, sessionTitle: string) => {
      store.setModal({
        type: 'agent-picker',
        props: {
          onSelect: async (agent: any) => {
            store.setModal(null);
            try {
              setPendingAgentCreation(true);
              const result = await api('POST', '/api/agent-sessions', {
                agentType: agent.agentType,
                cwd: proj.path,
                skipPermissions: true,
              });
              setPendingAgentCreation(false);

              const sessionId = result.sessionId;
              const defaultViewMode = (agent.mode === 'terminal') ? 'tui' : 'chat';
              const existing = proj.sessions.find(s => s.id === sessionId);
              if (existing) {
                connectAgentWs(sessionId);
              } else {
                store.updateProject(proj.id, p => ({
                  ...p,
                  activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
                  sessions: [...p.sessions, {
                    id: sessionId, title: sessionTitle, status: 'open' as const,
                    startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                    messages: [], viewMode: defaultViewMode, agentType: agent.agentType, agentMode: agent.mode,
                    permissionMode: 'bypassPermissions', showVerbose: true,
                    lastMessage: '', model: null,
                  }],
                }));
                store.setActiveTabType('session');
                connectAgentWs(sessionId);
              }

              // Inject the prompt into the TUI after terminal connects
              const tryInject = (attempts = 0) => {
                if (attempts > 60) return;
                if (win.injectTuiInput?.(sessionId, prompt)) return;
                setTimeout(() => tryInject(attempts + 1), 500);
              };
              setTimeout(() => tryInject(), 800);

              store.addToast(proj.name, `${sessionTitle} session created`, 'success');
            } catch (e: any) {
              setPendingAgentCreation(false);
              store.addToast(proj.name, `Failed: ${e.message}`, 'attention');
            }
          },
        },
      });
    };

    // Ask whether to also create a PR
    store.setModal({
      type: 'confirm',
      props: {
        title: 'Commit and Push',
        message: 'Create Pull Request?',
        confirmLabel: 'Yes',
        danger: false,
        secondaryAction: {
          label: 'No',
          onClick: () => openAgentWithPrompt(promptCommitPush, 'Commit & Push'),
        },
        onConfirm: () => openAgentWithPrompt(promptCommitPushPR, 'Publish PR'),
      },
    });
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
      store.setStashOpen(true);
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

  win.createWorktree = async () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj?.isGit) return;
    // Find the root project (if we're in a worktree child, go to parent)
    const rootProj = proj.parent_project_id
      ? store.projects.find(p => p.id === proj.parent_project_id) || proj
      : proj;
    const branches = (rootProj.gitLog?.branches || []).filter((b: string) => !b.startsWith('remotes/'));
    let usedBranches: string[] = [];
    try {
      const wts = await api('GET', `/api/projects/${rootProj.id}/git/worktrees`);
      usedBranches = (wts || []).map((w: any) => w.branch).filter(Boolean);
    } catch {}
    store.setModal({
      type: 'worktree',
      props: {
        branches,
        usedBranches,
        projectPath: rootProj.path,
        onConfirm: async (wtPath: string, branch: string, isNewBranch: boolean) => {
          try {
            await api('POST', `/api/projects/${rootProj.id}/git/worktrees`, { path: wtPath, branch, newBranch: isNewBranch });
            await refreshGitData(rootProj.id);
            // Reload environment to pick up the new linked project
            await reloadProjects();
            store.addToast(rootProj.name, `Created worktree at ${wtPath}`, 'success');
          } catch (e: any) { store.addToast(rootProj.name, `Failed: ${e.message}`, 'attention'); }
        },
      },
    });
  };

  win.removeWorktree = async (projectId: string) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projectId);
    if (!proj?.parent_project_id) return;
    const parentProj = store.projects.find(p => p.id === proj.parent_project_id);
    if (!parentProj) return;
    const branchName = proj.gitLog?.currentBranch;

    const doRemove = async (deleteBranch: boolean) => {
      try {
        let url = `/api/projects/${parentProj.id}/git/worktrees?path=${encodeURIComponent(proj.path)}`;
        if (deleteBranch && branchName) {
          url += `&deleteBranch=${encodeURIComponent(branchName)}`;
        }
        await api('DELETE', url);
        await refreshGitData(parentProj.id);
        if (useStore.getState().activeProjectId === projectId) {
          await selectProject(parentProj.id, parentProj.pe_id);
        }
        await reloadProjects();
        store.addToast(parentProj.name, `Removed worktree${deleteBranch ? ` and branch ${branchName}` : ''}`, 'info');
      } catch (e: any) { store.addToast(parentProj.name, `Failed: ${e.message}`, 'attention'); }
    };

    store.setModal({
      type: 'confirm',
      props: {
        title: 'Remove Worktree',
        message: branchName
          ? `Remove worktree and delete branch "${branchName}"?`
          : `Remove worktree at ${proj.path}?`,
        confirmLabel: branchName ? 'Remove & Delete Branch' : 'Remove',
        danger: true,
        ...(branchName ? { secondaryAction: { label: 'Remove Only', onClick: () => doRemove(false) } } : {}),
        onConfirm: () => doRemove(!!branchName),
      },
    });
  };

  // Create worktree from issue, close current session, open new issue session on worktree project
  win.createIssueWorktree = async (linkedIssue: { type: 'issue' | 'pr'; number: number; title: string; url: string }) => {
    const store = useStore.getState();
    if (!store.activeProjectId) return;
    const proj = store.projects.find(p => p.id === store.activeProjectId);
    if (!proj) return;

    // Find root project (if in a worktree child, go to parent)
    const rootProj = proj.parent_project_id
      ? store.projects.find(p => p.id === proj.parent_project_id) || proj
      : proj;

    // Build worktree name from issue number + title
    const sanitized = `${linkedIssue.number}-${linkedIssue.title}`.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const branchName = sanitized;
    const wtPath = rootProj.path + '/.atoo-studio/worktrees/' + sanitized;

    // Find and close the current issue session
    const activeSessions = proj.sessions.filter((s: any) => s.status !== 'ended');
    const sessionIdx = activeSessions.findIndex((s: any) => s.linkedIssue?.number === linkedIssue.number);
    const currentSession = sessionIdx >= 0 ? activeSessions[sessionIdx] : null;
    const currentAgentType = currentSession?.agentType;
    const currentAgentMode = currentSession?.agentMode;

    try {
      // 1. Create the worktree with a new branch
      await api('POST', `/api/projects/${rootProj.id}/git/worktrees`, { path: wtPath, branch: branchName, newBranch: true });
      await refreshGitData(rootProj.id);
      await reloadProjects();

      // 2. Close the current issue session
      if (currentSession && sessionIdx >= 0) {
        try { await api('DELETE', `/api/agent-sessions/${currentSession.id}`); } catch {}
        store.updateProject(proj.id, p => ({
          ...p,
          sessions: p.sessions.map((s: any) => s.id === currentSession.id ? { ...s, status: 'ended' } : s),
          activeSessionIdx: Math.max(0, sessionIdx - 1),
        }));
        destroyTerminal(`tui-${currentSession.id}`);
      }

      // 3. Find the worktree child project and switch to it
      const updatedStore = useStore.getState();
      const wtProject = updatedStore.projects.find(p => p.path === wtPath);
      if (!wtProject) {
        store.addToast(rootProj.name, 'Worktree created but project not found — try refreshing', 'attention');
        return;
      }

      await selectProject(wtProject.id, wtProject.pe_id);

      // 4. Create a new chained issue session on the worktree project
      const agentType = currentAgentType || 'claude-code';
      const agentMode = currentAgentMode || 'terminal+chat';
      const message = `This session is dedicated to GitHub issue #${linkedIssue.number} ("${linkedIssue.title}"). ` +
        `Use the gh CLI to retrieve issue details and work with this issue as needed. ` +
        `You are working in a dedicated worktree branch "${branchName}".`;

      try {
        setPendingAgentCreation(true);
        const result = await api('POST', '/api/agent-sessions', {
          agentType,
          cwd: wtPath,
          skipPermissions: true,
          message,
          linkedIssue,
        });
        setPendingAgentCreation(false);

        const sessionId = result.sessionId;
        const defaultViewMode = (agentMode === 'terminal') ? 'tui' : 'chat';
        const newSession = {
          id: sessionId,
          title: 'New session',
          status: 'open' as const,
          startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          messages: [],
          lastMessage: '',
          viewMode: defaultViewMode as 'chat' | 'tui',
          agentType,
          agentMode: agentMode as any,
          permissionMode: result.mode || 'bypassPermissions',
          model: result.model || null,
          _capabilities: result.capabilities,
          cliSessionId: result.cliSessionId || null,
          linkedIssue,
        };
        useStore.getState().updateProject(wtProject.id, p => ({
          ...p,
          sessions: [...p.sessions, newSession],
          activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
        }));
        useStore.getState().setActiveTabType('session');
        connectAgentWs(sessionId);
        fetchAndApplyMetadata(wtProject.id, sessionId, wtPath);
        store.addToast(wtProject.name, `Issue #${linkedIssue.number} worktree session created`, 'success');
      } catch (e: any) {
        setPendingAgentCreation(false);
        store.addToast(wtProject.name, `Session failed: ${e.message}`, 'attention');
      }
    } catch (e: any) {
      store.addToast(rootProj.name, `Worktree failed: ${e.message}`, 'attention');
    }
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
      const isAbsolute = filePath.startsWith('/');
      const fullPath = isAbsolute ? filePath : (proj.path) + '/' + filePath;
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
        let isBinary = false;
        let fileSize: number | undefined;

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
          isBinary = !!data.isBinary;
          fileSize = data.size;

          // For git-modified files (not untracked), fetch HEAD version for diff
          if (!isBinary && isGitModified && proj.isGit) {
            try {
              const headData = await api('GET', `/api/projects/${proj.id}/git/show?file=${encodeURIComponent(filePath)}`);
              originalContent = headData.content;
            } catch {}
          }
        }

        // For binary files: default to rendered if renderable (image), else hex
        let defaultViewMode: 'source' | 'diff' | 'rendered' | 'hex' = 'source';
        if (isBinary) {
          defaultViewMode = isRenderable(filePath) ? 'rendered' : 'hex';
        }

        files.push({
          path: filePath, fullPath, content, originalContent,
          isModified: isGitModified, lang, viewMode: defaultViewMode,
          _gitStatus: gitStatus || undefined, isBinary, fileSize,
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

    if (requestId) sendAgentCommand(sessionId, { action: 'approve', requestId });
  };

  win.denyControl = (sessionId: string) => {
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

    if (requestId) sendAgentCommand(sessionId, { action: 'deny', requestId });
  };

  win.submitQuestion = (uuid: string, sessionId: string) => {
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

    if (requestId) sendAgentCommand(sessionId, { action: 'answer_question', requestId, answers: cleanAnswers });
  };

  win.skipQuestion = (uuid: string, sessionId: string) => {
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

    if (requestId) sendAgentCommand(sessionId, { action: 'deny', requestId });
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
    sendAgentCommand(session.id, { action: 'set_mode', mode: value });
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
    sendAgentCommand(session.id, { action: 'set_model', model: value });
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
    api('PATCH', `/api/agent-sessions/${session.id}/browser-state`, { viewMode: mode }).catch(() => {});
  };

  win.toggleVerbose = () => {
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (!proj) return;
    const active = proj.sessions.filter(s => s.status !== 'ended');
    const session = active[proj.activeSessionIdx || 0];
    if (!session) return;
    const newVerbose = !(session.showVerbose !== false);
    store.updateProject(proj.id, p => ({
      ...p,
      sessions: p.sessions.map(s => s.id === session.id ? { ...s, showVerbose: newVerbose } : s),
    }));
    api('PATCH', `/api/agent-sessions/${session.id}/browser-state`, { showVerbose: newVerbose }).catch(() => {});
  };

  win.togglePreviewPanel = () => {
    const store = useStore.getState();
    const newVisible = !store.previewVisible;
    store.setPreviewVisible(newVisible);
    if (newVisible && store.previewTabs.length === 0) {
      store.setPreviewTabs([{ id: 'pv-' + Date.now(), label: 'New tab' }]);
    }
  };

  // Helper: fetch session metadata and apply to a session in the store
  const fetchAndApplyMetadata = (projId: string, sessionId: string, projPath: string) => {
    api('POST', '/api/mcp/get-metadata', { session_uuid: sessionId, cwd: projPath }).then((data: any) => {
      if (data.name || data.description || data.tags?.length) {
        const chainIds = data.chainSessionIds as string[] | undefined;
        const metaPatch: Record<string, any> = {};
        if (data.name) metaPatch.metaName = data.name;
        if (data.description) metaPatch.metaDescription = data.description;
        if (data.tags?.length) metaPatch.tags = data.tags;
        useStore.getState().updateProject(projId, p => ({
          ...p,
          sessions: p.sessions.map(sess =>
            (sess.id === sessionId || chainIds?.includes(sess.id)) ? {
              ...sess,
              ...metaPatch,
            } : sess
          ),
        }));
        // Push to server cache
        const agentIds = [sessionId, ...(chainIds || [])].filter(id => id.startsWith('agent_'));
        for (const aid of agentIds) {
          api('PATCH', `/api/agent-sessions/${aid}/browser-state`, metaPatch).catch(() => {});
        }
      }
    }).catch(() => {});
  };

  win.resumeSession = async (projId: string, sessionId: string) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projId);
    if (!proj) return;
    const session = proj.sessions.find(s => s.id === sessionId);
    if (!session) return;
    if (session.status === 'active' || session.status === 'attention') {
      const idx = proj.sessions.filter(s => s.status !== 'ended').indexOf(session);
      if (idx >= 0) win.switchToSession(projId, idx);
      return;
    }

    const doResume = async (agentType?: string) => {
      try {
        setPendingAgentCreation(true);
        const result = await api('POST', '/api/agent-sessions/resume', {
          sessionUuid: sessionId, cwd: proj.path, skipPermissions: true,
          agentType: agentType || undefined,
        });
        setPendingAgentCreation(false);
        const newSessionId = result.sessionId;
        const defaultViewMode = (result.agentMode === 'terminal') ? 'tui' : 'chat';
        const newSession = {
          id: newSessionId, title: session.title || 'Resumed session', status: 'open' as const,
          startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          messages: [], lastMessage: '', viewMode: defaultViewMode as 'chat' | 'tui',
          agentType: result.agentType, agentMode: result.agentMode,
          permissionMode: result.mode || 'bypassPermissions', model: result.model || null, _capabilities: result.capabilities,
          ...(session.metaName ? { metaName: session.metaName } : {}),
          ...(session.metaDescription ? { metaDescription: session.metaDescription } : {}),
          ...(session.tags?.length ? { tags: session.tags } : {}),
        };
        store.updateProject(projId, p => ({
          ...p,
          sessions: [...p.sessions.filter(s => s.id !== newSessionId), newSession],
          activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
        }));
        store.setActiveTabType('session');
        connectAgentWs(newSessionId);
        fetchAndApplyMetadata(projId, newSessionId, proj.path);
        store.addToast(proj.name, 'Session resumed', 'success');
      } catch (e: any) {
        setPendingAgentCreation(false);
        store.addToast(proj.name, `Failed to resume: ${e.message}`, 'attention');
      }
    };

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: async (agent: any) => {
          store.setModal(null);
          await doResume(agent.agentType);
        },
      },
    });
  };

  win.resumeHistoricalSession = async (projId: string, sessionUuid: string) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projId);
    if (!proj) return;

    const doResume = async (agentType?: string) => {
      try {
        setPendingAgentCreation(true);
        const result = await api('POST', '/api/agent-sessions/resume', {
          sessionUuid, cwd: proj.path, skipPermissions: true,
          agentType: agentType || undefined,
        });
        setPendingAgentCreation(false);
        const sessionId = result.sessionId;
        const histEntry = (proj.historicalSessions || []).find(h => h.id === sessionUuid);
        const defaultViewMode = (result.agentMode === 'terminal') ? 'tui' : 'chat';
        const session = {
          id: sessionId, title: histEntry?.title || result.title || 'Resumed session', status: 'open' as const,
          startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          messages: [], lastMessage: '', viewMode: defaultViewMode as 'chat' | 'tui',
          agentType: result.agentType, agentMode: result.agentMode,
          permissionMode: result.mode || 'bypassPermissions', model: result.model || null, _capabilities: result.capabilities,
          cliSessionId: result.cliSessionId || null,
          ...(histEntry?.metaName ? { metaName: histEntry.metaName } : {}),
          ...(histEntry?.tags?.length ? { tags: histEntry.tags } : {}),
        };
        store.updateProject(projId, p => ({
          ...p,
          sessions: [...p.sessions.filter(s => s.id !== sessionId), session],
          historicalSessions: (p.historicalSessions || []).filter(h => h.id !== sessionUuid),
          activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
        }));
        store.setActiveTabType('session');
        connectAgentWs(sessionId);
        fetchAndApplyMetadata(projId, sessionId, proj.path);
        store.addToast(proj.name, 'Session resumed', 'success');
      } catch (e: any) {
        setPendingAgentCreation(false);
        store.addToast(proj.name, `Failed to resume: ${e.message}`, 'attention');
      }
    };

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: async (agent: any) => {
          store.setModal(null);
          await doResume(agent.agentType);
        },
      },
    });
  };

  win.forkSession = async (projId: string, parentSessionId: string, afterEventUuid: string, fromEventUuid?: string) => {
    const store = useStore.getState();
    const proj = store.projects.find(p => p.id === projId);
    if (!proj) return;

    store.setModal({
      type: 'agent-picker',
      props: {
        onSelect: async (agent: any) => {
          store.setModal(null);
          try {
            setPendingAgentCreation(true);
            const result = await api('POST', '/api/agent-sessions', {
              agentType: agent.agentType,
              cwd: proj.path,
              skipPermissions: true,
              forkParentSessionId: parentSessionId,
              forkAfterEventUuid: afterEventUuid,
              forkFromEventUuid: fromEventUuid || undefined,
            });
            setPendingAgentCreation(false);

            const sessionId = result.sessionId;
            const defaultViewMode = (agent.mode === 'terminal') ? 'tui' : 'chat';
            const session = {
              id: sessionId,
              title: 'Forked session',
              status: 'open' as const,
              startedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              messages: [],
              lastMessage: '',
              viewMode: defaultViewMode as 'chat' | 'tui',
              agentType: agent.agentType,
              agentMode: agent.mode as any,
              permissionMode: result.mode || 'bypassPermissions',
              model: result.model || null,
              _capabilities: result.capabilities,
              cliSessionId: result.cliSessionId || null,
            };
            store.updateProject(projId, p => ({
              ...p,
              sessions: [...p.sessions, session],
              activeSessionIdx: p.sessions.filter(s => s.status !== 'ended').length,
            }));
            store.setActiveTabType('session');
            connectAgentWs(sessionId);
            store.addToast(proj.name, fromEventUuid ? 'Range fork created' : 'Session forked', 'success');
          } catch (e: any) {
            setPendingAgentCreation(false);
            store.addToast(proj.name, `Failed to fork: ${e.message}`, 'attention');
          }
        },
      },
    });
  };

  // Modals and context menus — keep as simple DOM manipulation for now
  win.showNewProjectModal = () => useStore.getState().setModal({ type: 'new-project' });
  win.showOpenProjectModal = () => useStore.getState().setModal({ type: 'open-project' });
  win.showConnectProjectModal = () => useStore.getState().setModal({ type: 'connect-project' });
  win.showSshProjectModal = () => useStore.getState().setModal({ type: 'ssh-project' });
  win.createEnvironmentFromStart = createEnvironmentFromStart;
  win.createEnvironmentFromDropdown = createEnvironmentFromDropdown;
  win.showCtxMenu = buildFileCtxMenu;
  win.newFileInDir = (dirPath: string) => {
    const proj = useStore.getState().getActiveProject();
    if (proj) ctxNewFile(dirPath, proj);
  };
  win.newFolderInDir = (dirPath: string) => {
    const proj = useStore.getState().getActiveProject();
    if (proj) ctxNewFolder(dirPath, proj);
  };
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
  win.startIssueSplitDrag = startIssueSplitDrag;

  // xterm.js terminal
  win.attachXterm = attachXterm;

  // Inject text into a session's TUI terminal input (does NOT press Enter)
  // Returns true if injection succeeded (terminal was connected)
  win.injectTuiInput = (sessionId: string, text: string): boolean => {
    const tuiTermId = `tui-${sessionId}`;
    const inst = terminalInstances[tuiTermId];
    if (inst?.ws?.readyState === 1) {
      inst.ws.send(JSON.stringify({ type: 'input', data: text }));
      return true;
    }
    return false;
  };
}

// Splitter functions (imperative, kept as-is for performance)
function dragStart() { document.body.classList.add('dragging'); }
function dragEnd() { document.body.classList.remove('dragging'); }

function startLpSplitterDrag(e: MouseEvent) {
  e.preventDefault();
  const splitter = document.getElementById('lp-splitter');
  const historyPanel = document.getElementById('git-history-panel');
  const leftPanel = historyPanel?.closest('.left-panel') || historyPanel?.closest('.carousel-explorer-pane');
  if (!splitter || !historyPanel || !leftPanel) return;
  dragStart(); splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = historyPanel.offsetHeight;
  const totalH = (leftPanel as HTMLElement).offsetHeight;
  const onMove = (ev: MouseEvent) => { historyPanel.style.height = Math.max(80, Math.min(totalH - 150, startH + (startY - ev.clientY))) + 'px'; };
  const onUp = () => { dragEnd(); splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startIssueSplitDrag(e: MouseEvent) {
  e.preventDefault();
  const panel = document.querySelector('.issue-detail-panel') as HTMLElement;
  const splitView = document.querySelector('.issue-split-view') as HTMLElement;
  if (!panel || !splitView) return;
  dragStart();
  const startY = e.clientY;
  const startH = panel.offsetHeight;
  const totalH = splitView.offsetHeight;
  const onMove = (ev: MouseEvent) => {
    const newH = Math.max(80, Math.min(totalH - 120, startH + (ev.clientY - startY)));
    panel.style.height = newH + 'px';
    panel.style.maxHeight = newH + 'px';
  };
  const onUp = () => {
    dragEnd();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startEditorSplitterDrag(e: MouseEvent) {
  e.preventDefault();
  const splitter = document.getElementById('editor-splitter');
  const editorArea = document.getElementById('editor-area');
  const centerPanel = editorArea?.closest('.center-panel');
  if (!splitter || !editorArea || !centerPanel) return;
  dragStart(); splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = editorArea.offsetHeight;
  const totalH = (centerPanel as HTMLElement).offsetHeight;
  const onMove = (ev: MouseEvent) => { editorArea.style.height = Math.max(80, Math.min(totalH - 120, startH + (ev.clientY - startY))) + 'px'; };
  const onUp = () => { dragEnd(); splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startSidebarSplitDrag(e: MouseEvent) {
  e.preventDefault();
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  if (!app || !sidebar) return;
  dragStart();
  const startX = e.clientX;
  const startW = sidebar.offsetWidth;
  const onMove = (ev: MouseEvent) => { app.style.setProperty('--sidebar-w', Math.max(160, Math.min(400, startW + (ev.clientX - startX))) + 'px'); };
  const onUp = () => { dragEnd(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startVSplitDrag(e: MouseEvent, side: string) {
  e.preventDefault();
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  dragStart();

  if (side === 'left') {
    const lp = workspace.querySelector('.left-panel') as HTMLElement;
    const startX = e.clientX, startW = lp.offsetWidth;
    const onMove = (ev: MouseEvent) => { workspace.style.setProperty('--lp-width', Math.max(140, Math.min(500, startW + (ev.clientX - startX))) + 'px'); };
    const onUp = () => { dragEnd(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  } else if (side === 'right') {
    const rp = document.getElementById('right-panel');
    if (!rp || rp.classList.contains('collapsed')) return;
    const startX = e.clientX, startW = rp.offsetWidth;
    const onMove = (ev: MouseEvent) => { workspace.style.setProperty('--rp-width', Math.max(140, Math.min(500, startW + (startX - ev.clientX))) + 'px'); };
    const onUp = () => { dragEnd(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  } else {
    const pp = document.getElementById('preview-panel');
    if (!pp) return;
    const startX = e.clientX, startW = pp.offsetWidth;
    const onMove = (ev: MouseEvent) => { const maxW = workspace.offsetWidth - 200; workspace.style.setProperty('--pp-width', Math.max(200, Math.min(maxW, startW + (startX - ev.clientX))) + 'px'); };
    const onUp = () => { dragEnd(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }
}

async function refreshGitData(projectId: string) {
  const proj = useStore.getState().projects.find(p => p.id === projectId);
  if (!proj) return;
  const cwdParam = '';
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
          refs: c.refs || [],
        })),
      },
      stashes,
    }));
  } catch {}
}

// xterm.js terminal support
let xtermModule: any = null;
let fitAddonModule: any = null;
let webLinksAddonModule: any = null;
const terminalInstances: Record<string, any> = {};

async function loadXterm() {
  if (xtermModule) return;
  const [xterm, fit, webLinks] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  xtermModule = xterm;
  fitAddonModule = fit;
  webLinksAddonModule = webLinks;
}

// ── Terminal file paste/drop ──────────────────────────────────────────
// Detects file/image content in paste or drop events, uploads to the server,
// and injects the file path as text into the PTY.
// Agent terminals: [file: /tmp/atoo/attachment_<uuid>/name.png]
// Shell terminals:  /tmp/atoo/attachment_<uuid>/name.png
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

const MAGIC_BYTES: Record<string, { ext: string; offset?: number }> = {
  '89504e47': { ext: 'png' },
  'ffd8ff': { ext: 'jpg' },
  '47494638': { ext: 'gif' },
  '424d': { ext: 'bmp' },
  '52494646': { ext: 'webp', offset: 8 }, // check WEBP at offset 8
  '49492a00': { ext: 'tiff' },
  '4d4d002a': { ext: 'tiff' },
  '00000100': { ext: 'ico' },
  '25504446': { ext: 'pdf' },
  '504b0304': { ext: 'zip' }, // also xlsx/docx/pptx
};

function detectExtFromBytes(buf: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buf.slice(0, 12));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  for (const [magic, info] of Object.entries(MAGIC_BYTES)) {
    if (hex.startsWith(magic)) {
      // Special case: RIFF header — check for WEBP at offset 8
      if (magic === '52494646') {
        const sub = hex.slice(16, 24); // bytes 8-11
        if (sub.startsWith('57454250')) return 'webp'; // "WEBP"
        return null; // RIFF but not WEBP (e.g. AVI)
      }
      // ZIP-based: could be docx/xlsx/pptx — caller should prefer original extension
      return info.ext;
    }
  }
  // AVIF/HEIC: ftyp box at offset 4
  if (hex.slice(8, 16) === '66747970') {
    const brand = hex.slice(16, 24);
    if (brand.startsWith('61766966')) return 'avif'; // "avif"
    if (brand.startsWith('68656963') || brand.startsWith('6d696631')) return 'heic';
  }
  return null;
}

function filenameForBlob(mimeType: string, buf: ArrayBuffer): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  // Try mime first
  const mimeExt: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/avif': 'avif', 'image/heic': 'heic',
    'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'application/pdf': 'pdf',
  };
  let ext = mimeExt[mimeType] || detectExtFromBytes(buf) || 'bin';
  return `clipboard_${ts}.${ext}`;
}

async function handleTerminalFilePaste(files: File[], ws: WebSocket, isAgent: boolean) {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      console.warn(`[attachment] Skipping ${file.name}: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit`);
      continue;
    }
    const buf = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

    // Determine filename: use original name if available, detect from bytes otherwise
    let filename = file.name && file.name !== 'image.png' && file.name !== 'blob'
      ? file.name
      : filenameForBlob(file.type, buf);

    // For ZIP-based Office formats, prefer original extension over generic .zip
    if (filename.endsWith('.zip') && file.name) {
      const origExt = file.name.split('.').pop()?.toLowerCase();
      if (origExt && ['xlsx', 'docx', 'pptx'].includes(origExt)) {
        filename = file.name;
      }
    }

    try {
      const res = await fetch('/api/terminal/attachment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, data: base64 }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await res.text());
      const { path: filePath } = await res.json();

      // Inject path into PTY as text
      const text = isAgent ? `[file: ${filePath}]` : filePath;
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: text }));
      }
    } catch (err) {
      console.error('[attachment] Upload failed:', err);
    }
  }
}

function setupTerminalPasteDrop(term: any, el: HTMLElement, container: HTMLElement, ws: WebSocket, isAgent: boolean) {
  // ── Paste handler ───────────────────────────────────────────────────
  // xterm's customKeyEventHandler returns false for Ctrl+V which tells xterm
  // to skip processing the key, but does NOT call preventDefault — so the
  // browser's native paste event still fires on xterm's internal textarea.
  // We listen there and handle text vs file content ourselves.
  const onPaste = (e: ClipboardEvent) => {
    const dt = e.clipboardData;
    if (!dt) return;

    let textContent: string | null = null;
    const files: File[] = [];

    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      } else if (item.kind === 'string' && item.type === 'text/plain') {
        textContent = dt.getData('text/plain');
      }
    }

    const hasText = textContent !== null && textContent.length > 0;
    const hasFiles = files.length > 0;

    if (!hasFiles && !hasText) return; // nothing useful

    // Always prevent default — we handle everything ourselves
    e.preventDefault();
    e.stopPropagation();

    if (hasFiles && hasText) {
      // Both text and file — ask the user
      const capturedText = textContent!;
      const capturedFiles = [...files];
      useStore.getState().setModal({
        type: 'confirm',
        props: {
          title: 'Paste clipboard',
          message: `Clipboard contains both text and a file (${capturedFiles[0].type}). What would you like to paste?`,
          confirmLabel: 'Attach File',
          danger: false,
          onConfirm: () => handleTerminalFilePaste(capturedFiles, ws, isAgent),
          secondaryAction: {
            label: 'Paste Text',
            onClick: () => {
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: capturedText }));
            },
          },
        },
      });
    } else if (hasFiles) {
      handleTerminalFilePaste(files, ws, isAgent);
    } else if (hasText) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: textContent }));
    }
  };

  // xterm's textarea is where paste events fire
  const pasteTarget: HTMLElement = term.textarea || el;
  pasteTarget.addEventListener('paste', onPaste as unknown as EventListener, true);

  // ── Drop handler ────────────────────────────────────────────────────
  // Both dragenter and dragover must call preventDefault for the browser
  // to allow a drop (otherwise it shows the 🚫 cursor).
  // We use the container (parent of xterm's el) so it covers everything.
  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const hasFiles = Array.from(e.dataTransfer.types).includes('Files');
    const hasText = Array.from(e.dataTransfer.types).includes('text/plain');
    if (hasFiles || hasText) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      container.classList.add('terminal-drop-active');
    }
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const hasFiles = Array.from(e.dataTransfer.types).includes('Files');
    const hasText = Array.from(e.dataTransfer.types).includes('text/plain');
    if (hasFiles || hasText) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDragLeave = (e: DragEvent) => {
    // Only remove highlight when truly leaving the container
    const related = e.relatedTarget as Node | null;
    if (related && container.contains(related)) return;
    container.classList.remove('terminal-drop-active');
  };
  const onDrop = async (e: DragEvent) => {
    container.classList.remove('terminal-drop-active');
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();

    // Check for Atoo Studio explorer drag (internal file path, not a native file)
    const hasFiles = e.dataTransfer.files.length > 0;
    const internalPath = e.dataTransfer.getData('text/plain');
    if (internalPath && !hasFiles) {
      const proj = useStore.getState().getActiveProject();
      const fullPath = proj?.path ? `${proj.path}/${internalPath}` : internalPath;
      const text = isAgent ? `[file: ${fullPath}]` : fullPath;
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: text }));
      }
      return;
    }

    if (hasFiles) {
      await handleTerminalFilePaste(Array.from(e.dataTransfer.files), ws, isAgent);
    }
  };

  // Capture phase on container — fires before xterm's internal handlers
  container.addEventListener('dragenter', onDragEnter as unknown as EventListener, true);
  container.addEventListener('dragover', onDragOver as unknown as EventListener, true);
  container.addEventListener('dragleave', onDragLeave as unknown as EventListener, true);
  container.addEventListener('drop', onDrop as unknown as EventListener, true);

  return () => {
    pasteTarget.removeEventListener('paste', onPaste as unknown as EventListener, true);
    container.removeEventListener('dragenter', onDragEnter as unknown as EventListener, true);
    container.removeEventListener('dragover', onDragOver as unknown as EventListener, true);
    container.removeEventListener('dragleave', onDragLeave as unknown as EventListener, true);
    container.removeEventListener('drop', onDrop as unknown as EventListener, true);
  };
}

function attachXterm(termId: string, targetId: string, container: HTMLElement, wsType = 'terminal') {
  if (terminalInstances[termId]) {
    const inst = terminalInstances[termId];
    container.innerHTML = '';
    container.appendChild(inst.el);
    // Re-observe the new container for resize events
    if (inst.resizeObserver && inst.container !== container) {
      inst.resizeObserver.disconnect();
      inst.resizeObserver.observe(container);
    }
    inst.container = container;
    setTimeout(() => (inst.fitFn || (() => inst.fitAddon.fit()))(), 0);
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

    // Ctrl+C: copy when text is selected, interrupt otherwise.
    // Ctrl+V / Cmd+V: return false to tell xterm "don't send ^V to PTY", but
    // crucially this does NOT call preventDefault — so the browser still fires
    // a paste event on xterm's textarea, which our paste handler intercepts.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey) {
        if (e.key === 'c' && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
          return false;
        }
        if (e.key === 'v') return false;
      }
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // URL links: Ctrl+click opens in new tab
    const WebLinksAddon = webLinksAddonModule.WebLinksAddon;
    term.loadAddon(new WebLinksAddon((_e: MouseEvent, uri: string) => {
      window.open(uri, '_blank', 'noopener');
    }));

    // File path links: Ctrl+click opens in Monaco editor
    const filePathRegex = /(?:^|\s)((?:\.\.?\/)?(?:[\w.@-]+\/)*[\w.@-]+\.\w+)(?::(\d+))?/;
    term.registerLinkProvider({
      provideLinks(y: number, cb: (links: any[] | undefined) => void) {
        const line = (term as any).buffer.active.getLine(y - 1);
        if (!line) { cb(undefined); return; }
        const text = line.translateToString();
        const links: any[] = [];
        let match;
        const globalRegex = new RegExp(filePathRegex.source, 'g');
        while ((match = globalRegex.exec(text)) !== null) {
          const filePath = match[1];
          const startX = match.index + match[0].indexOf(filePath);
          links.push({
            range: { start: { x: startX + 1, y }, end: { x: startX + filePath.length + (match[2] ? match[2].length + 1 : 0), y } },
            text: match[0].trim(),
            activate() { (window as any).openFileInEditor?.(filePath); },
          });
        }
        cb(links.length ? links : undefined);
      },
    });

    const isAgent = wsType === 'terminal';
    const FIXED_COLS = 120;
    const BASE_FONT = 13;
    const MIN_FONT = Math.round(BASE_FONT * 0.7); // ~9px — 70% zoom floor

    if (isAgent) {
      // Agent PTYs: fixed 120 cols, scale font to fit container width
      el.style.overflowX = 'auto';
    }

    term.open(el);

    // Measure character cell width at current font size (xterm renders a canvas)
    const measureCharWidth = () => {
      const dims = (fitAddon as any).proposeDimensions?.();
      if (dims?.width && dims?.cols) return dims.width / dims.cols;
      // Fallback: monospace char ≈ 0.6 * fontSize
      return term.options.fontSize! * 0.6;
    };

    /** For agent terminals: scale font so 120 cols fit the container, clamped to [MIN_FONT, BASE_FONT].
     *  If at MIN_FONT the content still overflows, horizontal scroll kicks in.
     *  Rows are always recalculated via fitAddon. */
    const fitAgent = () => {
      const c = terminalInstances[termId]?.container || container;
      const containerWidth = c.clientWidth - 20; // padding/scrollbar margin
      if (containerWidth <= 0) return;

      // Calculate ideal font size to fit FIXED_COLS chars
      const charRatio = measureCharWidth() / term.options.fontSize!;
      const idealFont = Math.floor(containerWidth / (FIXED_COLS * charRatio));
      const newFont = Math.max(MIN_FONT, Math.min(BASE_FONT, idealFont));

      if (term.options.fontSize !== newFont) {
        term.options.fontSize = newFont;
      }
      // Use fitAddon to calculate rows for the container height, then override cols
      fitAddon.fit();
      if (term.cols !== FIXED_COLS) {
        term.resize(FIXED_COLS, term.rows);
      }
    };

    if (isAgent) {
      fitAgent();
    } else {
      fitAddon.fit();
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsPath = wsType === 'shell' ? 'shell' : 'terminal';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${wsPath}/${targetId}`);

    ws.onopen = () => { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
    ws.onmessage = (e: any) => { try { const msg = JSON.parse(e.data); if (msg.type === 'output' && msg.data) term.write(msg.data); } catch {} };
    ws.onclose = () => { term.write('\r\n\x1b[90m[terminal disconnected]\x1b[0m\r\n'); };
    term.onData((data: string) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });
    term.onResize(({ cols, rows }: any) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });

    const fitFn = isAgent ? fitAgent : () => fitAddon.fit();
    const resizeHandler = () => fitFn();
    window.addEventListener('resize', resizeHandler);
    const resizeObserver = new ResizeObserver(() => fitFn());
    resizeObserver.observe(container);

    // File paste/drop: intercept paste & drop on the terminal container
    const cleanupPasteDrop = setupTerminalPasteDrop(term, el, container, ws, isAgent);

    terminalInstances[termId] = { term, fitAddon, ws, el, container, resizeHandler, resizeObserver, fitFn, cleanupPasteDrop };
    setTimeout(() => fitFn(), 100);
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
    navigator.clipboard?.writeText(proj ? (proj.path) + '/' + filePath : filePath);
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
        const effPath = proj.path;
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
          await api('DELETE', `/api/files?path=${encodeURIComponent((proj.path) + '/' + filePath)}`);
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
          await api('POST', '/api/files/create', { path: (proj.path) + '/' + dirPath + '/' + name, type: 'file' });
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
          await api('POST', '/api/files/create', { path: (proj.path) + '/' + dirPath + '/' + name, type: 'dir' });
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

function isNativeFileDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt || dragState.srcPath) return false;
  return Array.from(dt.types).includes('Files');
}

function onDragStart(srcPath: string, srcType: string, el: HTMLElement, dataTransfer: DataTransfer | null) {
  dragState.srcPath = srcPath;
  dragState.srcType = srcType;
  el.classList.add('dragging');
  if (dataTransfer) {
    dataTransfer.effectAllowed = 'copyMove';
    dataTransfer.setData('text/plain', srcPath);

    // Chrome drag-out: set DownloadURL so files/folders can be dragged to OS desktop/finder
    const store = useStore.getState();
    const proj = store.getActiveProject();
    if (proj) {
      const fullPath = proj.path + '/' + srcPath;
      const itemName = srcPath.split('/').pop() || srcPath;
      if (srcType === 'dir') {
        // Folders: download as zip via streaming endpoint
        const url = `${location.origin}/api/files/zip?path=${encodeURIComponent(fullPath)}`;
        try { dataTransfer.setData('DownloadURL', `application/zip:${itemName}.zip:${url}`); } catch (_) {}
      } else {
        const ext = (itemName.split('.').pop() || '').toLowerCase();
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
          webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
          json: 'application/json', xml: 'application/xml',
          html: 'text/html', css: 'text/css', js: 'text/javascript', txt: 'text/plain',
          ts: 'text/plain', tsx: 'text/plain', py: 'text/plain', rs: 'text/plain',
          go: 'text/plain', java: 'text/plain', c: 'text/plain', cpp: 'text/plain', h: 'text/plain',
          md: 'text/markdown', yaml: 'text/yaml', yml: 'text/yaml',
          zip: 'application/zip', gz: 'application/gzip',
          mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
        };
        const mime = mimeMap[ext] || 'application/octet-stream';
        const url = `${location.origin}/api/files/raw?path=${encodeURIComponent(fullPath)}`;
        try { dataTransfer.setData('DownloadURL', `${mime}:${itemName}:${url}`); } catch (_) {}
      }
    }
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
  const native = isNativeFileDrag(e.dataTransfer);
  if (!native && (!dragState.srcPath || targetPath === dragState.srcPath)) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = native ? 'copy' : 'move';
  document.querySelectorAll('.drop-target, .drop-above, .drop-below').forEach(x => x.classList.remove('drop-target', 'drop-above', 'drop-below'));
  if (targetType === 'dir' || native) {
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

async function onDropItem(targetPath: string, targetType: string, dataTransfer?: DataTransfer | null) {
  document.querySelectorAll('.drop-target, .drop-above, .drop-below').forEach(x => x.classList.remove('drop-target', 'drop-above', 'drop-below'));

  // Native file drop from OS
  if (isNativeFileDrag(dataTransfer) && dataTransfer) {
    const destDir = targetType === 'dir' ? targetPath : targetPath.split('/').slice(0, -1).join('/');
    await handleNativeFileDrop(destDir, dataTransfer);
    return;
  }

  // Internal move
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
  const effPath = proj.path;
  const fromFull = effPath + '/' + dragState.srcPath;
  const toFull = effPath + '/' + (destDir ? destDir + '/' : '') + srcName;
  try {
    await api('POST', '/api/files/move', { from: fromFull, to: toFull });
    store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
    await selectProject(proj.id);
    store.addToast(proj.name, `Moved ${srcName}`, 'info');
  } catch (e2: any) { store.addToast(proj.name, `Failed: ${e2.message}`, 'attention'); }
}

async function onDropRoot(dataTransfer?: DataTransfer | null) {
  // Native file drop from OS
  if (isNativeFileDrag(dataTransfer) && dataTransfer) {
    await handleNativeFileDrop('', dataTransfer);
    return;
  }

  // Internal move to root
  if (!dragState.srcPath) return;
  const store = useStore.getState();
  const proj = store.getActiveProject();
  if (!proj) return;
  const srcName = dragState.srcPath.split('/').pop();
  const effPath2 = proj.path;
  const fromFull = effPath2 + '/' + dragState.srcPath;
  const toFull = effPath2 + '/' + srcName;
  api('POST', '/api/files/move', { from: fromFull, to: toFull }).then(() => {
    store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
    selectProject(proj.id);
  }).catch(() => {});
}

// Native file/folder drop from OS -> upload to project
async function handleNativeFileDrop(destRelDir: string, dataTransfer: DataTransfer) {
  const store = useStore.getState();
  const proj = store.getActiveProject();
  if (!proj) return;

  const basePath = proj.path + (destRelDir ? '/' + destRelDir : '');

  // Use webkitGetAsEntry for folder support (Chrome/Edge)
  const items = dataTransfer.items;
  const entries: FileSystemEntry[] = [];
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const entry = (items[i] as any).webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }

  let filesToUpload: { relPath: string; file: File }[] = [];

  if (entries.length > 0) {
    for (const entry of entries) {
      filesToUpload.push(...await readEntryRecursive(entry, ''));
    }
  } else {
    // Fallback: plain file list (no folder support)
    for (let i = 0; i < dataTransfer.files.length; i++) {
      filesToUpload.push({ relPath: dataTransfer.files[i].name, file: dataTransfer.files[i] });
    }
  }

  if (filesToUpload.length === 0) return;

  const total = filesToUpload.length;
  store.setUploadProgress({ total, done: 0, currentFile: 'Creating directories...' });

  // Collect unique directories to create
  const dirsToCreate = new Set<string>();
  for (const { relPath } of filesToUpload) {
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirsToCreate.add(parts.slice(0, i).join('/'));
    }
  }

  // Create directories first (sorted by depth)
  for (const dir of [...dirsToCreate].sort()) {
    try { await api('POST', '/api/files/create', { path: basePath + '/' + dir, type: 'dir' }); } catch (_) { /* may exist */ }
  }

  // Upload files using streaming XHR for progress tracking
  let uploaded = 0;
  for (const { relPath, file } of filesToUpload) {
    store.setUploadProgress({ total, done: uploaded, currentFile: relPath, fileProgress: 0 });
    try {
      const fullPath = basePath + '/' + relPath;
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/files/upload?path=${encodeURIComponent(fullPath)}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            store.setUploadProgress({ total, done: uploaded, currentFile: relPath, fileProgress: e.loaded / e.total });
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(JSON.parse(xhr.responseText)?.error || xhr.statusText));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(file);
      });
      uploaded++;
    } catch (e: any) {
      store.addToast(proj.name, `Failed to upload ${relPath}: ${e.message}`, 'attention');
      uploaded++; // still count toward progress
    }
  }

  store.setUploadProgress(null);

  if (uploaded > 0) {
    store.addToast(proj.name, `Uploaded ${uploaded} file${uploaded !== 1 ? 's' : ''}`, 'info');
    store.updateProject(proj.id, (p: any) => ({ ...p, _filesLoaded: false }));
    await selectProject(proj.id);
  }
}

// Recursively read FileSystemEntry (Chrome/Edge webkitGetAsEntry API)
async function readEntryRecursive(entry: FileSystemEntry, parentPath: string): Promise<{ relPath: string; file: File }[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(
        file => resolve([{ relPath: parentPath ? parentPath + '/' + entry.name : entry.name, file }]),
        () => resolve([])
      );
    });
  }
  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const dirPath = parentPath ? parentPath + '/' + entry.name : entry.name;

    // readEntries may not return all entries at once — must call until batch is empty
    const allEntries: FileSystemEntry[] = [];
    await new Promise<void>((resolve) => {
      const readBatch = () => {
        dirReader.readEntries(batch => {
          if (batch.length === 0) { resolve(); return; }
          allEntries.push(...batch);
          readBatch();
        }, () => resolve());
      };
      readBatch();
    });

    const results: { relPath: string; file: File }[] = [];
    for (const child of allEntries) {
      results.push(...await readEntryRecursive(child, dirPath));
    }
    return results;
  }
  return [];
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
  try { inst.resizeObserver?.disconnect(); } catch {}
  try { inst.cleanupPasteDrop?.(); } catch {}
  delete terminalInstances[termId];
}

// Connect project workflow, modals, context menus, folder browser, session loading
// are now all React components in components/Modals/
