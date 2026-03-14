import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from '../../api';
import type { GitHubStatus, GitHubIssue, GitHubPull } from '../../types';

// ═══════════════════════════════════════════════════════
// Shared utilities
// ═══════════════════════════════════════════════════════

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function labelTextColor(bgHex: string): string {
  // Determine if label needs light or dark text
  const r = parseInt(bgHex.slice(0, 2), 16);
  const g = parseInt(bgHex.slice(2, 4), 16);
  const b = parseInt(bgHex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000' : '#fff';
}

// ═══════════════════════════════════════════════════════
// Virtual scroll hook
// ═══════════════════════════════════════════════════════

const ITEM_HEIGHT = 72; // approximate card height in pixels
const OVERSCAN = 5;

function useVirtualScroll<T>(items: T[], containerRef: React.RefObject<HTMLDivElement | null>) {
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => setScrollTop(el.scrollTop);
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });

    el.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(el);
    setContainerHeight(el.clientHeight);

    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [containerRef]);

  const totalHeight = items.length * ITEM_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN);
  const visibleItems = items.slice(startIdx, endIdx);
  const offsetY = startIdx * ITEM_HEIGHT;

  return { totalHeight, visibleItems, offsetY, startIdx };
}

// ═══════════════════════════════════════════════════════
// Filters bar
// ═══════════════════════════════════════════════════════

function FiltersBar({ type, state, onStateChange, search, onSearchChange, loading, onAddClick }: {
  type: 'issues' | 'pulls';
  state: string;
  onStateChange: (s: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
  loading: boolean;
  onAddClick?: () => void;
}) {
  const states = type === 'pulls'
    ? [['open', 'Open'], ['closed', 'Closed'], ['merged', 'Merged'], ['all', 'All']]
    : [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']];

  return (
    <div className="gh-filters-bar">
      <div className="gh-state-filters">
        {states.map(([value, label]) => (
          <button
            key={value}
            className={`gh-state-btn${state === value ? ' active' : ''}`}
            onClick={() => onStateChange(value)}
          >
            {label}
          </button>
        ))}
        {onAddClick && (
          <button
            className="gh-state-btn gh-add-issue-btn"
            onClick={onAddClick}
            title="Create New Issue"
          >
            +
          </button>
        )}
      </div>
      <div className="gh-search-wrap">
        <input
          className="gh-search-input"
          type="text"
          placeholder={`Search ${type}...`}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {loading && <div className="gh-search-spinner" />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Issue card
// ═══════════════════════════════════════════════════════

function IssueCard({ issue, canWrite, projectId, onStateChanged }: {
  issue: GitHubIssue;
  canWrite: boolean;
  projectId: string;
  onStateChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const toggleState = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const action = issue.state === 'OPEN' ? 'close' : 'reopen';
      await api('POST', `/api/projects/${projectId}/github/issues/${issue.number}/state`, { action });
      onStateChanged();
    } catch (err) {
      console.error('Failed to update issue state:', err);
    } finally {
      setBusy(false);
    }
  };

  const openIssueSession = () => {
    (window as any).newIssueSession({ number: issue.number, title: issue.title, url: issue.url });
  };

  const openInGithub = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(issue.url, '_blank');
  };

  const stateClass = issue.state === 'OPEN' ? 'open' : 'closed';

  return (
    <div className="gh-card" onClick={openIssueSession}>
      <div className={`gh-card-state-dot ${stateClass}`} />
      <div className="gh-card-body">
        <div className="gh-card-title-row">
          <span className="gh-card-number">#{issue.number}</span>
          <span className="gh-card-title">{issue.title}</span>
        </div>
        {issue.labels.length > 0 && (
          <div className="gh-card-labels">
            {issue.labels.map(l => (
              <span
                key={l.name}
                className="gh-label"
                style={{ backgroundColor: `#${l.color}`, color: labelTextColor(l.color) }}
              >
                {l.name}
              </span>
            ))}
          </div>
        )}
        <div className="gh-card-meta">
          <span>{issue.author?.login}</span>
          <span>{timeAgo(issue.updatedAt)}</span>
          {issue.comments?.totalCount > 0 && <span>{issue.comments.totalCount} comments</span>}
          {issue.milestone && <span>{issue.milestone.title}</span>}
        </div>
      </div>
      <div className="gh-card-actions">
        {canWrite && (
          <button
            className={`gh-card-action-btn ${stateClass}`}
            onClick={toggleState}
            disabled={busy}
            title={issue.state === 'OPEN' ? 'Close issue' : 'Reopen issue'}
          >
            {busy ? '...' : issue.state === 'OPEN' ? 'Close' : 'Reopen'}
          </button>
        )}
        <button className="gh-card-action-btn gh-action-github" onClick={openInGithub} title="Open in GitHub">
          GitHub
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Pull Request card
// ═══════════════════════════════════════════════════════

function PullCard({ pull, canWrite, projectId, onStateChanged }: {
  pull: GitHubPull;
  canWrite: boolean;
  projectId: string;
  onStateChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const toggleState = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const action = pull.state === 'OPEN' ? 'close' : 'reopen';
      await api('POST', `/api/projects/${projectId}/github/pulls/${pull.number}/state`, { action });
      onStateChanged();
    } catch (err) {
      console.error('Failed to update PR state:', err);
    } finally {
      setBusy(false);
    }
  };

  const openPrSession = () => {
    (window as any).newPrSession({ number: pull.number, title: pull.title, url: pull.url });
  };

  const openInGithub = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(pull.url, '_blank');
  };

  const stateClass = pull.state === 'MERGED' ? 'merged' : pull.state === 'OPEN' ? 'open' : 'closed';
  const reviewIcon = pull.reviewDecision === 'APPROVED' ? '\u2713'
    : pull.reviewDecision === 'CHANGES_REQUESTED' ? '\u2717'
    : pull.reviewDecision === 'REVIEW_REQUIRED' ? '\u25CB'
    : null;

  return (
    <div className="gh-card" onClick={openPrSession}>
      <div className={`gh-card-state-dot ${stateClass}`} />
      <div className="gh-card-body">
        <div className="gh-card-title-row">
          <span className="gh-card-number">#{pull.number}</span>
          {pull.isDraft && <span className="gh-draft-badge">Draft</span>}
          <span className="gh-card-title">{pull.title}</span>
        </div>
        <div className="gh-pr-branch">
          <span className="gh-branch-name">{pull.headRefName}</span>
          <span className="gh-branch-arrow">&larr;</span>
          <span className="gh-branch-name">{pull.baseRefName}</span>
          {(pull.additions > 0 || pull.deletions > 0) && (
            <span className="gh-diff-stat">
              <span className="gh-additions">+{pull.additions}</span>
              <span className="gh-deletions">-{pull.deletions}</span>
            </span>
          )}
          {reviewIcon && (
            <span className={`gh-review-badge ${pull.reviewDecision?.toLowerCase()}`}>{reviewIcon}</span>
          )}
        </div>
        {pull.labels.length > 0 && (
          <div className="gh-card-labels">
            {pull.labels.map(l => (
              <span
                key={l.name}
                className="gh-label"
                style={{ backgroundColor: `#${l.color}`, color: labelTextColor(l.color) }}
              >
                {l.name}
              </span>
            ))}
          </div>
        )}
        <div className="gh-card-meta">
          <span>{pull.author?.login}</span>
          <span>{timeAgo(pull.updatedAt)}</span>
          {pull.comments?.totalCount > 0 && <span>{pull.comments.totalCount} comments</span>}
        </div>
      </div>
      <div className="gh-card-actions">
        {canWrite && pull.state !== 'MERGED' && (
          <button
            className={`gh-card-action-btn ${stateClass}`}
            onClick={toggleState}
            disabled={busy}
            title={pull.state === 'OPEN' ? 'Close PR' : 'Reopen PR'}
          >
            {busy ? '...' : pull.state === 'OPEN' ? 'Close' : 'Reopen'}
          </button>
        )}
        <button className="gh-card-action-btn gh-action-github" onClick={openInGithub} title="Open in GitHub">
          GitHub
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// List component (shared for issues and PRs)
// ═══════════════════════════════════════════════════════

function GitHubList<T extends { number: number }>({
  projectId,
  type,
  fetchUrl,
  renderCard,
  ghStatus,
  onAddClick,
}: {
  projectId: string;
  type: 'issues' | 'pulls';
  fetchUrl: string;
  renderCard: (item: T, onRefresh: () => void) => React.ReactNode;
  ghStatus: GitHubStatus;
  onAddClick?: () => void;
}) {
  const [items, setItems] = useState<T[]>([]);
  const [state, setState] = useState('open');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const lastFetchKey = useRef('');

  const fetchItems = useCallback(async (filterState: string, filterSearch: string, append = false, limit = 50) => {
    const key = `${projectId}:${filterState}:${filterSearch}:${limit}`;
    // Avoid duplicate fetches (but not on append)
    if (!append && key === lastFetchKey.current) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({ state: filterState, limit: String(limit) });
      if (filterSearch) params.set('search', filterSearch);
      const result = await api('GET', `/api/projects/${projectId}/${fetchUrl}?${params}`);

      if (append) {
        setItems(prev => {
          const existingNums = new Set(prev.map((i: any) => i.number));
          const newItems = result.items.filter((i: any) => !existingNums.has(i.number));
          return [...prev, ...newItems];
        });
      } else {
        // Merge to avoid flicker: update in-place by number
        setItems(prev => {
          if (prev.length === 0) return result.items;
          const newMap = new Map<number, T>();
          for (const item of result.items) newMap.set((item as any).number, item);
          // If the result set is fundamentally different, just replace
          const prevNums = new Set(prev.map((i: any) => i.number));
          const newNums = new Set(result.items.map((i: any) => i.number));
          const same = prevNums.size === newNums.size && [...prevNums].every(n => newNums.has(n));
          if (!same) return result.items;
          // Same set of numbers: update each item
          return prev.map(old => newMap.get((old as any).number) || old);
        });
      }
      setHasMore(result.hasMore);
      lastFetchKey.current = key;
      setInitialLoad(false);
    } catch (err) {
      console.error(`Failed to fetch ${type}:`, err);
    } finally {
      setLoading(false);
    }
  }, [projectId, fetchUrl, type]);

  // Reset and fetch on project change
  useEffect(() => {
    setItems([]);
    setState('open');
    setSearch('');
    setHasMore(false);
    setInitialLoad(true);
    lastFetchKey.current = '';
    fetchItems('open', '');
  }, [projectId]);

  // State filter change: immediate fetch
  useEffect(() => {
    if (initialLoad) return;
    lastFetchKey.current = ''; // force refetch
    setItems([]);
    fetchItems(state, search);
  }, [state]);

  // Search: debounced fetch
  useEffect(() => {
    if (initialLoad) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      lastFetchKey.current = ''; // force refetch
      setItems([]);
      fetchItems(state, search);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  // 30s polling
  useEffect(() => {
    pollRef.current = setInterval(() => {
      fetchItems(state, search);
    }, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [state, search, projectId, fetchItems]);

  // Listen for MCP github_issue_pr_changed events and refresh the list
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Refresh if the changed item type matches this list's type
      const matchesType = (type === 'issues' && detail.itemType === 'issue') ||
                          (type === 'pulls' && detail.itemType === 'pr');
      if (matchesType) {
        lastFetchKey.current = ''; // force refetch
        fetchItems(state, search);
      }
    };
    window.addEventListener('github-issue-pr-changed', handler);
    return () => window.removeEventListener('github-issue-pr-changed', handler);
  }, [type, state, search, fetchItems]);

  // Load more on scroll near bottom (for virtual scroll "infinite load")
  const handleRefresh = useCallback(() => {
    lastFetchKey.current = ''; // force refetch
    fetchItems(state, search);
  }, [state, search, fetchItems]);

  // Virtual scroll
  const { totalHeight, visibleItems, offsetY, startIdx } = useVirtualScroll(items, containerRef);

  // Infinite scroll: detect when scrolled near bottom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!hasMore || loading) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
      if (nearBottom) {
        fetchItems(state, search, true, items.length + 50);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [hasMore, loading, items.length, state, search, fetchItems]);

  return (
    <div className="gh-list-container">
      <FiltersBar
        type={type}
        state={state}
        onStateChange={setState}
        search={search}
        onSearchChange={setSearch}
        loading={loading}
        onAddClick={onAddClick}
      />
      <div className="gh-list-scroll" ref={containerRef}>
        {initialLoad && loading ? (
          <div className="gh-list-loading">Loading...</div>
        ) : items.length === 0 ? (
          <div className="gh-list-empty">
            No {type === 'issues' ? 'issues' : 'pull requests'} found
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
              {visibleItems.map((item, i) => (
                <div key={(item as any).number} style={{ height: ITEM_HEIGHT }}>
                  {renderCard(item, handleRefresh)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Issues panel
// ═══════════════════════════════════════════════════════

export function IssuesPanel({ projectId, ghStatus }: { projectId: string; ghStatus: GitHubStatus }) {
  const handleAddIssue = () => {
    (window as any).newIssueCreate?.();
  };

  return (
    <GitHubList<GitHubIssue>
      projectId={projectId}
      type="issues"
      fetchUrl="github/issues"
      ghStatus={ghStatus}
      onAddClick={handleAddIssue}
      renderCard={(issue, onRefresh) => (
        <IssueCard
          issue={issue}
          canWrite={ghStatus.canWrite}
          projectId={projectId}
          onStateChanged={onRefresh}
        />
      )}
    />
  );
}

// ═══════════════════════════════════════════════════════
// Pull Requests panel
// ═══════════════════════════════════════════════════════

export function PullsPanel({ projectId, ghStatus }: { projectId: string; ghStatus: GitHubStatus }) {
  return (
    <GitHubList<GitHubPull>
      projectId={projectId}
      type="pulls"
      fetchUrl="github/pulls"
      ghStatus={ghStatus}
      renderCard={(pull, onRefresh) => (
        <PullCard
          pull={pull}
          canWrite={ghStatus.canWrite}
          projectId={projectId}
          onStateChanged={onRefresh}
        />
      )}
    />
  );
}

// ═══════════════════════════════════════════════════════
// GitHub status hook (for parent components)
// ═══════════════════════════════════════════════════════

export function useGitHubStatus(projectId: string | null) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api('GET', `/api/projects/${projectId}/github/status`)
      .then(setStatus)
      .catch(() => setStatus({ available: false, owner: '', repo: '', canWrite: false }))
      .finally(() => setLoading(false));
  }, [projectId]);

  return { status, loading };
}
