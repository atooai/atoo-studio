import { execFile } from 'child_process';

const TIMEOUT = 15000;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function gitInit(cwd: string) {
  await git(['init'], cwd);
}

export async function gitStatus(cwd: string) {
  const output = await git(['status', '--porcelain', '-uall'], cwd);
  return output.split('\n').filter(Boolean).map(line => {
    const status = line.substring(0, 2).trim();
    const file = line.substring(3);
    return { status, file };
  });
}

export async function gitLog(cwd: string, branch?: string, count: number = 30) {
  const SEP = '---GIT-LOG-SEP---';
  const args = ['log', `--format=${SEP}%n%H%n%h%n%an%n%ar%n%s%n%B`, '-n', String(count)];
  if (branch) args.push(branch);
  const output = await git(args, cwd);
  const entries = output.split(SEP).filter(e => e.trim());

  return entries.map(entry => {
    const lines = entry.trim().split('\n');
    const fullHash = lines[0] || '';
    const hash = lines[1] || '';
    const author = lines[2] || '';
    const date = lines[3] || '';
    const msg = lines[4] || '';
    const fullMessage = lines.slice(5).join('\n').trim() || msg;
    const isMerge = msg.toLowerCase().startsWith('merge');

    return { hash, fullHash, msg, fullMessage, author, date, files: [], merge: isMerge };
  });
}

export async function gitCommitFiles(cwd: string, hash: string) {
  const output = await git(['diff-tree', '--no-commit-id', '-r', '--name-status', hash], cwd);
  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const statusChar = parts[0]?.[0] || 'M';
    const filePath = parts[1] || '';
    const statusMap: Record<string, string> = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C' };
    return { path: filePath, status: statusMap[statusChar] || 'M', additions: 0, deletions: 0 };
  });
}

export async function gitBranches(cwd: string) {
  const output = await git(['branch', '-a', '--no-color'], cwd);
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

export async function gitCheckout(cwd: string, branch: string) {
  await git(['checkout', branch], cwd);
}

export async function gitCommit(cwd: string, message: string) {
  await git(['add', '-A'], cwd);
  await git(['commit', '-m', message], cwd);
}

export async function gitPush(cwd: string) {
  await git(['push'], cwd);
}

export async function gitStash(cwd: string) {
  await git(['stash', 'push'], cwd);
}

export async function gitStashList(cwd: string) {
  const output = await git(['stash', 'list'], cwd);
  return output.split('\n').filter(Boolean).map((line, i) => ({
    id: `stash@{${i}}`,
    name: line,
  }));
}

export async function gitStashApply(cwd: string, id: string) {
  await git(['stash', 'apply', id], cwd);
}

export async function gitStashDrop(cwd: string, id: string) {
  await git(['stash', 'drop', id], cwd);
}

export async function gitCreateBranch(cwd: string, name: string) {
  await git(['checkout', '-b', name], cwd);
}

export async function gitFetch(cwd: string) {
  await git(['fetch', '--all'], cwd);
}

export async function gitRemotes(cwd: string) {
  const output = await git(['remote', '-v'], cwd);
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

export async function gitAddRemote(cwd: string, name: string, url: string) {
  await git(['remote', 'add', name, url], cwd);
}

export async function gitRemoveRemote(cwd: string, name: string) {
  await git(['remote', 'remove', name], cwd);
}

export async function gitEditRemote(cwd: string, name: string, url: string) {
  await git(['remote', 'set-url', name, url], cwd);
}

export async function gitDiff(cwd: string, file?: string) {
  const args = ['diff'];
  if (file) args.push('--', file);
  return await git(args, cwd);
}

export async function gitRevert(cwd: string, file?: string) {
  if (file) {
    await git(['checkout', '--', file], cwd);
  } else {
    await git(['checkout', '.'], cwd);
    await git(['clean', '-fd'], cwd);
  }
}

export async function gitStageFile(cwd: string, file: string) {
  await git(['add', file], cwd);
}

export async function gitBlame(cwd: string, file: string) {
  const output = await git(['blame', '--porcelain', file], cwd);
  return output;
}

export async function gitFileLog(cwd: string, file: string) {
  const output = await git(['log', '--format=%h|%an|%ar|%s', '-n', '20', '--follow', '--', file], cwd);
  return output.split('\n').filter(Boolean).map(line => {
    const [hash, author, date, ...msgParts] = line.split('|');
    return { hash, author, date, msg: msgParts.join('|') };
  });
}
