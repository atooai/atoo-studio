import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../../api';
import { renderMd } from '../../utils';
import type { LinkedIssue, GitHubIssueDetail, GitHubPullDetail } from '../../types';

type IssueOrPrDetail = GitHubIssueDetail | GitHubPullDetail;

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

export function IssueDetailPanel({ linkedIssue, projectId, sessionId }: {
  linkedIssue: LinkedIssue;
  projectId: string;
  sessionId: string;
}) {
  const [detail, setDetail] = useState<IssueOrPrDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = linkedIssue.type === 'issue'
        ? `/api/projects/${projectId}/github/issues/${linkedIssue.number}`
        : `/api/projects/${projectId}/github/pulls/${linkedIssue.number}`;
      const result = await api('GET', endpoint);
      setDetail(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load details');
    } finally {
      setLoading(false);
    }
  }, [projectId, linkedIssue.number, linkedIssue.type]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // Listen for MCP github_issue_pr_changed events and refresh when this issue/PR is changed
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.number === linkedIssue.number && detail.itemType === linkedIssue.type) {
        fetchDetail();
      }
    };
    window.addEventListener('github-issue-pr-changed', handler);
    return () => window.removeEventListener('github-issue-pr-changed', handler);
  }, [linkedIssue.number, linkedIssue.type, fetchDetail]);

  const injectMessage = (text: string) => {
    (window as any).sendMessageToSession?.(sessionId, text);
  };

  const handleAnalyse = () => {
    injectMessage(
      `Analyse GitHub ${linkedIssue.type} #${linkedIssue.number} ("${linkedIssue.title}"). ` +
      `Retrieve the full ${linkedIssue.type} details using the gh CLI, understand the problem described, ` +
      `review the relevant code, and provide a thorough analysis. Do NOT make any code changes.`
    );
  };

  const handleAutoFix = () => {
    injectMessage(
      `AutoFix GitHub issue #${linkedIssue.number} ("${linkedIssue.title}"). ` +
      `Retrieve the full issue details using the gh CLI, understand the problem, ` +
      `find the root cause in the codebase, and implement a fix.`
    );
  };

  const handleReview = () => {
    injectMessage(
      `Review GitHub pull request #${linkedIssue.number} ("${linkedIssue.title}"). ` +
      `Retrieve the full PR details and diff using the gh CLI, review the code changes thoroughly, ` +
      `check for bugs, security issues, performance concerns, and code quality. ` +
      `Provide a detailed review with actionable feedback.`
    );
  };

  const handleClose = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const endpoint = linkedIssue.type === 'issue'
        ? `/api/projects/${projectId}/github/issues/${linkedIssue.number}/state`
        : `/api/projects/${projectId}/github/pulls/${linkedIssue.number}/state`;
      await api('POST', endpoint, { action: 'close' });
      fetchDetail();
    } catch (err: any) {
      console.error('Failed to close:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleReopen = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const endpoint = linkedIssue.type === 'issue'
        ? `/api/projects/${projectId}/github/issues/${linkedIssue.number}/state`
        : `/api/projects/${projectId}/github/pulls/${linkedIssue.number}/state`;
      await api('POST', endpoint, { action: 'reopen' });
      fetchDetail();
    } catch (err: any) {
      console.error('Failed to reopen:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenInGithub = () => {
    window.open(linkedIssue.url, '_blank');
  };

  const isOpen = detail?.state === 'OPEN';
  const isPr = linkedIssue.type === 'pr';
  const isMerged = isPr && detail?.state === 'MERGED';

  return (
    <div className="issue-detail-panel">
      {/* Button bar */}
      <div className="issue-action-bar">
        {isPr ? (
          <button className="issue-action-btn issue-action-review" onClick={handleReview} title="Inject review prompt into agent">
            Review
          </button>
        ) : (
          <>
            <button className="issue-action-btn issue-action-analyse" onClick={handleAnalyse} title="Inject analyse prompt into agent">
              Analyse
            </button>
            <button className="issue-action-btn issue-action-autofix" onClick={handleAutoFix} title="Inject autofix prompt into agent">
              AutoFix
            </button>
          </>
        )}
        {!isMerged && (
          isOpen ? (
            <button className="issue-action-btn issue-action-close" onClick={handleClose} disabled={busy}>
              {busy ? '...' : 'Close'}
            </button>
          ) : (
            <button className="issue-action-btn issue-action-reopen" onClick={handleReopen} disabled={busy}>
              {busy ? '...' : 'Reopen'}
            </button>
          )
        )}
        <div style={{ flex: 1 }} />
        <button className="issue-action-btn issue-action-refresh" onClick={fetchDetail} title="Refresh">
          Refresh
        </button>
        <button className="issue-action-btn issue-action-github" onClick={handleOpenInGithub} title="Open in GitHub">
          GitHub
        </button>
      </div>

      {/* Content */}
      <div className="issue-detail-content" ref={scrollRef}>
        {loading && !detail ? (
          <div className="issue-detail-loading">Loading...</div>
        ) : error ? (
          <div className="issue-detail-error">{error}</div>
        ) : detail ? (
          <>
            {/* Issue/PR header */}
            <div className="issue-detail-header">
              <span className={`issue-detail-state ${detail.state.toLowerCase()}`}>
                {detail.state}
              </span>
              <span className="issue-detail-author">{detail.author?.login}</span>
              <span className="issue-detail-time">{timeAgo(detail.createdAt)}</span>
              {detail.labels.length > 0 && (
                <div className="issue-detail-labels">
                  {detail.labels.map(l => (
                    <span key={l.name} className="issue-detail-label" style={{
                      backgroundColor: `#${l.color}`,
                      color: parseInt(l.color.slice(0, 2), 16) * 0.299 +
                             parseInt(l.color.slice(2, 4), 16) * 0.587 +
                             parseInt(l.color.slice(4, 6), 16) * 0.114 > 128 ? '#000' : '#fff'
                    }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* PR branch info */}
            {isPr && 'headRefName' in detail && (
              <div className="issue-detail-pr-info">
                <span className="issue-detail-branch">{(detail as GitHubPullDetail).headRefName}</span>
                <span className="issue-detail-arrow">&larr;</span>
                <span className="issue-detail-branch">{(detail as GitHubPullDetail).baseRefName}</span>
                {((detail as GitHubPullDetail).additions > 0 || (detail as GitHubPullDetail).deletions > 0) && (
                  <span className="issue-detail-diff">
                    <span className="issue-detail-add">+{(detail as GitHubPullDetail).additions}</span>
                    <span className="issue-detail-del">-{(detail as GitHubPullDetail).deletions}</span>
                  </span>
                )}
              </div>
            )}

            {/* Body */}
            {detail.body ? (
              <div
                className="issue-detail-body markdown-body"
                dangerouslySetInnerHTML={{ __html: renderMd(detail.body) }}
              />
            ) : (
              <div className="issue-detail-body issue-detail-empty">No description provided.</div>
            )}

            {/* Comments */}
            {detail.comments_list && detail.comments_list.length > 0 && (
              <div className="issue-detail-comments">
                <div className="issue-detail-comments-header">
                  {detail.comments_list.length} comment{detail.comments_list.length !== 1 ? 's' : ''}
                </div>
                {detail.comments_list.map((comment, i) => (
                  <div key={i} className="issue-detail-comment">
                    <div className="issue-detail-comment-header">
                      <span className="issue-detail-comment-author">{comment.author?.login}</span>
                      <span className="issue-detail-comment-time">{timeAgo(comment.createdAt)}</span>
                    </div>
                    <div
                      className="issue-detail-comment-body markdown-body"
                      dangerouslySetInnerHTML={{ __html: renderMd(comment.body) }}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
