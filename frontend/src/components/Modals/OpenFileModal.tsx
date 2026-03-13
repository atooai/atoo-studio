import React, { useEffect } from 'react';
import { api } from '../../api';

interface OpenFileModalProps {
  requestId: string;
  filePath: string;
  onClose: () => void;
}

export function OpenFileModal({ requestId, filePath, onClose }: OpenFileModalProps) {
  const respond = async (action: 'approved' | 'rejected') => {
    try {
      await api('POST', '/api/mcp/respond-open-file', { requestId, action });
    } catch (err) {
      console.warn('[OpenFileModal] Failed to respond:', err);
    }
    onClose();

    if (action === 'approved') {
      (window as any).openFileInEditor?.(filePath);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); respond('rejected'); }
      if (e.key === 'Enter') { e.preventDefault(); respond('approved'); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Extract filename from path for display
  const fileName = filePath.split('/').pop() || filePath;
  const dirPath = filePath.substring(0, filePath.length - fileName.length);

  return (
    <div className="confirm-dialog">
      <div className="confirm-dialog-title">Open file?</div>
      <div className="confirm-dialog-message">
        An AI agent wants to open a file in your editor:
        <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 4, fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>
          <span style={{ color: 'var(--text-muted)' }}>{dirPath}</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fileName}</span>
        </div>
      </div>
      <div className="confirm-dialog-actions">
        <button className="confirm-dialog-btn cancel" onClick={() => respond('rejected')}>
          Reject
        </button>
        <button className="confirm-dialog-btn primary" onClick={() => respond('approved')}>
          Open
        </button>
      </div>
    </div>
  );
}
