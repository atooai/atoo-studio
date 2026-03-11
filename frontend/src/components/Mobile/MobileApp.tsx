import React, { useEffect } from 'react';
import { useStore } from '../../state/store';
import { MobileTopBar } from './MobileTopBar';
import { MobileBottomNav } from './MobileBottomNav';
import { MobileDrawer } from './MobileDrawer';
import { MobileSheet } from './MobileSheet';
import { MobileDashboard } from './MobileDashboard';
import { MobileFiles } from './MobileFiles';
import { MobileGit } from './MobileGit';
import { MobileAgents } from './MobileAgents';
import { MobileTerminal } from './MobileTerminal';

export function MobileApp() {
  const { mobileView, mobileDrawerOpen, mobileSheetOpen } = useStore();

  // Swipe gesture: right from left edge opens drawer, left closes it
  useEffect(() => {
    let touchStartX = 0;
    const onStart = (e: TouchEvent) => { touchStartX = e.touches[0].clientX; };
    const onEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const store = useStore.getState();
      if (touchStartX < 30 && dx > 80 && !store.mobileDrawerOpen) {
        store.setMobileDrawerOpen(true);
      }
      if (dx < -80 && store.mobileDrawerOpen) {
        store.setMobileDrawerOpen(false);
      }
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, []);

  return (
    <div className="mobile-app">
      <MobileTopBar />
      <MobileContextBar />
      <div className="mobile-main">
        <MobileView name="dashboard" active={mobileView === 'dashboard'}><MobileDashboard /></MobileView>
        <MobileView name="files" active={mobileView === 'files'}><MobileFiles /></MobileView>
        <MobileView name="git" active={mobileView === 'git'}><MobileGit /></MobileView>
        <MobileView name="agents" active={mobileView === 'agents'}><MobileAgents /></MobileView>
        <MobileView name="terminal" active={mobileView === 'terminal'}><MobileTerminal /></MobileView>
      </div>
      <MobileBottomNav />
      <MobileDrawer />
      <MobileSheet />
    </div>
  );
}

function MobileView({ name, active, children }: { name: string; active: boolean; children: React.ReactNode }) {
  if (!active) return null;
  return <div className="mobile-view mobile-view-active">{children}</div>;
}

function MobileContextBar() {
  const { projects, activeProjectId } = useStore();
  if (projects.length === 0) return null;

  return (
    <div className="mobile-context-bar">
      {projects.map(p => (
        <div
          key={p.id}
          className={`mobile-ctx-chip ${p.id === activeProjectId ? 'active' : ''}`}
          onClick={() => (window as any).selectProject(p.id, p.pe_id || '')}
        >
          <span className={`mobile-ctx-dot status-${getProjectStatusClass(p)}`}></span>
          {p.name}
        </div>
      ))}
    </div>
  );
}

function getProjectStatusClass(p: any): string {
  if (p.sessions.some((s: any) => s.status === 'attention')) return 'attention';
  if (p.sessions.some((s: any) => s.status === 'active')) return 'active';
  return 'open';
}
