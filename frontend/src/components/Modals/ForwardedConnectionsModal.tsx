import React from 'react';
import { useStore } from '../../state/store';

interface ForwardedConnectionsModalProps {
  onClose: () => void;
}

export function ForwardedConnectionsModal({ onClose }: ForwardedConnectionsModalProps) {
  const reportedServices = useStore((s) => s.reportedServices);
  const serialRequests = useStore((s) => s.serialRequests);

  const hasContent = reportedServices.length > 0 || serialRequests.length > 0;

  return (
    <div className="confirm-dialog" style={{ minWidth: 460, maxWidth: 560 }}>
      <div className="confirm-dialog-title">Forwarded Connections</div>

      <div className="confirm-dialog-message" style={{ textAlign: 'left', maxHeight: 400, overflowY: 'auto' }}>
        {!hasContent && (
          <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            No active connections. Services reported via MCP and serial devices will appear here.
          </p>
        )}

        {reportedServices.length > 0 && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              TCP Services
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: serialRequests.length > 0 ? 16 : 0 }}>
              {reportedServices.map((svc) => (
                <div key={svc.port} style={{
                  background: 'var(--bg-surface-3)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                  border: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                      {svc.name}
                    </span>
                    <span style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 3,
                      background: 'var(--accent-blue)',
                      color: '#fff',
                      fontWeight: 500,
                    }}>
                      :{svc.port}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {svc.description}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary, var(--text-secondary))', marginTop: 3, display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span>{svc.protocol}</span>
                    {svc.projectName && <span>{svc.projectName}</span>}
                    {svc.host && <span>Host: {svc.host}</span>}
                    {isHttpProtocol(svc.protocol) && (
                      <a
                        href={`${window.location.origin}/at/port/${svc.port}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--accent-blue)', textDecoration: 'none', marginLeft: 'auto' }}
                      >
                        Open &#x2197;
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {serialRequests.length > 0 && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Serial Devices
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {serialRequests.map((req) => (
                <div key={req.requestId} style={{
                  background: 'var(--bg-surface-3)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                  border: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                      {req.description || 'Serial Device'}
                    </span>
                    <span style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 3,
                      background: statusColor(req.status),
                      color: '#fff',
                      fontWeight: 500,
                    }}>
                      {req.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {req.baudRate} baud, {req.dataBits}{req.parity[0].toUpperCase()}{req.stopBits}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="confirm-dialog-actions">
        <button className="confirm-dialog-btn cancel" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function isHttpProtocol(protocol: string): boolean {
  const p = protocol.toLowerCase();
  return p === 'http' || p === 'https';
}

function statusColor(status: string): string {
  switch (status) {
    case 'connected': return 'var(--accent-green, #4c4)';
    case 'connecting': return 'var(--accent-yellow, #cc4)';
    case 'error': return 'var(--accent-red, #c44)';
    default: return 'var(--accent-blue)';
  }
}
