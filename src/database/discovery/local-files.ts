import { readFileSync, existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { execFileSync } from 'child_process';
import type { DiscoveredDatabase, DbType } from '../types.js';

const DB_EXTENSIONS: Record<string, DbType> = {
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.db': 'sqlite',
  '.duckdb': 'duckdb',
  '.parquet': 'duckdb',
};

/**
 * Scan a project directory for local database files.
 * Uses git ls-files + find to respect .gitignore.
 */
export function discoverLocalFiles(projectDir: string): DiscoveredDatabase[] {
  if (!projectDir || !existsSync(projectDir)) return [];

  const extensions = Object.keys(DB_EXTENSIONS);
  const pattern = extensions.map(e => `*${e}`).join(' -o -name ');

  let files: string[] = [];
  try {
    // Try git ls-files first (respects .gitignore)
    const gitOut = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectDir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();

    if (gitOut) {
      files = gitOut.split('\n').filter(f =>
        extensions.some(ext => f.toLowerCase().endsWith(ext))
      );
    }
  } catch {
    // Fallback: simple find, limited depth
    try {
      const findOut = execFileSync('find', [
        projectDir, '-maxdepth', '4', '-type', 'f',
        '(', ...extensions.flatMap((ext, i) => i === 0 ? ['-name', `*${ext}`] : ['-o', '-name', `*${ext}`]), ')',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.git/*',
      ], { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

      if (findOut) {
        files = findOut.split('\n').map(f => relative(projectDir, f));
      }
    } catch {}
  }

  return files.map(file => {
    const ext = '.' + file.split('.').pop()!.toLowerCase();
    const dbType = DB_EXTENSIONS[ext] || 'sqlite';
    const absPath = join(projectDir, file);
    return {
      id: `local:${file}`,
      name: basename(file),
      db_type: dbType,
      source: 'local' as const,
      params: { filename: absPath },
      source_detail: file,
    };
  });
}
