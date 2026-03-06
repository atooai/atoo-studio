import path from 'path';
import { sshManager } from './ssh-manager.js';

interface FileNode {
  name: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache', '.parcel-cache', 'coverage', '.svn', '.hg']);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 2000;

export async function getRemoteFileTree(connId: string, dirPath: string, depth: number = 0): Promise<FileNode[]> {
  if (depth > MAX_DEPTH) return [];

  let entries;
  try {
    entries = await sshManager.sftpReaddir(connId, dirPath);
  } catch {
    return [];
  }

  const result: FileNode[] = [];
  let count = 0;

  for (const entry of entries) {
    if (count >= MAX_ENTRIES) break;
    if (entry.type === 'dir') {
      if (SKIP_DIRS.has(entry.name)) continue;
      const children = await getRemoteFileTree(connId, path.posix.join(dirPath, entry.name), depth + 1);
      result.push({ name: entry.name, type: 'dir', children });
    } else {
      result.push({ name: entry.name, type: 'file' });
    }
    count++;
  }

  return result;
}

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  md: 'markdown', html: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  dockerfile: 'dockerfile', makefile: 'makefile',
  astro: 'html', vue: 'html', svelte: 'html',
};

export async function readRemoteFileContent(connId: string, filePath: string): Promise<{ content: string; lang: string }> {
  const content = await sshManager.sftpReadFile(connId, filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const basename = path.basename(filePath).toLowerCase();
  const lang = EXT_LANG_MAP[ext] || EXT_LANG_MAP[basename] || 'plaintext';
  return { content, lang };
}
