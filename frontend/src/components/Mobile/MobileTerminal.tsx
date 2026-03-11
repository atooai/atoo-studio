import React, { useRef, useEffect, useState } from 'react';
import { useStore } from '../../state/store';

export function MobileTerminal() {
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);

  if (!proj) {
    return (
      <div className="mobile-empty-state">
        <div className="mobile-empty-icon">&#x2B1B;</div>
        <div className="mobile-empty-title">No project selected</div>
        <div className="mobile-empty-desc">Select a project to open a terminal</div>
      </div>
    );
  }

  const terminals = proj.terminals || [];

  return (
    <div className="mobile-terminal">
      <div className="mobile-section-hdr">
        <span className="mobile-section-title">Terminals</span>
        <button className="mobile-section-action" onClick={() => (window as any).addTerminal?.()}>+ New</button>
      </div>

      {terminals.length > 0 && (
        <div className="mobile-terminal-tabs">
          {terminals.map((t: any, i: number) => (
            <div
              key={t.id}
              className={`mobile-term-tab ${i === (proj.activeTerminalIdx || 0) ? 'active' : ''}`}
              onClick={() => (window as any).switchToTerminal?.(proj.id, i)}
            >
              {t.name || 'bash'}
            </div>
          ))}
        </div>
      )}

      {terminals.length > 0 ? (
        <MobileTerminalOutput proj={proj} />
      ) : (
        <div className="mobile-empty-state" style={{ padding: '40px 20px' }}>
          <div className="mobile-empty-icon">&#x2B1B;</div>
          <div className="mobile-empty-title">No terminals open</div>
          <button className="mobile-quick-btn" onClick={() => (window as any).addTerminal?.()}>
            Open Terminal
          </button>
        </div>
      )}
    </div>
  );
}

function MobileTerminalOutput({ proj }: { proj: any }) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminals = proj.terminals || [];
  const termInfo = terminals[proj.activeTerminalIdx || 0];

  useEffect(() => {
    if (termRef.current && termInfo) {
      if (termInfo.shellId) {
        (window as any).attachXterm?.(termInfo.id, termInfo.shellId, termRef.current, 'shell');
      } else if (termInfo.sessionId) {
        (window as any).attachXterm?.(termInfo.id, termInfo.sessionId, termRef.current, 'terminal');
      }
    }
  }, [termInfo?.id]);

  return <div className="mobile-terminal-output" ref={termRef}></div>;
}
