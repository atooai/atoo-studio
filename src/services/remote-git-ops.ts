import { sshManager } from './ssh-manager.js';
import { parseRefs } from './git-ops.js';

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function git(connId: string, args: string[], cwd: string): Promise<string> {
  const escapedArgs = args.map(a => shellEscape(a)).join(' ');
  return sshManager.exec(connId, `git ${escapedArgs}`, { cwd });
}

export async function gitInit(connId: string, cwd: string) {
  await git(connId, ['init'], cwd);
}

export async function gitClone(connId: string, url: string, dest: string): Promise<void> {
  await sshManager.exec(connId, `git clone ${shellEscape(url)} ${shellEscape(dest)}`);
}

export async function gitStatus(connId: string, cwd: string) {
  const output = await git(connId, ['status', '--porcelain', '-uall', '-M'], cwd);
  return output.split('\n').filter(Boolean).map(line => {
    const x = line[0];
    const y = line[1];
    const rest = line.substring(3);
    let file = rest;
    let oldPath: string | undefined;
    if (x === 'R' || y === 'R') {
      const arrowIdx = rest.indexOf(' -> ');
      if (arrowIdx >= 0) {
        file = rest.substring(0, arrowIdx);
        oldPath = rest.substring(arrowIdx + 4);
      }
    }
    let status = (x + y).trim() || '?';
    const staged = x !== ' ' && x !== '?' && x !== '!';
    return { status, file, staged, indexStatus: x, workTreeStatus: y, oldPath };
  });
}

export async function gitLog(connId: string, cwd: string, branch?: string, count: number = 30) {
  const SEP = '---GIT-LOG-SEP---';
  const args = ['log', `--format=${SEP}%n%H%n%h%n%an%n%ar%n%D%n%s%n%B`, '-n', String(count)];
  if (branch) args.push(branch);
  const output = await git(connId, args, cwd);
  const entries = output.split(SEP).filter(e => e.trim());

  return entries.map(entry => {
    const lines = entry.trim().split('\n');
    const fullHash = lines[0] || '';
    const hash = lines[1] || '';
    const author = lines[2] || '';
    const date = lines[3] || '';
    const decorate = lines[4] || '';
    const msg = lines[5] || '';
    const fullMessage = lines.slice(6).join('\n').trim() || msg;
    const isMerge = msg.toLowerCase().startsWith('merge');
    const refs = parseRefs(decorate);
    return { hash, fullHash, msg, fullMessage, author, date, files: [], merge: isMerge, refs };
  });
}

export async function gitCommitFiles(connId: string, cwd: string, hash: string) {
  const output = await git(connId, ['diff-tree', '--no-commit-id', '-r', '--name-status', hash], cwd);
  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const statusChar = parts[0]?.[0] || 'M';
    const filePath = parts[1] || '';
    const statusMap: Record<string, string> = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C' };
    return { path: filePath, status: statusMap[statusChar] || 'M', additions: 0, deletions: 0 };
  });
}

export async function gitBranches(connId: string, cwd: string) {
  const output = await git(connId, ['branch', '-a', '--no-color'], cwd);
  const branches: string[] = [];
  let currentBranch = '';
  output.split('\n').filter(Boolean).forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('* ')) {
      currentBranch = trimmed.substring(2);
      branches.push(currentBranch);
    } else {
      branches.push(trimmed);
    }
  });
  return { branches, currentBranch };
}

export async function gitCheckout(connId: string, cwd: string, branch: string) {
  await git(connId, ['checkout', branch], cwd);
}

export async function gitCommit(connId: string, cwd: string, message: string) {
  await git(connId, ['add', '-A'], cwd);
  await git(connId, ['commit', '-m', message], cwd);
}

export async function gitPush(connId: string, cwd: string) {
  await git(connId, ['push'], cwd);
}

export async function gitStash(connId: string, cwd: string) {
  await git(connId, ['stash', 'push'], cwd);
}

export async function gitStashList(connId: string, cwd: string) {
  const output = await git(connId, ['stash', 'list'], cwd);
  return output.split('\n').filter(Boolean).map((line, i) => ({
    id: `stash@{${i}}`,
    name: line,
  }));
}

export async function gitStashApply(connId: string, cwd: string, id: string) {
  await git(connId, ['stash', 'apply', id], cwd);
}

export async function gitStashDrop(connId: string, cwd: string, id: string) {
  await git(connId, ['stash', 'drop', id], cwd);
}

export async function gitCreateBranch(connId: string, cwd: string, name: string) {
  await git(connId, ['checkout', '-b', name], cwd);
}

export async function gitFetch(connId: string, cwd: string) {
  await git(connId, ['fetch', '--all'], cwd);
}

export async function gitRemotes(connId: string, cwd: string) {
  const output = await git(connId, ['remote', '-v'], cwd);
  const remotes: { name: string; url: string; type: string }[] = [];
  const seen = new Set<string>();
  output.split('\n').filter(Boolean).forEach(line => {
    const parts = line.split(/\s+/);
    const name = parts[0];
    const url = parts[1];
    if (!seen.has(name)) {
      seen.add(name);
      remotes.push({ name, url, type: url.includes('@') ? 'ssh' : 'https' });
    }
  });
  return remotes;
}

export async function gitAddRemote(connId: string, cwd: string, name: string, url: string) {
  await git(connId, ['remote', 'add', name, url], cwd);
}

export async function gitRemoveRemote(connId: string, cwd: string, name: string) {
  await git(connId, ['remote', 'remove', name], cwd);
}

export async function gitEditRemote(connId: string, cwd: string, name: string, url: string) {
  await git(connId, ['remote', 'set-url', name, url], cwd);
}

export async function gitDiff(connId: string, cwd: string, file?: string) {
  const args = ['diff'];
  if (file) args.push('--', file);
  return await git(connId, args, cwd);
}

export async function gitRevert(connId: string, cwd: string, file?: string) {
  if (file) {
    await git(connId, ['checkout', '--', file], cwd);
  } else {
    await git(connId, ['checkout', '.'], cwd);
    await git(connId, ['clean', '-fd'], cwd);
  }
}

export async function gitUnstageFile(connId: string, cwd: string, file: string) {
  await git(connId, ['reset', 'HEAD', '--', file], cwd);
}

export async function gitStageFile(connId: string, cwd: string, file: string) {
  await git(connId, ['add', file], cwd);
}

export async function gitShowFile(connId: string, cwd: string, file: string, ref: string = 'HEAD') {
  return await git(connId, ['show', `${ref}:${file}`], cwd);
}

export async function gitBlame(connId: string, cwd: string, file: string) {
  return await git(connId, ['blame', '--porcelain', file], cwd);
}

export async function gitFileLog(connId: string, cwd: string, file: string) {
  const output = await git(connId, ['log', '--format=%h|%an|%ar|%s', '-n', '20', '--follow', '--', file], cwd);
  return output.split('\n').filter(Boolean).map(line => {
    const [hash, author, date, ...msgParts] = line.split('|');
    return { hash, author, date, msg: msgParts.join('|') };
  });
}

export async function gitWorktreeList(connId: string, cwd: string) {
  const output = await git(connId, ['worktree', 'list', '--porcelain'], cwd);
  const worktrees: { path: string; head: string; branch: string; bare?: boolean }[] = [];
  let current: any = {};
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.substring(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.branch = '(detached)';
    }
  }
  if (current.path) worktrees.push(current);
  return worktrees;
}

export async function gitWorktreeAdd(connId: string, cwd: string, wtPath: string, branch?: string, newBranch?: boolean) {
  const args = ['worktree', 'add'];
  if (newBranch && branch) {
    args.push('-b', branch, wtPath);
  } else if (branch) {
    args.push(wtPath, branch);
  } else {
    args.push(wtPath);
  }
  await git(connId, args, cwd);
}

export async function gitWorktreeRemove(connId: string, cwd: string, worktreePath: string) {
  await git(connId, ['worktree', 'remove', worktreePath], cwd);
}

export async function gitBranchDelete(connId: string, cwd: string, branch: string) {
  await git(connId, ['branch', '-D', branch], cwd);
}
