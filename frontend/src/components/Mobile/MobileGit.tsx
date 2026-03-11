import React, { useState } from 'react';
import { useStore } from '../../state/store';
import { GitHistory } from '../Git/GitHistory';
import { IssuesPanel, PullsPanel, useGitHubStatus } from '../GitHub/GitHubPanel';

export function MobileGit() {
  const { activeProjectId, projects } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);
  const [tab, setTab] = useState<'history' | 'issues' | 'prs'>('history');
  const { status: ghStatus } = useGitHubStatus(activeProjectId);

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

  const ghAvailable = ghStatus?.available ?? false;

  return (
    <div className="mobile-git">
      <div className="mobile-git-tabs">
        <button className={`mobile-git-tab${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>History</button>
        <button
          className={`mobile-git-tab${tab === 'issues' ? ' active' : ''}${!ghAvailable ? ' disabled' : ''}`}
          onClick={() => ghAvailable && setTab('issues')}
          title={!ghAvailable ? 'GitHub CLI not available' : undefined}
        >
          Issues
        </button>
        <button
          className={`mobile-git-tab${tab === 'prs' ? ' active' : ''}${!ghAvailable ? ' disabled' : ''}`}
          onClick={() => ghAvailable && setTab('prs')}
          title={!ghAvailable ? 'GitHub CLI not available' : undefined}
        >
          PRs
        </button>
      </div>
      {tab === 'history' && <GitHistory />}
      {tab === 'issues' && ghStatus && <IssuesPanel projectId={proj.id} ghStatus={ghStatus} />}
      {tab === 'prs' && ghStatus && <PullsPanel projectId={proj.id} ghStatus={ghStatus} />}
    </div>
  );
}
