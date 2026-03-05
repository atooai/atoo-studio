import React, { useEffect, useRef } from 'react';
import { useStore } from '../../state/store';

export function ContextMenu() {
  const { ctxMenu, setCtxMenu } = useStore();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const tid = setTimeout(() => document.addEventListener('mousedown', close), 0);
    return () => { clearTimeout(tid); document.removeEventListener('mousedown', close); };
  }, [ctxMenu, setCtxMenu]);

  if (!ctxMenu) return null;

  let x = ctxMenu.x, y = ctxMenu.y;
  if (x + 220 > window.innerWidth) x = window.innerWidth - 228;
  if (y + 300 > window.innerHeight) y = Math.max(8, window.innerHeight - 308);

  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ display: 'block', left: x, top: y }}
    >
      {ctxMenu.items.map((item, i) => {
        if (item.separator) return <div key={i} className="ctx-sep"></div>;
        if (item.groupLabel) return <div key={i} className="ctx-group-label">{item.groupLabel}</div>;
        return (
          <div
            key={i}
            className={`ctx-item${item.danger ? ' danger' : ''}`}
            onClick={() => { item.action(); setCtxMenu(null); }}
          >
            <span className="ctx-icon">{item.icon}</span>
            <span className="ctx-label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
