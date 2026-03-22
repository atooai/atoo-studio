import { create } from 'zustand';
import type { Environment, Project, EditorFile, PreviewTab, ChatAttachment, SerialRequest, ReportedService, NiriLayoutState, NiriColumn, NiriWidthMode, ChatDraft } from '../types';
import { DEVICE_PRESETS } from '../data/device-presets';

export interface AppState {
  // Environment state
  environments: Environment[];
  activeEnvironmentId: string | null;
  environmentSettings: Record<string, any>;

  // Project state
  projects: Project[];
  activeProjectId: string | null;
  activeProjectEnvironmentId: string | null;

  // UI state
  previewVisible: boolean;
  fileFilter: 'all' | 'changed';
  fileView: 'tree' | 'flat';
  showHidden: boolean;
  explorerRoot: 'workspace' | 'system';
  stashOpen: boolean;
  searchOpen: boolean;
  activeTabType: 'session' | 'terminal';
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  rightPanelTab: 'sessions' | 'issues' | 'prs' | 'changes';
  workspaceLayout: 'classic' | 'carousel' | 'niri';
  niriLayout: NiriLayoutState;

  // Editor state
  openFiles: EditorFile[];
  activeFileIdx: number;
  monacoReady: boolean;

  // Preview state
  previewTabs: PreviewTab[];
  previewActiveIdx: number;
  previewResponsive: boolean;
  previewViewportWidth: number;
  previewViewportHeight: number;
  previewDevicePreset: string;
  previewZoom: number;
  previewDpr: number;
  previewIsMobile: boolean;
  previewHasTouch: boolean;

  // Serial device passthrough
  serialRequests: SerialRequest[];

  // Reported TCP services
  reportedServices: ReportedService[];

  // Chat attachments
  chatAttachments: ChatAttachment[];
  chatDrafts: Record<string, ChatDraft>;

  // Per-message view mode toggle: 'md' | 'txt' | 'raw'
  mdToggleState: Record<string, string>;

  // Question answers tracking
  questionAnswers: Record<string, Record<string, string>>;

  // Per-project view state cache
  projectViewStates: Record<string, any>;

  // Toast messages
  toasts: Array<{ id: string; project: string; message: string; type: string }>;

  // Modal state
  modal: { type: string; props?: any } | null;

  // Context menu state
  ctxMenu: { x: number; y: number; items: Array<{ label: string; icon: string; danger?: boolean; separator?: boolean; groupLabel?: string; action: () => void }> } | null;

  // Pending session switch (refined prompt to inject after session opens)
  pendingSessionSwitch: { targetSessionUuid: string; refinedPrompt: string; sourceSessionId: string | null } | null;

  // Session loading overlay
  sessionLoading: string | null; // label or null

  // File upload progress
  uploadProgress: { total: number; done: number; currentFile: string; fileProgress?: number } | null;

  // Mobile layout
  isMobileLayout: boolean;
  mobileView: 'dashboard' | 'files' | 'git' | 'agents' | 'terminal';
  mobileDrawerOpen: boolean;
  mobileSheetOpen: boolean;
  mobileSheetType: string | null;
  mobileSheetProps: any;

  // Actions
  setEnvironments: (envs: Environment[]) => void;
  setActiveEnvironmentId: (id: string | null) => void;
  setEnvironmentSettings: (settings: Record<string, any>) => void;
  setProjects: (projects: Project[]) => void;
  updateProject: (id: string, updater: (p: Project) => Project) => void;
  setActiveProjectId: (id: string | null) => void;
  setActiveProjectEnvironmentId: (id: string | null) => void;
  setPreviewVisible: (v: boolean) => void;
  setFileFilter: (f: 'all' | 'changed') => void;
  setFileView: (v: 'tree' | 'flat') => void;
  setShowHidden: (v: boolean) => void;
  setExplorerRoot: (v: 'workspace' | 'system') => void;
  setStashOpen: (v: boolean) => void;
  setSearchOpen: (v: boolean) => void;
  setActiveTabType: (t: 'session' | 'terminal') => void;
  setSidebarCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setRightPanelTab: (t: 'sessions' | 'issues' | 'prs' | 'changes') => void;
  setWorkspaceLayout: (v: 'classic' | 'carousel' | 'niri') => void;
  setNiriLayout: (layout: NiriLayoutState) => void;
  niriSetFocus: (columnIdx: number, windowIdx: number) => void;
  niriSetOverview: (v: boolean) => void;
  niriSetColumnWidth: (columnIdx: number, mode: NiriWidthMode, customPx?: number) => void;
  niriSetWindowHeight: (columnIdx: number, windowIdx: number, fraction: number) => void;
  niriMoveWindow: (fromCol: number, fromWin: number, toCol: number, toWinIdx: number) => void;
  niriAddColumn: (afterIdx: number, column: NiriColumn) => void;
  niriRemoveColumn: (columnIdx: number) => void;
  niriRemoveWindow: (columnIdx: number, windowIdx: number) => void;
  niriSetToolbarPosition: (pos: 'left' | 'right' | 'top' | 'bottom') => void;
  setOpenFiles: (files: EditorFile[]) => void;
  setActiveFileIdx: (idx: number) => void;
  setMonacoReady: (v: boolean) => void;
  setPreviewTabs: (tabs: PreviewTab[]) => void;
  setPreviewActiveIdx: (idx: number) => void;
  setPreviewResponsive: (v: boolean) => void;
  setPreviewViewport: (w: number, h: number) => void;
  setPreviewDevicePreset: (id: string) => void;
  setPreviewZoom: (z: number) => void;
  setPreviewDpr: (d: number) => void;
  setPreviewIsMobile: (v: boolean) => void;
  setPreviewHasTouch: (v: boolean) => void;
  addReportedServices: (services: ReportedService[]) => void;
  removeReportedService: (port: number) => void;
  addSerialRequest: (req: SerialRequest) => void;
  updateSerialRequest: (requestId: string, updates: Partial<SerialRequest>) => void;
  removeSerialRequest: (requestId: string) => void;
  setChatAttachments: (a: ChatAttachment[]) => void;
  addChatAttachment: (a: ChatAttachment) => void;
  removeChatAttachment: (id: string) => void;
  clearChatAttachments: () => void;
  setChatDraft: (sessionId: string, draft: ChatDraft) => void;
  clearChatDraft: (sessionId: string) => void;
  setMdToggle: (uuid: string, mode: string) => void;
  setQuestionAnswer: (uuid: string, question: string, value: string) => void;
  setQuestionAnswers: (uuid: string, answers: Record<string, string>) => void;
  setProjectViewState: (projectId: string, state: any) => void;
  addToast: (project: string, message: string, type: string) => void;
  removeToast: (id: string) => void;
  setModal: (modal: { type: string; props?: any } | null) => void;
  setCtxMenu: (menu: AppState['ctxMenu']) => void;
  setPendingSessionSwitch: (v: AppState['pendingSessionSwitch']) => void;
  setSessionLoading: (label: string | null) => void;
  setUploadProgress: (v: AppState['uploadProgress']) => void;
  setIsMobileLayout: (v: boolean) => void;
  setMobileView: (v: 'dashboard' | 'files' | 'git' | 'agents' | 'terminal') => void;
  setMobileDrawerOpen: (v: boolean) => void;
  openMobileSheet: (type: string, props?: any) => void;
  closeMobileSheet: () => void;

  // Helpers
  getActiveProject: () => Project | undefined;
  getActiveSession: () => any;
}

export const useStore = create<AppState>((set, get) => ({
  environments: [],
  activeEnvironmentId: null,
  environmentSettings: {},
  projects: [],
  activeProjectId: null,
  activeProjectEnvironmentId: null,
  previewVisible: false,
  fileFilter: 'all',
  fileView: 'tree',
  showHidden: false,
  explorerRoot: 'workspace',
  stashOpen: false,
  searchOpen: false,
  activeTabType: 'session',
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  rightPanelTab: 'sessions',
  workspaceLayout: 'classic',
  niriLayout: {
    columns: [
      { id: 'col-explorer', windows: [
        { id: 'w-filetree', type: 'file-tree' },
        { id: 'w-githistory', type: 'git-history' },
      ], widthMode: '1/3' },
      { id: 'col-editor', windows: [
        { id: 'w-editor', type: 'editor' },
      ], widthMode: '1/2' },
      { id: 'col-sessions', windows: [
        { id: 'w-sessions', type: 'sessions-list' },
      ], widthMode: '1/3' },
    ],
    focusedColumnIdx: 1,
    focusedWindowIdx: 0,
    overviewMode: false,
    toolbarPosition: 'left',
  },
  openFiles: [],
  activeFileIdx: -1,
  monacoReady: false,
  serialRequests: [],
  reportedServices: [],
  previewTabs: [],
  previewActiveIdx: 0,
  previewResponsive: false,
  previewViewportWidth: 375,
  previewViewportHeight: 667,
  previewDevicePreset: 'iphone-se',
  previewZoom: 100,
  previewDpr: 1,
  previewIsMobile: false,
  previewHasTouch: false,
  chatAttachments: [],
  chatDrafts: {},
  mdToggleState: {},
  questionAnswers: {},
  projectViewStates: {},
  toasts: [],
  modal: null,
  ctxMenu: null,
  pendingSessionSwitch: null,
  sessionLoading: null,
  uploadProgress: null,
  isMobileLayout: false,
  mobileView: 'dashboard',
  mobileDrawerOpen: false,
  mobileSheetOpen: false,
  mobileSheetType: null,
  mobileSheetProps: null,

  setEnvironments: (envs) => set({ environments: envs }),
  setActiveEnvironmentId: (id) => set({ activeEnvironmentId: id }),
  setEnvironmentSettings: (settings) => set({ environmentSettings: settings }),
  setProjects: (projects) => set({ projects }),
  updateProject: (id, updater) => set((s) => ({
    projects: s.projects.map((p) => (p.id === id ? updater(p) : p)),
  })),
  setActiveProjectId: (id) => set({ activeProjectId: id }),
  setActiveProjectEnvironmentId: (id) => set({ activeProjectEnvironmentId: id }),
  setPreviewVisible: (v) => set({ previewVisible: v }),
  setFileFilter: (f) => set({ fileFilter: f }),
  setFileView: (v) => set({ fileView: v }),
  setShowHidden: (v) => set({ showHidden: v }),
  setExplorerRoot: (v) => set({ explorerRoot: v }),
  setStashOpen: (v) => set({ stashOpen: v }),
  setSearchOpen: (v) => set({ searchOpen: v }),
  setActiveTabType: (t) => set({ activeTabType: t }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setRightPanelCollapsed: (v) => set({ rightPanelCollapsed: v }),
  setRightPanelTab: (t) => set({ rightPanelTab: t }),
  setWorkspaceLayout: (v) => set({ workspaceLayout: v }),
  setNiriLayout: (layout) => set({ niriLayout: layout }),
  niriSetFocus: (columnIdx, windowIdx) => set((s) => ({
    niriLayout: { ...s.niriLayout, focusedColumnIdx: columnIdx, focusedWindowIdx: windowIdx },
  })),
  niriSetOverview: (v) => set((s) => ({
    niriLayout: { ...s.niriLayout, overviewMode: v },
  })),
  niriSetColumnWidth: (columnIdx, mode, customPx) => set((s) => {
    const cols = [...s.niriLayout.columns];
    cols[columnIdx] = { ...cols[columnIdx], widthMode: mode, customWidthPx: customPx };
    return { niriLayout: { ...s.niriLayout, columns: cols } };
  }),
  niriSetWindowHeight: (columnIdx, windowIdx, fraction) => set((s) => {
    const cols = [...s.niriLayout.columns];
    const col = { ...cols[columnIdx], windows: [...cols[columnIdx].windows] };
    const wins = col.windows;
    if (wins.length < 2) return s;
    // Adjust this window and the next one to compensate
    const nextIdx = windowIdx + 1;
    if (nextIdx >= wins.length) return s;
    const oldFrac = wins[windowIdx].heightFraction ?? (1 / wins.length);
    const nextOldFrac = wins[nextIdx].heightFraction ?? (1 / wins.length);
    const delta = fraction - oldFrac;
    wins[windowIdx] = { ...wins[windowIdx], heightFraction: fraction };
    wins[nextIdx] = { ...wins[nextIdx], heightFraction: Math.max(0.05, nextOldFrac - delta) };
    cols[columnIdx] = col;
    return { niriLayout: { ...s.niriLayout, columns: cols } };
  }),
  niriMoveWindow: (fromCol, fromWin, toCol, toWinIdx) => set((s) => {
    const cols = s.niriLayout.columns.map(c => ({ ...c, windows: [...c.windows] }));
    const [win] = cols[fromCol].windows.splice(fromWin, 1);
    if (!win) return s;
    cols[toCol].windows.splice(toWinIdx, 0, win);
    // Recalculate height fractions for affected columns
    for (const idx of [fromCol, toCol]) {
      const n = cols[idx].windows.length;
      cols[idx].windows = cols[idx].windows.map(w => ({ ...w, heightFraction: 1 / Math.max(1, n) }));
    }
    // Remove empty columns
    const filtered = cols.filter(c => c.windows.length > 0);
    // Adjust focus
    let focusedColumnIdx = s.niriLayout.focusedColumnIdx;
    let focusedWindowIdx = toWinIdx;
    const newColIdx = filtered.findIndex(c => c.id === cols[toCol].id);
    if (newColIdx >= 0) focusedColumnIdx = newColIdx;
    return { niriLayout: { ...s.niriLayout, columns: filtered, focusedColumnIdx, focusedWindowIdx } };
  }),
  niriAddColumn: (afterIdx, column) => set((s) => {
    const cols = [...s.niriLayout.columns];
    cols.splice(afterIdx + 1, 0, column);
    return { niriLayout: { ...s.niriLayout, columns: cols, focusedColumnIdx: afterIdx + 1, focusedWindowIdx: 0 } };
  }),
  niriRemoveColumn: (columnIdx) => set((s) => {
    const cols = s.niriLayout.columns.filter((_, i) => i !== columnIdx);
    const focusedColumnIdx = Math.min(s.niriLayout.focusedColumnIdx, Math.max(0, cols.length - 1));
    return { niriLayout: { ...s.niriLayout, columns: cols, focusedColumnIdx, focusedWindowIdx: 0 } };
  }),
  niriRemoveWindow: (columnIdx, windowIdx) => set((s) => {
    const cols = s.niriLayout.columns.map(c => ({ ...c, windows: [...c.windows] }));
    cols[columnIdx].windows.splice(windowIdx, 1);
    // Recalculate fractions
    const n = cols[columnIdx].windows.length;
    if (n > 0) {
      cols[columnIdx].windows = cols[columnIdx].windows.map(w => ({ ...w, heightFraction: 1 / n }));
    }
    // Remove empty columns
    const filtered = cols.filter(c => c.windows.length > 0);
    const focusedColumnIdx = Math.min(s.niriLayout.focusedColumnIdx, Math.max(0, filtered.length - 1));
    const focusedWindowIdx = Math.min(s.niriLayout.focusedWindowIdx, Math.max(0, (filtered[focusedColumnIdx]?.windows.length ?? 1) - 1));
    return { niriLayout: { ...s.niriLayout, columns: filtered, focusedColumnIdx, focusedWindowIdx } };
  }),
  niriSetToolbarPosition: (pos) => set((s) => ({
    niriLayout: { ...s.niriLayout, toolbarPosition: pos },
  })),
  setOpenFiles: (files) => set({ openFiles: files }),
  setActiveFileIdx: (idx) => set({ activeFileIdx: idx }),
  setMonacoReady: (v) => set({ monacoReady: v }),
  setPreviewTabs: (tabs) => set({ previewTabs: tabs }),
  setPreviewActiveIdx: (idx) => set({ previewActiveIdx: idx }),
  setPreviewResponsive: (v) => set({ previewResponsive: v }),
  setPreviewViewport: (w, h) => set({ previewViewportWidth: w, previewViewportHeight: h, previewDevicePreset: 'custom' }),
  setPreviewDevicePreset: (id) => {
    const preset = DEVICE_PRESETS.find(p => p.id === id);
    if (preset) {
      set({
        previewDevicePreset: id,
        previewViewportWidth: preset.width,
        previewViewportHeight: preset.height,
        previewDpr: preset.dpr,
        previewIsMobile: preset.isMobile,
        previewHasTouch: preset.hasTouch,
      });
    } else {
      set({ previewDevicePreset: id });
    }
  },
  setPreviewZoom: (z) => set({ previewZoom: z }),
  setPreviewDpr: (d) => set({ previewDpr: d }),
  setPreviewIsMobile: (v) => set({ previewIsMobile: v }),
  setPreviewHasTouch: (v) => set({ previewHasTouch: v }),
  addReportedServices: (services) => set((s) => {
    const existing = s.reportedServices.filter((e) => !services.some((n) => n.port === e.port));
    return { reportedServices: [...existing, ...services] };
  }),
  removeReportedService: (port) => set((s) => ({
    reportedServices: s.reportedServices.filter((r) => r.port !== port),
  })),
  addSerialRequest: (req) => set((s) => ({ serialRequests: [...s.serialRequests, req] })),
  updateSerialRequest: (requestId, updates) => set((s) => ({
    serialRequests: s.serialRequests.map((r) => r.requestId === requestId ? { ...r, ...updates } : r),
  })),
  removeSerialRequest: (requestId) => set((s) => ({
    serialRequests: s.serialRequests.filter((r) => r.requestId !== requestId),
  })),
  setChatAttachments: (a) => set({ chatAttachments: a }),
  addChatAttachment: (a) => set((s) => ({ chatAttachments: [...s.chatAttachments, a] })),
  removeChatAttachment: (id) => set((s) => ({
    chatAttachments: s.chatAttachments.filter((a) => a.id !== id),
  })),
  clearChatAttachments: () => set({ chatAttachments: [] }),
  setChatDraft: (sessionId, draft) => set((s) => ({
    chatDrafts: { ...s.chatDrafts, [sessionId]: draft },
  })),
  clearChatDraft: (sessionId) => set((s) => {
    const next = { ...s.chatDrafts };
    delete next[sessionId];
    return { chatDrafts: next };
  }),
  setMdToggle: (uuid, mode) => set((s) => ({
    mdToggleState: { ...s.mdToggleState, [uuid]: mode },
  })),
  setQuestionAnswer: (uuid, question, value) => set((s) => ({
    questionAnswers: {
      ...s.questionAnswers,
      [uuid]: { ...(s.questionAnswers[uuid] || {}), [question]: value },
    },
  })),
  setQuestionAnswers: (uuid, answers) => set((s) => ({
    questionAnswers: { ...s.questionAnswers, [uuid]: answers },
  })),
  setProjectViewState: (projectId, state) => set((s) => ({
    projectViewStates: { ...s.projectViewStates, [projectId]: state },
  })),
  addToast: (project, message, type) => {
    const id = 'toast-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    set((s) => ({ toasts: [...s.toasts, { id, project, message, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5000);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setModal: (modal) => set({ modal }),
  setCtxMenu: (menu) => set({ ctxMenu: menu }),
  setPendingSessionSwitch: (v) => set({ pendingSessionSwitch: v }),
  setSessionLoading: (label) => set({ sessionLoading: label }),
  setUploadProgress: (v) => set({ uploadProgress: v }),
  setIsMobileLayout: (v) => set({ isMobileLayout: v }),
  setMobileView: (v) => set({ mobileView: v }),
  setMobileDrawerOpen: (v) => set({ mobileDrawerOpen: v }),
  openMobileSheet: (type, props) => set({ mobileSheetOpen: true, mobileSheetType: type, mobileSheetProps: props || null }),
  closeMobileSheet: () => set({ mobileSheetOpen: false, mobileSheetType: null, mobileSheetProps: null }),

  getActiveProject: () => {
    const s = get();
    return s.projects.find((p) => p.id === s.activeProjectId);
  },
  getActiveSession: () => {
    const s = get();
    const proj = s.projects.find((p) => p.id === s.activeProjectId);
    if (!proj) return undefined;
    const active = proj.sessions.filter((ss) => ss.status !== 'ended');
    return active[proj.activeSessionIdx || 0];
  },
}));
