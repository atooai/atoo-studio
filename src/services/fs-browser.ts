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

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif', 'psd', 'avif',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma',
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm',
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz', 'zst',
  'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'deb', 'rpm', 'appimage',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'class', 'pyc', 'pyo', 'o', 'obj', 'wasm', 'a', 'lib',
  'sqlite', 'db', 'sqlite3',
]);

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (BINARY_EXTENSIONS.has(ext)) return true;
  // Check first 8KB for null bytes
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {}
  return false;
}

export function readFileContent(filePath: string): { content: string; lang: string; isBinary?: boolean; size?: number } {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const basename = path.basename(filePath).toLowerCase();
  const lang = EXT_LANG_MAP[ext] || EXT_LANG_MAP[basename] || 'plaintext';

  if (isBinaryFile(filePath)) {
    const stat = fs.statSync(filePath);
    return { content: '', lang, isBinary: true, size: stat.size };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return { content, lang };
}
