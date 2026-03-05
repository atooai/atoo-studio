import { create } from 'zustand';
import type { Environment, Project, EditorFile, PreviewTab, ChatAttachment } from '../types';

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
  stashOpen: boolean;
  activeTabType: 'session' | 'terminal';
  sidebarCollapsed: boolean;

  // Editor state
  openFiles: EditorFile[];
  activeFileIdx: number;
  monacoReady: boolean;

  // Preview state
  previewTabs: PreviewTab[];
  previewActiveIdx: number;
  previewMode: 'browser' | 'server';

  // Chat attachments
  chatAttachments: ChatAttachment[];

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

  // Session loading overlay
  sessionLoading: string | null; // label or null

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
  setStashOpen: (v: boolean) => void;
  setActiveTabType: (t: 'session' | 'terminal') => void;
  setSidebarCollapsed: (v: boolean) => void;
  setOpenFiles: (files: EditorFile[]) => void;
  setActiveFileIdx: (idx: number) => void;
  setMonacoReady: (v: boolean) => void;
  setPreviewTabs: (tabs: PreviewTab[]) => void;
  setPreviewActiveIdx: (idx: number) => void;
  setPreviewMode: (m: 'browser' | 'server') => void;
  setChatAttachments: (a: ChatAttachment[]) => void;
  addChatAttachment: (a: ChatAttachment) => void;
  removeChatAttachment: (id: string) => void;
  clearChatAttachments: () => void;
  setMdToggle: (uuid: string, mode: string) => void;
  setQuestionAnswer: (uuid: string, question: string, value: string) => void;
  setQuestionAnswers: (uuid: string, answers: Record<string, string>) => void;
  setProjectViewState: (projectId: string, state: any) => void;
  addToast: (project: string, message: string, type: string) => void;
  removeToast: (id: string) => void;
  setModal: (modal: { type: string; props?: any } | null) => void;
  setCtxMenu: (menu: AppState['ctxMenu']) => void;
  setSessionLoading: (label: string | null) => void;

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
  stashOpen: false,
  activeTabType: 'session',
  sidebarCollapsed: false,
  openFiles: [],
  activeFileIdx: -1,
  monacoReady: false,
  previewTabs: [],
  previewActiveIdx: 0,
  previewMode: 'browser',
  chatAttachments: [],
  mdToggleState: {},
  questionAnswers: {},
  projectViewStates: {},
  toasts: [],
  modal: null,
  ctxMenu: null,
  sessionLoading: null,

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
  setStashOpen: (v) => set({ stashOpen: v }),
  setActiveTabType: (t) => set({ activeTabType: t }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setOpenFiles: (files) => set({ openFiles: files }),
  setActiveFileIdx: (idx) => set({ activeFileIdx: idx }),
  setMonacoReady: (v) => set({ monacoReady: v }),
  setPreviewTabs: (tabs) => set({ previewTabs: tabs }),
  setPreviewActiveIdx: (idx) => set({ previewActiveIdx: idx }),
  setPreviewMode: (m) => set({ previewMode: m }),
  setChatAttachments: (a) => set({ chatAttachments: a }),
  addChatAttachment: (a) => set((s) => ({ chatAttachments: [...s.chatAttachments, a] })),
  removeChatAttachment: (id) => set((s) => ({
    chatAttachments: s.chatAttachments.filter((a) => a.id !== id),
  })),
  clearChatAttachments: () => set({ chatAttachments: [] }),
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
  setSessionLoading: (label) => set({ sessionLoading: label }),

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
