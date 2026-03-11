import { execFile } from 'child_process';

const TIMEOUT = 30000;

function gh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout: TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function whichGh(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', ['gh'], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

export interface GitHubStatus {
  available: boolean;
  owner: string;
  repo: string;
  canWrite: boolean;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  labels: { name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  comments: { totalCount: number };
  url: string;
  assignees: { login: string }[];
  milestone?: { title: string } | null;
}

export interface GitHubPull {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  labels: { name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  comments: { totalCount: number };
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  additions: number;
  deletions: number;
  assignees: { login: string }[];
}

export interface GitHubListResult<T> {
  items: T[];
  hasMore: boolean;
}

// Cache github status per cwd to avoid repeated detection
const statusCache = new Map<string, { status: GitHubStatus; ts: number }>();
const STATUS_CACHE_TTL = 60000; // 1 minute

export async function getGitHubStatus(cwd: string): Promise<GitHubStatus> {
  const cached = statusCache.get(cwd);
  if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL) {
    return cached.status;
  }

  const result: GitHubStatus = { available: false, owner: '', repo: '', canWrite: false };

  // Check if gh is installed
  const hasGh = await whichGh();
  if (!hasGh) return result;

  // Check for GitHub remote
  try {
    const remotes = await new Promise<string>((resolve, reject) => {
      execFile('git', ['remote', '-v'], { cwd, timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });

    const ghRemote = remotes.split('\n').find(line =>
      line.includes('github.com') && line.includes('(push)')
    );
    if (!ghRemote) return result;

    // Parse owner/repo from remote URL
    // Handles: git@github.com:owner/repo.git, https://github.com/owner/repo.git, etc.
    const match = ghRemote.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?(?:\s|$)/);
    if (!match) return result;

    result.owner = match[1];
    result.repo = match[2];
  } catch {
    return result;
  }

  // Check auth status
  try {
    const authOut = await gh(['auth', 'status'], cwd);
    result.available = true;

    // Check for write scopes
    // gh auth status outputs scopes like: Token scopes: 'delete_repo', 'gist', 'repo', 'workflow'
    const hasRepoScope = /['"]repo['"]/.test(authOut) || /Token scopes:.*\brepo\b/.test(authOut);
    const hasWriteScope = hasRepoScope || /['"]write:/.test(authOut) || /['"]public_repo['"]/.test(authOut);
    result.canWrite = hasWriteScope;
  } catch (err: any) {
    // gh auth status exits with error if not authenticated, but may still output info to stderr
    const msg = err.message || '';
    if (msg.includes('Logged in')) {
      result.available = true;
      // Conservative: if we can't parse scopes, assume read-only
      result.canWrite = /\brepo\b/.test(msg);
    }
    // Not authenticated at all - available stays false
  }

  statusCache.set(cwd, { status: result, ts: Date.now() });
  return result;
}

export function clearStatusCache(cwd?: string) {
  if (cwd) {
    statusCache.delete(cwd);
  } else {
    statusCache.clear();
  }
}

const ISSUE_FIELDS = 'number,title,state,author,labels,createdAt,updatedAt,comments,url,assignees,milestone';
const PR_FIELDS = 'number,title,state,author,labels,createdAt,updatedAt,comments,url,headRefName,baseRefName,isDraft,mergeable,reviewDecision,additions,deletions,assignees';

export async function listIssues(
  cwd: string,
  opts: { state?: string; search?: string; limit?: number; endCursor?: string } = {},
): Promise<GitHubListResult<GitHubIssue>> {
  const { state = 'open', search, limit = 50 } = opts;

  const args = ['issue', 'list', '--json', ISSUE_FIELDS, '--limit', String(limit + 1), '--state', state];

  if (search) {
    args.push('--search', search);
  }

  const out = await gh(args, cwd);
  const items: GitHubIssue[] = JSON.parse(out);

  const hasMore = items.length > limit;
  if (hasMore) items.length = limit;

  return { items, hasMore };
}

export async function listPulls(
  cwd: string,
  opts: { state?: string; search?: string; limit?: number } = {},
): Promise<GitHubListResult<GitHubPull>> {
  const { state = 'open', search, limit = 50 } = opts;

  const args = ['pr', 'list', '--json', PR_FIELDS, '--limit', String(limit + 1), '--state', state];

  if (search) {
    args.push('--search', search);
  }

  const out = await gh(args, cwd);
  const items: GitHubPull[] = JSON.parse(out);

  const hasMore = items.length > limit;
  if (hasMore) items.length = limit;

  return { items, hasMore };
}

export async function updateIssueState(
  cwd: string,
  number: number,
  action: 'close' | 'reopen',
): Promise<void> {
  if (action === 'close') {
    await gh(['issue', 'close', String(number)], cwd);
  } else {
    await gh(['issue', 'reopen', String(number)], cwd);
  }
}

export async function updatePullState(
  cwd: string,
  number: number,
  action: 'close' | 'reopen',
): Promise<void> {
  if (action === 'close') {
    await gh(['pr', 'close', String(number)], cwd);
  } else {
    await gh(['pr', 'reopen', String(number)], cwd);
  }
}
