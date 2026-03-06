import React, { useState, useEffect } from 'react';
import { api } from '../../api';

interface DevToolsPanelProps {
  projectId: string;
  tabId: string;
  visible: boolean;
  onToggle: () => void;
}

export function DevToolsPanel({ projectId, tabId, visible, onToggle }: DevToolsPanelProps) {
  const [devtoolsUrl, setDevtoolsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(450);
  const [dragging, setDragging] = useState(false);

  // Fetch the correct DevTools URL when becoming visible
  useEffect(() => {
    if (!visible) { setDevtoolsUrl(null); setError(null); return; }

    api('GET', `/apps/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}/devtools-url`)
      .then((data) => {
        setDevtoolsUrl(data.url);
        setError(null);
      })
      .catch((err) => {
        setError(err.message || 'Failed to connect to DevTools');
        setDevtoolsUrl(null);
      });
  }, [visible, projectId, tabId]);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setWidth(Math.max(250, Math.min(startW + delta, 900)));
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  if (!visible) return null;

  return (
    <div className="preview-devtools-sidebar" style={{ width }}>
      <div className="preview-devtools-resize-handle" onMouseDown={handleResizeStart} />
      <div className="preview-devtools-header">
        <span className="preview-devtools-title">DevTools</span>
        <button className="preview-devtools-close" onClick={onToggle} title="Close DevTools">×</button>
      </div>
      <div className="preview-devtools-content">
        {error && (
          <div className="preview-devtools-error">{error}</div>
        )}
        {devtoolsUrl && (
          <iframe
            className="preview-devtools-iframe"
            src={devtoolsUrl}
          />
        )}
        {!devtoolsUrl && !error && (
          <div className="preview-devtools-loading">Connecting...</div>
        )}
      </div>
      {dragging && <div className="preview-drag-overlay" />}
    </div>
  );
}
