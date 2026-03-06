import React, { useState } from 'react';
import { useStore } from '../../state/store';

interface ConnectionBarProps {
  tab: {
    id: string;
    targetPort?: number;
    headerHost?: string;
    protocol?: 'http' | 'https';
  };
  tabIdx: number;
}

export function ConnectionBar({ tab, tabIdx }: ConnectionBarProps) {
  const { previewTabs, setPreviewTabs } = useStore();
  const [port, setPort] = useState(String(tab.targetPort || ''));
  const [host, setHost] = useState(tab.headerHost || '');
  const [proto, setProto] = useState<'http' | 'https'>(tab.protocol || 'http');

  const apply = () => {
    const p = parseInt(port, 10);
    if (!p || isNaN(p)) return;
    const updated = previewTabs.map((t, i) =>
      i === tabIdx
        ? { ...t, targetPort: p, headerHost: host || undefined, protocol: proto, url: undefined }
        : t
    );
    setPreviewTabs(updated);
  };

  return (
    <div className="preview-connection-bar">
      <select
        className="preview-connection-proto"
        value={proto}
        onChange={(e) => setProto(e.target.value as 'http' | 'https')}
      >
        <option value="http">http</option>
        <option value="https">https</option>
      </select>
      <span className="preview-connection-sep">://</span>
      <input
        className="preview-connection-host"
        type="text"
        placeholder="Host header (optional)"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
      />
      <span className="preview-connection-sep">:</span>
      <input
        className="preview-connection-port"
        type="number"
        placeholder="Port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
      />
      <button className="preview-connection-btn" onClick={apply} title="Connect">Connect</button>
      <span className={`preview-connection-status ${tab.targetPort ? 'connected' : ''}`}>
        {tab.targetPort ? `streaming :${tab.targetPort}` : 'disconnected'}
      </span>
    </div>
  );
}
