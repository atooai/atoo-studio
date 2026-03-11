import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';

// --- Dialog modal (alert / confirm / prompt) ---

export interface DialogInfo {
  dialogId: string;
  dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt?: string;
  url: string;
}

interface DialogModalProps {
  dialog: DialogInfo;
  onRespond: (dialogId: string, accept: boolean, promptText?: string) => void;
}

export function DialogModal({ dialog, onRespond }: DialogModalProps) {
  const [promptValue, setPromptValue] = useState(dialog.defaultPrompt || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog.dialogType === 'prompt' && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [dialog.dialogType]);

  const handleOk = () => {
    onRespond(dialog.dialogId, true, dialog.dialogType === 'prompt' ? promptValue : undefined);
  };

  const handleCancel = () => {
    onRespond(dialog.dialogId, false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleOk();
    if (e.key === 'Escape') handleCancel();
  };

  return (
    <div className="preview-dialog-overlay" onKeyDown={handleKeyDown}>
      <div className="preview-dialog-modal">
        <div className="preview-dialog-type">{dialog.dialogType}</div>
        <div className="preview-dialog-message">{dialog.message}</div>
        {dialog.dialogType === 'prompt' && (
          <input
            ref={inputRef}
            className="preview-dialog-input"
            value={promptValue}
            onChange={e => setPromptValue(e.target.value)}
          />
        )}
        <div className="preview-dialog-buttons">
          {dialog.dialogType !== 'alert' && (
            <button className="preview-dialog-btn cancel" onClick={handleCancel}>Cancel</button>
          )}
          <button className="preview-dialog-btn ok" onClick={handleOk}>OK</button>
        </div>
      </div>
    </div>
  );
}

// --- File chooser overlay ---

export interface FileChooserInfo {
  mode: string; // 'selectSingle' | 'selectMultiple'
  frameId: string;
  backendNodeId: number;
}

interface FileChooserModalProps {
  info: FileChooserInfo;
  projectId: string;
  tabId: string;
  onDone: () => void;
}

export function FileChooserModal({ info, projectId, tabId, onDone }: FileChooserModalProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);

    const files: { name: string; data: string }[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const buf = await f.arrayBuffer();
      files.push({
        name: f.name,
        data: btoa(String.fromCharCode(...new Uint8Array(buf))),
      });
    }

    try {
      await fetch(`/api/preview/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, backendNodeId: info.backendNodeId }),
      });
    } catch (err) {
      console.error('File upload failed:', err);
    }

    setUploading(false);
    onDone();
  }, [info.backendNodeId, projectId, tabId, onDone]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  };

  return (
    <div className="preview-dialog-overlay">
      <div
        className={`preview-filechooser-modal ${dragging ? 'dragging' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className="preview-dialog-type">File Chooser</div>
        {uploading ? (
          <div className="preview-filechooser-status">Uploading...</div>
        ) : (
          <>
            <div className="preview-filechooser-drop">
              Drop file{info.mode === 'selectMultiple' ? 's' : ''} here
            </div>
            <div className="preview-filechooser-or">or</div>
            <button className="preview-dialog-btn ok" onClick={() => inputRef.current?.click()}>
              Browse
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple={info.mode === 'selectMultiple'}
              style={{ display: 'none' }}
              onChange={e => upload(e.target.files)}
            />
          </>
        )}
        <button className="preview-dialog-btn cancel" style={{ marginTop: 8 }} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- Download notification ---

export interface DownloadInfo {
  guid: string;
  suggestedFilename: string;
  url: string;
  complete: boolean;
}

interface DownloadNotificationProps {
  download: DownloadInfo;
  projectId: string;
  tabId: string;
  onDismiss: () => void;
}

export function DownloadNotification({ download, projectId, tabId, onDismiss }: DownloadNotificationProps) {
  const handleDownload = () => {
    const url = `/api/preview/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}/download/${encodeURIComponent(download.guid)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = download.suggestedFilename;
    a.click();
  };

  return (
    <div className="preview-download-notification">
      <span className="preview-download-filename">{download.suggestedFilename}</span>
      {download.complete ? (
        <button className="preview-dialog-btn ok" onClick={handleDownload}>Download</button>
      ) : (
        <span className="preview-download-progress">Downloading...</span>
      )}
      <button className="preview-download-dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

// === Shadow Overlay Components ===

// --- Coordinate scaling helper ---

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function useOverlayPosition(
  rect: Rect,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
) {
  return useMemo(() => {
    const canvas = canvasRef.current;
    if (!canvas) return { top: 0, left: 0, width: 0, height: 0, scale: 1 };
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;
    return {
      left: rect.x * scaleX,
      top: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
      scale: scaleX,
    };
  }, [rect, canvasRef]);
}

// --- Select dropdown overlay ---

export interface SelectOption {
  value: string;
  text: string;
  selected: boolean;
  disabled: boolean;
  group: string | null;
}

export interface SelectInfo {
  rect: Rect;
  options: SelectOption[];
  selectedIndex: number;
  multiple: boolean;
  selectorPath: string;
}

interface SelectDropdownOverlayProps {
  info: SelectInfo;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onSelect: (selectorPath: string, value: string) => void;
  onDismiss: () => void;
}

export function SelectDropdownOverlay({ info, canvasRef, onSelect, onDismiss }: SelectDropdownOverlayProps) {
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const pos = useOverlayPosition(info.rect, canvasRef);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [onDismiss]);

  const filtered = info.options.filter(opt =>
    !search || opt.text.toLowerCase().includes(search.toLowerCase())
  );

  // Group options by optgroup
  const groups = new Map<string | null, SelectOption[]>();
  for (const opt of filtered) {
    const key = opt.group;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(opt);
  }

  return (
    <>
      <div className="preview-overlay-backdrop" onClick={onDismiss} />
      <div
        className="preview-select-overlay"
        style={{
          position: 'absolute',
          left: pos.left,
          top: pos.top + pos.height,
          minWidth: Math.max(pos.width, 150),
        }}
      >
        {info.options.length > 8 && (
          <input
            ref={searchRef}
            className="preview-select-search"
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        )}
        <div className="preview-select-list">
          {[...groups.entries()].map(([group, opts], gi) => (
            <React.Fragment key={gi}>
              {group && <div className="preview-select-optgroup">{group}</div>}
              {opts.map((opt, i) => (
                <div
                  key={`${gi}-${i}`}
                  className={`preview-select-option${opt.selected ? ' selected' : ''}${opt.disabled ? ' disabled' : ''}`}
                  onClick={() => {
                    if (!opt.disabled) {
                      onSelect(info.selectorPath, opt.value);
                    }
                  }}
                >
                  {opt.text}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </>
  );
}

// --- Picker overlay (date / time / color / etc.) ---

export interface PickerInfo {
  type: string;
  value: string;
  min: string | null;
  max: string | null;
  step: string | null;
  rect: Rect;
  selectorPath: string;
}

interface PickerOverlayProps {
  info: PickerInfo;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onSelect: (selectorPath: string, value: string, inputType: string) => void;
  onDismiss: () => void;
}

export function PickerOverlay({ info, canvasRef, onSelect, onDismiss }: PickerOverlayProps) {
  const [value, setValue] = useState(info.value || '');
  const pos = useOverlayPosition(info.rect, canvasRef);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-open the native picker in the host browser
    inputRef.current?.focus();
    inputRef.current?.showPicker?.();
  }, []);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [onDismiss]);

  const handleConfirm = () => {
    onSelect(info.selectorPath, value, info.type);
  };

  return (
    <>
      <div className="preview-overlay-backdrop" onClick={onDismiss} />
      <div
        className="preview-picker-overlay"
        style={{
          position: 'absolute',
          left: pos.left,
          top: pos.top + pos.height + 4,
        }}
      >
        <input
          ref={inputRef}
          type={info.type}
          value={value}
          min={info.min || undefined}
          max={info.max || undefined}
          step={info.step || undefined}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleConfirm(); }}
        />
        <div className="preview-picker-buttons">
          <button className="preview-dialog-btn cancel" onClick={onDismiss}>Cancel</button>
          <button className="preview-dialog-btn ok" onClick={handleConfirm}>OK</button>
        </div>
      </div>
    </>
  );
}

// --- Auth modal ---

export interface AuthInfo {
  requestId: string;
  url: string;
  realm: string;
  scheme: string;
}

interface AuthModalProps {
  info: AuthInfo;
  onSubmit: (requestId: string, username: string, password: string) => void;
  onCancel: (requestId: string) => void;
}

export function AuthModal({ info, onSubmit, onCancel }: AuthModalProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    onSubmit(info.requestId, username, password);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') onCancel(info.requestId);
  };

  return (
    <div className="preview-dialog-overlay" onKeyDown={handleKeyDown}>
      <div className="preview-dialog-modal">
        <div className="preview-dialog-type">Authentication Required</div>
        <div className="preview-dialog-message">
          {info.realm && <div>{info.realm}</div>}
          <div style={{ fontSize: '0.85em', opacity: 0.7, marginTop: 4 }}>{info.url}</div>
        </div>
        <input
          ref={userRef}
          className="preview-dialog-input"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
        />
        <input
          className="preview-dialog-input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          style={{ marginTop: 6 }}
        />
        <div className="preview-dialog-buttons">
          <button className="preview-dialog-btn cancel" onClick={() => onCancel(info.requestId)}>Cancel</button>
          <button className="preview-dialog-btn ok" onClick={handleSubmit}>Sign In</button>
        </div>
      </div>
    </div>
  );
}

// --- Tooltip overlay ---

export interface TooltipInfo {
  text: string;
  rect: Rect;
}

interface TooltipOverlayProps {
  info: TooltipInfo;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

export function TooltipOverlay({ info, canvasRef }: TooltipOverlayProps) {
  const pos = useOverlayPosition(info.rect, canvasRef);

  return (
    <div
      className="preview-tooltip"
      style={{
        position: 'absolute',
        left: pos.left + pos.width / 2,
        top: pos.top - 4,
        transform: 'translate(-50%, -100%)',
      }}
    >
      {info.text}
    </div>
  );
}

// --- Context menu overlay ---

export interface ContextMenuInfo {
  x: number;
  y: number;
  selectedText: string;
  linkHref: string | null;
  linkText: string | null;
  imgSrc: string | null;
}

interface ContextMenuOverlayProps {
  info: ContextMenuInfo;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onAction: (action: string, params?: any) => void;
  onDismiss: () => void;
}

export function ContextMenuOverlay({ info, canvasRef, onAction, onDismiss }: ContextMenuOverlayProps) {
  const pos = useOverlayPosition(
    { x: info.x, y: info.y, width: 0, height: 0 },
    canvasRef,
  );

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [onDismiss]);

  const items: { label: string; action: string; params?: any }[] = [
    { label: 'Back', action: 'back' },
    { label: 'Forward', action: 'forward' },
    { label: 'Reload', action: 'reload' },
  ];

  if (info.selectedText) {
    items.push({ label: 'Copy', action: 'copy' });
  }
  if (info.linkHref) {
    items.push({ label: 'Copy Link', action: 'copy_link' });
  }

  const handleAction = (action: string, params?: any) => {
    // Handle clipboard actions locally
    if (action === 'copy' && info.selectedText) {
      navigator.clipboard.writeText(info.selectedText).catch(() => {});
    } else if (action === 'copy_link' && info.linkHref) {
      navigator.clipboard.writeText(info.linkHref).catch(() => {});
    } else {
      onAction(action, params);
    }
    onDismiss();
  };

  return (
    <>
      <div className="preview-overlay-backdrop" onClick={onDismiss} />
      <div
        className="preview-context-menu"
        style={{
          position: 'absolute',
          left: pos.left,
          top: pos.top,
        }}
      >
        {items.map((item, i) => (
          <div
            key={i}
            className="preview-context-menu-item"
            onClick={() => handleAction(item.action, item.params)}
          >
            {item.label}
          </div>
        ))}
      </div>
    </>
  );
}
