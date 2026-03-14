import React, { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';
import { getFileIcon, isRenderable, isImageFile, escapeHtml, getMonacoLang, renderMd } from '../../utils';
import { HexViewer } from './HexViewer';
import { useDraggableTabs } from '../../hooks/useDraggableTabs';
import type { EditorFile } from '../../types';

let monacoEditor: any = null;
let monacoDiffEditor: any = null;
let monacoInstance: any = null;

function initMonaco() {
  import('monaco-editor').then(monaco => {
    monacoInstance = monaco;
    monaco.editor.defineTheme('atoo-dark', {
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
    useStore.getState().setMonacoReady(true);
  }).catch(() => {
    console.warn('Monaco editor failed to load');
  });
}

// Initialize Monaco on first import
initMonaco();

// Expose save for global Ctrl+S handler
(window as any).saveCurrentFile = saveCurrentFile;

function disposeEditors() {
  if (monacoEditor) { monacoEditor.dispose(); monacoEditor = null; }
  if (monacoDiffEditor) { monacoDiffEditor.dispose(); monacoDiffEditor = null; }
}

async function saveCurrentFile() {
  const s = useStore.getState();
  const file = s.activeFileIdx >= 0 ? s.openFiles[s.activeFileIdx] : null;
  if (!file) return;
  try {
    await api('PUT', '/api/files', { path: file.fullPath, content: file.content });
    const updated = s.openFiles.map((f, i) =>
      i === s.activeFileIdx ? { ...f, originalContent: f.content, isModified: false } : f
    );
    useStore.getState().setOpenFiles(updated);
  } catch (e: any) {
    const proj = useStore.getState().getActiveProject();
    useStore.getState().addToast(proj?.name || '', `Save failed: ${e.message}`, 'attention');
  }
}

export function EditorArea() {
  const { openFiles, activeFileIdx, setOpenFiles, setActiveFileIdx, setCtxMenu, monacoReady } = useStore();
  const isOpen = openFiles.length > 0;

  if (!isOpen) return <div className="editor-area" id="editor-area" style={{ height: 0 }}></div>;

  const file = activeFileIdx >= 0 && activeFileIdx < openFiles.length ? openFiles[activeFileIdx] : null;

  const closeTab = (idx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const newFiles = openFiles.filter((_, i) => i !== idx);
    let newIdx = activeFileIdx;
    if (newIdx >= newFiles.length) newIdx = newFiles.length - 1;
    if (newFiles.length === 0) {
      newIdx = -1;
      disposeEditors();
    }
    setOpenFiles(newFiles);
    setActiveFileIdx(newIdx);
  };

  const closeAllTabs = () => {
    disposeEditors();
    setOpenFiles([]);
    setActiveFileIdx(-1);
  };

  const closeOtherTabs = (keepIdx: number) => {
    const kept = [openFiles[keepIdx]];
    setOpenFiles(kept);
    setActiveFileIdx(0);
  };

  const closeTabsRight = (fromIdx: number) => {
    const kept = openFiles.slice(0, fromIdx + 1);
    setOpenFiles(kept);
    if (activeFileIdx > fromIdx) setActiveFileIdx(fromIdx);
  };

  const closeTabsLeft = (fromIdx: number) => {
    const kept = openFiles.slice(fromIdx);
    setOpenFiles(kept);
    setActiveFileIdx(activeFileIdx >= fromIdx ? activeFileIdx - fromIdx : 0);
  };

  const reorderFiles = useCallback((from: number, to: number) => {
    const s = useStore.getState();
    const files = [...s.openFiles];
    const [moved] = files.splice(from, 1);
    files.splice(to, 0, moved);
    // Adjust active index to follow the active file
    let newIdx = s.activeFileIdx;
    if (s.activeFileIdx === from) {
      newIdx = to;
    } else if (from < s.activeFileIdx && to >= s.activeFileIdx) {
      newIdx = s.activeFileIdx - 1;
    } else if (from > s.activeFileIdx && to <= s.activeFileIdx) {
      newIdx = s.activeFileIdx + 1;
    }
    s.setOpenFiles(files);
    s.setActiveFileIdx(newIdx);
  }, []);

  const editorDrag = useDraggableTabs(reorderFiles);

  const showEditorCtx = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const f = openFiles[idx];
    const count = openFiles.length;
    setCtxMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Close', icon: '×', action: () => closeTab(idx) },
        { label: 'Close All', icon: '⊗', danger: true, action: closeAllTabs },
        ...(count > 1 ? [
          { label: 'Close Others', icon: '⊖', action: () => closeOtherTabs(idx) },
          ...(idx < count - 1 ? [{ label: 'Close to the Right', icon: '⊳', action: () => closeTabsRight(idx) }] : []),
          ...(idx > 0 ? [{ label: 'Close to the Left', icon: '⊲', action: () => closeTabsLeft(idx) }] : []),
        ] : []),
        { label: '', icon: '', separator: true, action: () => {} },
        { label: 'Copy Path', icon: '⧉', action: () => navigator.clipboard.writeText(f.path).catch(() => {}) },
        { label: 'Reveal in Explorer', icon: '◈', action: () => (window as any).revealInExplorer?.(f.fullPath) },
      ],
    });
  };

  const setViewMode = (mode: 'source' | 'diff' | 'rendered' | 'hex') => {
    if (!file) return;
    const noDiff = !file.isModified || file._gitStatus === '??' || file._gitStatus === 'D';
    if (mode === 'source' && file.isBinary) return;
    if (mode === 'diff' && (noDiff || file.isBinary)) return;
    if (mode === 'rendered' && !isRenderable(file.path)) return;
    const newFiles = openFiles.map((f, i) => i === activeFileIdx ? { ...f, viewMode: mode } : f);
    setOpenFiles(newFiles);
  };

  return (
    <div className="editor-area open" id="editor-area" style={{ height: '45%' }}>
      <div className="editor-tabs">
        {openFiles.map((f, i) => {
          const name = f.path.split('/').pop() || '';
          const icon = getFileIcon(name);
          const isActive = i === activeFileIdx;
          return (
            <div
              key={f.path}
              className={`editor-tab ${isActive ? 'active' : ''}`}
              onClick={() => setActiveFileIdx(i)}
              onContextMenu={(e) => showEditorCtx(e, i)}
              {...editorDrag.getTabDragProps(i)}
            >
              <span className="editor-tab-icon">{icon}</span>
              <span className="editor-tab-name">{name}</span>
              {f.isModified && <span className="editor-tab-modified"></span>}
              <span className="editor-tab-close" onClick={(e) => closeTab(i, e)}>×</span>
            </div>
          );
        })}
      </div>
      {file && (
        <>
          <div className="editor-toolbar">
            <div className="editor-view-group">
              <button className={`ev-btn ${file.viewMode === 'source' ? 'active' : ''} ${file.isBinary ? 'disabled' : ''}`} onClick={() => setViewMode('source')}>Source</button>
              <button className={`ev-btn ${file.viewMode === 'diff' ? 'active' : ''} ${(!file.isModified || file._gitStatus === '??' || file._gitStatus === 'D' || file.isBinary) ? 'disabled' : ''}`} onClick={() => setViewMode('diff')}>Diff</button>
              <button className={`ev-btn ${file.viewMode === 'rendered' ? 'active' : ''} ${!isRenderable(file.path) ? 'disabled' : ''}`} onClick={() => setViewMode('rendered')}>Rendered</button>
              <button className={`ev-btn ${file.viewMode === 'hex' ? 'active' : ''}`} onClick={() => setViewMode('hex')}>Hex</button>
            </div>
            {!file.isBinary && <button
              className={`ev-btn ${(file.isModified && file._gitStatus !== 'D') ? '' : 'disabled'}`}
              onClick={() => saveCurrentFile()}
              title="Save (Ctrl+S)"
            >Save</button>}
            <span className="editor-filepath">{file.path}</span>
          </div>
          <div className="editor-content">
            {file.viewMode === 'hex' ? (
              <HexViewer file={file} />
            ) : file.viewMode === 'diff' && file.isModified && !file.isBinary ? (
              <DiffEditorView file={file} />
            ) : file.viewMode === 'rendered' && isRenderable(file.path) ? (
              <RenderedView file={file} />
            ) : file.isBinary ? (
              <BinaryPlaceholder file={file} onSwitchView={setViewMode} />
            ) : (
              <SourceEditorView file={file} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

let editorUserEditing = false;

function SourceEditorView({ file }: { file: EditorFile }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { monacoReady } = useStore();
  const filePathRef = useRef(file.path);

  // Create or switch editor model when file path changes
  useEffect(() => {
    if (!monacoReady || !monacoInstance || !containerRef.current) return;
    if (monacoDiffEditor) { monacoDiffEditor.dispose(); monacoDiffEditor = null; }

    filePathRef.current = file.path;

    if (monacoEditor) {
      monacoEditor.setModel(monacoInstance.editor.createModel(file.content, file.lang));
    } else {
      monacoEditor = monacoInstance.editor.create(containerRef.current, {
        value: file.content, language: file.lang, theme: 'atoo-dark',
        fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
        minimap: { enabled: true, scale: 1 }, lineNumbers: 'on',
        renderLineHighlight: 'all', scrollBeyondLastLine: false,
        automaticLayout: true, padding: { top: 8 },
      });
    }

    // Track content changes
    const disposable = monacoEditor.onDidChangeModelContent(() => {
      editorUserEditing = true;
      const newContent = monacoEditor.getValue();
      const s = useStore.getState();
      const updated = s.openFiles.map((f, i) =>
        i === s.activeFileIdx ? { ...f, content: newContent, isModified: newContent !== f.originalContent } : f
      );
      s.setOpenFiles(updated);
      editorUserEditing = false;
    });

    // Ctrl+S save keybinding
    monacoEditor.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS],
      run: () => saveCurrentFile(),
    });

    return () => {
      disposable.dispose();
    };
  }, [file.path, monacoReady]);

  // Update editor content from external changes (disk reload) without resetting cursor
  useEffect(() => {
    if (!monacoEditor || editorUserEditing) return;
    const currentValue = monacoEditor.getValue();
    if (file.content !== currentValue) {
      const pos = monacoEditor.getPosition();
      const scrollTop = monacoEditor.getScrollTop();
      monacoEditor.setValue(file.content);
      if (pos) monacoEditor.setPosition(pos);
      monacoEditor.setScrollTop(scrollTop);
    }
  }, [file.content]);

  if (!monacoReady) {
    return <pre style={{ padding: 12, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflow: 'auto', height: '100%' }}>{escapeHtml(file.content)}</pre>;
  }

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

function DiffEditorView({ file }: { file: EditorFile }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { monacoReady } = useStore();

  useEffect(() => {
    if (!monacoReady || !monacoInstance || !containerRef.current) return;
    if (monacoEditor) { monacoEditor.dispose(); monacoEditor = null; }
    if (monacoDiffEditor) { monacoDiffEditor.dispose(); }

    monacoDiffEditor = monacoInstance.editor.createDiffEditor(containerRef.current, {
      theme: 'atoo-dark', fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
      renderSideBySide: true, automaticLayout: true, readOnly: true,
      scrollBeyondLastLine: false, padding: { top: 8 },
    });
    monacoDiffEditor.setModel({
      original: monacoInstance.editor.createModel(file.originalContent, file.lang),
      modified: monacoInstance.editor.createModel(file.content, file.lang),
    });
  }, [file.path, monacoReady]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

function BinaryPlaceholder({ file, onSwitchView }: { file: EditorFile; onSwitchView: (mode: 'hex') => void }) {
  const sizeLabel = file.fileSize
    ? file.fileSize >= 1024 * 1024
      ? (file.fileSize / 1024 / 1024).toFixed(1) + ' MB'
      : file.fileSize >= 1024
      ? (file.fileSize / 1024).toFixed(1) + ' KB'
      : file.fileSize + ' B'
    : 'unknown size';
  const ext = file.path.split('.').pop()?.toUpperCase() || 'BINARY';

  return (
    <div className="binary-placeholder">
      <div className="binary-placeholder-icon">&#x2B22;</div>
      <div className="binary-placeholder-title">Binary file</div>
      <div className="binary-placeholder-info">{ext} &middot; {sizeLabel}</div>
      <div className="binary-placeholder-msg">This file cannot be displayed as text.</div>
      <button className="ev-btn" onClick={() => onSwitchView('hex')}>Open in Hex Viewer</button>
    </div>
  );
}

function RenderedView({ file }: { file: EditorFile }) {
  const ext = file.path.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md') {
    return <div className="editor-rendered" style={{ display: 'block' }}><div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMd(file.content) }} /></div>;
  }
  if (ext === 'html' || ext === 'astro') {
    return <div className="editor-rendered" style={{ display: 'block' }}><iframe className="html-frame" srcDoc={file.content} sandbox="" style={{ width: '100%', height: '100%', border: 'none' }} /></div>;
  }
  // Binary images: use raw endpoint
  if (isImageFile(file.path)) {
    const imgUrl = `/api/files/raw?path=${encodeURIComponent(file.fullPath)}`;
    if (ext === 'svg' && !file.isBinary) {
      return <div className="editor-rendered" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#12131a' }}><img src={imgUrl} alt={file.path} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /></div>;
    }
    return (
      <div className="editor-rendered" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#12131a' }}>
        <img src={imgUrl} alt={file.path} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </div>
    );
  }
  return <div className="editor-rendered" style={{ display: 'block' }}><pre style={{ padding: 16, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{escapeHtml(file.content)}</pre></div>;
}
