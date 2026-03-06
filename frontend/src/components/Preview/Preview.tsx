import React, { useRef, useCallback } from 'react';
import { useStore } from '../../state/store';
import { normalizePreviewUrl, resolvePreviewSrc } from '../../utils';

export function PreviewPanel() {
  const { previewVisible, previewTabs, previewActiveIdx, previewMode, setPreviewTabs, setPreviewActiveIdx, setPreviewMode } = useStore();
  const urlInputRef = useRef<HTMLInputElement>(null);
  const iframeContainerRef = useRef<HTMLDivElement>(null);

  if (!previewVisible) return null;

  const activeTab = previewTabs[previewActiveIdx];

  const reloadActiveIframe = () => {
    const iframes = iframeContainerRef.current?.querySelectorAll('iframe');
    if (iframes && iframes[previewActiveIdx]) {
      const iframe = iframes[previewActiveIdx];
      try {
        iframe.contentWindow?.location.reload();
      } catch {
        // Cross-origin: re-assign src to force reload
        iframe.src = iframe.src;
      }
    }
  };

  const addTab = (url = '') => {
    const id = 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const label = url ? url.replace(/^https?:\/\//, '').slice(0, 20) : 'New tab';
    setPreviewTabs([...previewTabs, { id, url, label }]);
    setPreviewActiveIdx(previewTabs.length);
  };

  const closeTab = (idx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const newTabs = previewTabs.filter((_, i) => i !== idx);
    let newIdx = previewActiveIdx;
    if (newIdx >= newTabs.length) newIdx = Math.max(0, newTabs.length - 1);
    if (newTabs.length === 0) {
      addTab('');
      return;
    }
    setPreviewTabs(newTabs);
    setPreviewActiveIdx(newIdx);
  };

  const loadPreview = () => {
    let url = urlInputRef.current?.value.trim() || '';
    if (!url) return;
    url = normalizePreviewUrl(url);
    if (!activeTab) return;
    if (url === activeTab.url) {
      // URL unchanged — just reload the iframe
      reloadActiveIframe();
    } else {
      const newTabs = previewTabs.map((t, i) =>
        i === previewActiveIdx ? { ...t, url, label: url.replace(/^https?:\/\//, '').slice(0, 20) } : t
      );
      setPreviewTabs(newTabs);
    }
  };

  const toggleMode = () => {
    setPreviewMode(previewMode === 'browser' ? 'server' : 'browser');
  };

  return (
    <div className="preview-panel" id="preview-panel">
      <div className="preview-frame-container" ref={iframeContainerRef}>
        {activeTab && !activeTab.url && (
          <div className="preview-placeholder">Enter URL below to navigate</div>
        )}
        {previewTabs.map((tab, i) => (
          tab.url ? (
            <iframe
              key={tab.id}
              className={`preview-iframe ${i !== previewActiveIdx ? 'hidden' : ''}`}
              src={resolvePreviewSrc(tab.url, previewMode)}
            />
          ) : null
        ))}
      </div>
      <div className="preview-bottom-bar">
        <div className="preview-url-bar">
          <button
            className="preview-mode-btn"
            onClick={toggleMode}
            title={previewMode === 'browser' ? 'Browser mode' : 'Server mode'}
          >
            {previewMode === 'browser' ? 'B' : 'S'}
          </button>
          <input
            type="text"
            className="preview-url-input"
            ref={urlInputRef}
            defaultValue={activeTab?.url || ''}
            onKeyDown={(e) => { if (e.key === 'Enter') loadPreview(); }}
          />
          <button className="preview-refresh-btn" onClick={() => {
            const inputUrl = urlInputRef.current?.value.trim() || '';
            const normalized = inputUrl ? normalizePreviewUrl(inputUrl) : '';
            if (normalized && normalized !== activeTab?.url) {
              loadPreview();
            } else {
              reloadActiveIframe();
            }
          }}>↻</button>
          <button className="preview-refresh-btn" onClick={() => { const url = activeTab?.url; if (url) window.open(url, '_blank'); }} title="Open in new tab">↗</button>
        </div>
        <div className="preview-tab-row">
          {previewTabs.map((t, i) => (
            <div key={t.id} className={`preview-tab ${i === previewActiveIdx ? 'active' : ''}`} onClick={() => setPreviewActiveIdx(i)}>
              <span className="preview-tab-label">{t.label}</span>
              <span className="preview-tab-close" onClick={(e) => closeTab(i, e)}>×</span>
            </div>
          ))}
          <button className="preview-tab-add" onClick={() => addTab()} title="New preview tab">+</button>
        </div>
      </div>
    </div>
  );
}
