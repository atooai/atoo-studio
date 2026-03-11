import React from 'react';
import { useStore } from '../../state/store';
import { GitHistory } from '../Git/GitHistory';

export function MobileGit() {
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);

  if (!proj) {
    return (
      <div className="mobile-empty-state">
        <div className="mobile-empty-icon">&#x1f33f;</div>
        <div className="mobile-empty-title">No project selected</div>
        <div className="mobile-empty-desc">Select a project to view git history</div>
      </div>
    );
  }

  if (!proj.isGit) {
    return (
      <div className="mobile-empty-state">
        <div className="mobile-empty-icon">&#x1f33f;</div>
        <div className="mobile-empty-title">Not a git repository</div>
        <div className="mobile-empty-desc">{proj.name} is not tracked by git</div>
      </div>
    );
  }

  return (
    <div className="mobile-git">
      <GitHistory />
    </div>
  );
}
