import React from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';

export function MobileSheet() {
  const { mobileSheetOpen, mobileSheetType, mobileSheetProps, closeMobileSheet } = useStore();

  return (
    <>
      <div
        className={`mobile-sheet-overlay ${mobileSheetOpen ? 'open' : ''}`}
        onClick={closeMobileSheet}
      />
      <div className={`mobile-sheet ${mobileSheetOpen ? 'open' : ''}`}>
        <div className="mobile-sheet-handle" />
        <div className="mobile-sheet-content">
          {mobileSheetType === 'container' && <ContainerDetailSheet {...(mobileSheetProps || {})} />}
          {mobileSheetType === 'session' && <SessionDetailSheet {...(mobileSheetProps || {})} />}
        </div>
      </div>
    </>
  );
}

function ContainerDetailSheet({ runtime, containerId, containerName, image, status, ports, memory, cpu }: any) {
  const name = containerName || containerId || 'Container';

  const doAction = async (action: string) => {
    try {
      const url = runtime === 'lxc'
        ? `/api/containers/lxc/containers/${encodeURIComponent(containerId)}/${action}`
        : `/api/containers/${runtime}/containers/${encodeURIComponent(containerId)}/${action}`;
      await api('POST', url);
    } catch (e: any) {
      console.error('Container action failed:', e);
    }
  };

  return (
    <>
      <div className="mobile-sheet-title">&#x1f433; {name}</div>
      <div className="mobile-sheet-actions">
        <button className="mobile-sheet-action-btn" onClick={() => doAction('restart')}>
          <span className="mobile-sheet-action-icon">&#x1f504;</span>
          Restart
        </button>
        <button className="mobile-sheet-action-btn" onClick={() => doAction('stop')}>
          <span className="mobile-sheet-action-icon">&#x23f9;</span>
          Stop
        </button>
        <button className="mobile-sheet-action-btn mobile-sheet-action-danger" onClick={() => doAction('remove')}>
          <span className="mobile-sheet-action-icon">&#x1f5d1;</span>
          Remove
        </button>
      </div>
      <div className="mobile-sheet-details">
        <div className="mobile-sheet-detail-title">Details</div>
        <div className="mobile-sheet-detail-grid">
          {image && <><span className="mobile-sheet-detail-label">Image:</span><span>{image}</span></>}
          {containerId && <><span className="mobile-sheet-detail-label">ID:</span><span>{containerId.substring(0, 12)}</span></>}
          {status && <><span className="mobile-sheet-detail-label">Status:</span><span>{status}</span></>}
          {ports && <><span className="mobile-sheet-detail-label">Ports:</span><span>{ports}</span></>}
          {memory && <><span className="mobile-sheet-detail-label">Memory:</span><span>{memory}</span></>}
          {cpu && <><span className="mobile-sheet-detail-label">CPU:</span><span>{cpu}</span></>}
        </div>
      </div>
    </>
  );
}

function SessionDetailSheet({ sessionId, title, status, agentType, turns, runtime }: any) {
  return (
    <>
      <div className="mobile-sheet-title">&#x1f916; {title || 'Session'}</div>
      <div className="mobile-sheet-details">
        <div className="mobile-sheet-detail-grid">
          {sessionId && <><span className="mobile-sheet-detail-label">ID:</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{sessionId.substring(0, 12)}</span></>}
          {status && <><span className="mobile-sheet-detail-label">Status:</span><span>{status}</span></>}
          {agentType && <><span className="mobile-sheet-detail-label">Agent:</span><span>{agentType}</span></>}
          {turns !== undefined && <><span className="mobile-sheet-detail-label">Turns:</span><span>{turns}</span></>}
          {runtime && <><span className="mobile-sheet-detail-label">Runtime:</span><span>{runtime}</span></>}
        </div>
      </div>
    </>
  );
}
