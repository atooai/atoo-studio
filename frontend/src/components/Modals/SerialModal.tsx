import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';
import { SerialBridge } from '../../lib/serial-bridge';

interface SerialModalProps {
  requestId: string;
  onClose: () => void;
}

export function SerialModal({ requestId, onClose }: SerialModalProps) {
  const request = useStore((s) => s.serialRequests.find((r) => r.requestId === requestId));
  const updateSerialRequest = useStore((s) => s.updateSerialRequest);
  const removeSerialRequest = useStore((s) => s.removeSerialRequest);
  const addToast = useStore((s) => s.addToast);
  const [status, setStatus] = useState<'prompt' | 'connecting' | 'connected' | 'error'>('prompt');
  const [error, setError] = useState('');
  const bridgeRef = useRef<SerialBridge>(new SerialBridge());

  const serialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;

  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    return () => {
      // Cleanup on unmount if not connected (user closed modal without connecting)
      if (statusRef.current !== 'connected') {
        api('POST', '/api/mcp/reject-serial', { requestId }).catch(() => {});
        useStore.getState().removeSerialRequest(requestId);
      }
    };
  }, [requestId]);

  if (!request) {
    return (
      <div className="confirm-dialog">
        <div className="confirm-dialog-title">Serial Request</div>
        <div className="confirm-dialog-message">Request not found or expired.</div>
        <div className="confirm-dialog-actions">
          <button className="confirm-dialog-btn cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const handleConnect = async () => {
    if (!serialSupported) return;
    setStatus('connecting');
    updateSerialRequest(requestId, { status: 'connecting' });

    try {
      await bridgeRef.current.connect(requestId, {
        baudRate: request.baudRate,
        dataBits: request.dataBits,
        stopBits: request.stopBits,
        parity: request.parity,
      });
      setStatus('connected');
      updateSerialRequest(requestId, { status: 'connected' });
      addToast('Serial', `Serial device connected (${request.baudRate} baud)`, 'success');
    } catch (err: any) {
      const msg = err.message || 'Connection failed';
      setError(msg);
      setStatus('error');
      updateSerialRequest(requestId, { status: 'error', error: msg });
    }
  };

  const handleDisconnect = async () => {
    await bridgeRef.current.disconnect();
    removeSerialRequest(requestId);
    addToast('Serial', 'Serial device disconnected', 'info');
    onClose();
  };

  const handleCancel = () => {
    if (status === 'connected') return; // Don't close while connected
    // Notify server that the user rejected the request
    api('POST', '/api/mcp/reject-serial', { requestId }).catch(() => {});
    removeSerialRequest(requestId);
    onClose();
  };

  return (
    <div className="confirm-dialog" style={{ minWidth: 380 }}>
      <div className="confirm-dialog-title">
        Serial Device Request
      </div>

      <div className="confirm-dialog-message" style={{ textAlign: 'left' }}>
        {request.description && (
          <p style={{ marginBottom: 12, color: 'var(--text-primary)' }}>{request.description}</p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
          <span>Baud rate:</span><span style={{ color: 'var(--text-primary)' }}>{request.baudRate}</span>
          <span>Data bits:</span><span style={{ color: 'var(--text-primary)' }}>{request.dataBits}</span>
          <span>Stop bits:</span><span style={{ color: 'var(--text-primary)' }}>{request.stopBits}</span>
          <span>Parity:</span><span style={{ color: 'var(--text-primary)' }}>{request.parity}</span>
        </div>

        {!serialSupported && (
          <p style={{ color: 'var(--text-error, #f44)', marginTop: 12 }}>
            Web Serial API is not supported in this browser. Use Chrome or Edge.
          </p>
        )}

        {status === 'connected' && request.controlSignalsSupported && (
          <p style={{ color: 'var(--accent-green, #4c4)', marginTop: 12 }}>
            Connected. Serial data is being bridged to the server. DTR/RTS signals are forwarded automatically.
          </p>
        )}

        {status === 'connected' && !request.controlSignalsSupported && (
          <p style={{ color: 'var(--accent-yellow, #fa4)', marginTop: 12 }}>
            Connected. Serial data is being bridged, but <strong>control signals (DTR/RTS) are not available</strong>.
            Auto-reset will not work — use the BOOT button on your device when flashing.
            To enable control signals, run <code>setup-cuse.sh</code> as root.
          </p>
        )}

        {status === 'error' && (
          <p style={{ color: 'var(--text-error, #f44)', marginTop: 12 }}>
            {error}
          </p>
        )}
      </div>

      <div className="confirm-dialog-actions">
        {status === 'prompt' && (
          <>
            <button className="confirm-dialog-btn cancel" onClick={handleCancel}>Cancel</button>
            <button
              className="confirm-dialog-btn primary"
              onClick={handleConnect}
              disabled={!serialSupported}
            >
              Connect Device
            </button>
          </>
        )}

        {status === 'connecting' && (
          <button className="confirm-dialog-btn cancel" disabled>Connecting...</button>
        )}

        {status === 'connected' && (
          <button className="confirm-dialog-btn danger" onClick={handleDisconnect}>Disconnect</button>
        )}

        {status === 'error' && (
          <>
            <button className="confirm-dialog-btn cancel" onClick={handleCancel}>Close</button>
            <button className="confirm-dialog-btn primary" onClick={handleConnect} disabled={!serialSupported}>
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}
