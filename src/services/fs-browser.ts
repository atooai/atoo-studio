import fs from 'fs';
import path from 'path';

interface FileNode {
  name: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache', '.parcel-cache', 'coverage', '.svn', '.hg']);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 2000;

export function getFileTree(dirPath: string, depth: number = 0): FileNode[] {
  if (depth > MAX_DEPTH) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: FileNode[] = [];
  let count = 0;

  // Sort: dirs first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (count >= MAX_ENTRIES) break;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const children = getFileTree(path.join(dirPath, entry.name), depth + 1);
      result.push({ name: entry.name, type: 'dir', children });
    } else if (entry.isFile() || entry.isSymbolicLink()) {
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

export function readFileContent(filePath: string): { content: string; lang: string } {
  const content = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const basename = path.basename(filePath).toLowerCase();
  const lang = EXT_LANG_MAP[ext] || EXT_LANG_MAP[basename] || 'plaintext';
  return { content, lang };
}
