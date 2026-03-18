import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { isBinaryFile } from './fs-browser.js';

const SKIP_NAMES = new Set(['.git', '.atoo-studio', 'node_modules', '.next', '.nuxt', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache', '.parcel-cache', 'coverage', '.svn', '.hg']);
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

export interface SearchMatch {
  line: number;    // 1-based
  column: number;  // 0-based
  length: number;
  lineContent: string;
}

export interface SearchFileResult {
  file: string;           // relative path from project root
  matches: SearchMatch[];
  filenameMatch?: boolean;
}

export interface SearchRequest {
  query: string;
  isRegex?: boolean;
  matchCase?: boolean;
  matchWholeWord?: boolean;
  includeFilenames?: boolean;
  includeFilter?: string;
  excludeFilter?: string;
  includeFilterIsRegex?: boolean;
  excludeFilterIsRegex?: boolean;
  openFilesOnly?: string[];
  showHidden?: boolean;
  maxResults?: number;
}

export interface SearchResponse {
  results: SearchFileResult[];
  truncated: boolean;
  totalFiles: number;
  totalMatches: number;
}

export interface ReplaceRequest extends SearchRequest {
  replacement: string;
  preserveCase?: boolean;
  renameFiles?: boolean;
}

export interface ReplaceResponse {
  filesModified: number;
  totalReplacements: number;
  filesRenamed: number;
  errors: Array<{ file: string; error: string }>;
}

function buildSearchRegex(query: string, opts: { isRegex?: boolean; matchCase?: boolean; matchWholeWord?: boolean }): RegExp {
  let pattern = opts.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.matchWholeWord) pattern = `\\b${pattern}\\b`;
  const flags = opts.matchCase ? 'g' : 'gi';
  return new RegExp(pattern, flags);
}

function globToRegex(glob: string): string {
  // Simple glob-to-regex: * → [^/]*, ** → .*, ? → .
  return glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*');
}

function buildFilterRegex(filter: string, isRegex: boolean): RegExp | null {
  if (!filter.trim()) return null;
  if (isRegex) {
    return new RegExp(filter, 'i');
  }
  // Comma-separated globs
  const parts = filter.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const regexParts = parts.map(globToRegex);
  return new RegExp(`^(${regexParts.join('|')})$`, 'i');
}

function matchesFilter(relPath: string, filter: RegExp): boolean {
  const fileName = path.basename(relPath);
  // Match against both the full relative path and just the filename
  return filter.test(relPath) || filter.test(fileName);
}

function preserveCaseReplace(match: string, replacement: string): string {
  if (match === match.toUpperCase()) return replacement.toUpperCase();
  if (match === match.toLowerCase()) return replacement.toLowerCase();
  if (match[0] === match[0].toUpperCase() && match.slice(1) === match.slice(1).toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
}

async function walkFiles(
  dirPath: string,
  rootPath: string,
  showHidden: boolean,
  includeRe: RegExp | null,
  excludeRe: RegExp | null,
  openFilesSet: Set<string> | null,
  callback: (absPath: string, relPath: string) => Promise<boolean>, // return false to stop
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  let fileCount = 0;
  for (const entry of entries) {
    if (!showHidden && SKIP_NAMES.has(entry.name)) continue;
    const absPath = path.join(dirPath, entry.name);
    const relPath = path.relative(rootPath, absPath);

    if (entry.isDirectory()) {
      await walkFiles(absPath, rootPath, showHidden, includeRe, excludeRe, openFilesSet, callback);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // Filter by open files
      if (openFilesSet && !openFilesSet.has(absPath)) continue;

      // Apply include/exclude filters
      if (includeRe && !matchesFilter(relPath, includeRe)) continue;
      if (excludeRe && matchesFilter(relPath, excludeRe)) continue;

      // Skip binary files
      if (isBinaryFile(absPath)) continue;

      // Skip large files
      try {
        const stat = await fsp.stat(absPath);
        if (stat.size > MAX_FILE_SIZE) continue;
      } catch { continue; }

      const shouldContinue = await callback(absPath, relPath);
      if (!shouldContinue) return;

      // Yield every 50 files
      fileCount++;
      if (fileCount % 50 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }
}

export async function searchFiles(rootPath: string, req: SearchRequest): Promise<SearchResponse> {
  const maxResults = req.maxResults || 500;
  const regex = buildSearchRegex(req.query, req);
  const includeRe = buildFilterRegex(req.includeFilter || '', req.includeFilterIsRegex || false);
  const excludeRe = buildFilterRegex(req.excludeFilter || '', req.excludeFilterIsRegex || false);
  const openFilesSet = req.openFilesOnly ? new Set(req.openFilesOnly.map(f => path.resolve(f))) : null;

  const results: SearchFileResult[] = [];
  let totalMatches = 0;
  let totalFiles = 0;
  let truncated = false;

  await walkFiles(rootPath, rootPath, req.showHidden || false, includeRe, excludeRe, openFilesSet, async (absPath, relPath) => {
    totalFiles++;

    const fileResult: SearchFileResult = { file: relPath, matches: [] };

    // Check filename match
    if (req.includeFilenames) {
      const fnRegex = buildSearchRegex(req.query, req);
      if (fnRegex.test(relPath)) {
        fileResult.filenameMatch = true;
      }
    }

    // Search file contents
    let content: string;
    try {
      content = await fsp.readFile(absPath, 'utf-8');
    } catch { return true; }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Reset regex lastIndex for each line
      const lineRegex = buildSearchRegex(req.query, req);
      let m: RegExpExecArray | null;
      while ((m = lineRegex.exec(line)) !== null) {
        fileResult.matches.push({
          line: i + 1,
          column: m.index,
          length: m[0].length,
          lineContent: line.length > 500 ? line.substring(0, 500) : line,
        });
        totalMatches++;
        if (totalMatches >= maxResults) {
          truncated = true;
          break;
        }
        // Prevent infinite loop on zero-length matches
        if (m[0].length === 0) lineRegex.lastIndex++;
      }
      if (truncated) break;
    }

    if (fileResult.matches.length > 0 || fileResult.filenameMatch) {
      results.push(fileResult);
    }

    return !truncated;
  });

  return { results, truncated, totalFiles, totalMatches };
}

export async function replaceInFiles(rootPath: string, req: ReplaceRequest): Promise<ReplaceResponse> {
  const regex = buildSearchRegex(req.query, req);
  const includeRe = buildFilterRegex(req.includeFilter || '', req.includeFilterIsRegex || false);
  const excludeRe = buildFilterRegex(req.excludeFilter || '', req.excludeFilterIsRegex || false);
  const openFilesSet = req.openFilesOnly ? new Set(req.openFilesOnly.map(f => path.resolve(f))) : null;

  let filesModified = 0;
  let totalReplacements = 0;
  let filesRenamed = 0;
  const errors: Array<{ file: string; error: string }> = [];

  // Collect files to process (for rename, we need all paths first)
  const filesToProcess: Array<{ absPath: string; relPath: string }> = [];

  await walkFiles(rootPath, rootPath, req.showHidden || false, includeRe, excludeRe, openFilesSet, async (absPath, relPath) => {
    filesToProcess.push({ absPath, relPath });
    return true;
  });

  // Replace contents
  for (const { absPath, relPath } of filesToProcess) {
    try {
      const content = await fsp.readFile(absPath, 'utf-8');
      const replaceRegex = buildSearchRegex(req.query, req);
      let newContent: string;
      let count = 0;

      if (req.preserveCase) {
        newContent = content.replace(replaceRegex, (match) => {
          count++;
          return preserveCaseReplace(match, req.replacement);
        });
      } else {
        newContent = content.replace(replaceRegex, () => {
          count++;
          return req.replacement;
        });
      }

      if (count > 0) {
        await fsp.writeFile(absPath, newContent, 'utf-8');
        filesModified++;
        totalReplacements += count;
      }
    } catch (err: any) {
      errors.push({ file: relPath, error: err.message });
    }
  }

  // Rename files if requested
  if (req.renameFiles && req.includeFilenames) {
    for (const { absPath, relPath } of filesToProcess) {
      const fileName = path.basename(absPath);
      const renameRegex = buildSearchRegex(req.query, req);
      let newName: string;
      if (req.preserveCase) {
        newName = fileName.replace(renameRegex, (match) => preserveCaseReplace(match, req.replacement));
      } else {
        newName = fileName.replace(renameRegex, req.replacement);
      }
      if (newName !== fileName) {
        const newPath = path.join(path.dirname(absPath), newName);
        try {
          await fsp.rename(absPath, newPath);
          filesRenamed++;
        } catch (err: any) {
          errors.push({ file: relPath, error: `Rename failed: ${err.message}` });
        }
      }
    }
  }

  return { filesModified, totalReplacements, filesRenamed, errors };
}

// Replace in a single file, optionally restricted to specific lines
export async function replaceInSingleFile(
  rootPath: string,
  relFile: string,
  req: { query: string; replacement: string; isRegex?: boolean; matchCase?: boolean; matchWholeWord?: boolean; preserveCase?: boolean; lines?: number[] },
): Promise<{ replacements: number; error?: string }> {
  const absPath = path.join(rootPath, relFile);
  try {
    const content = await fsp.readFile(absPath, 'utf-8');
    const lineSet = req.lines ? new Set(req.lines) : null;

    if (lineSet) {
      // Replace only on specific lines
      const lines = content.split('\n');
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lineSet.has(i + 1)) continue; // lines are 1-based
        const lineRegex = buildSearchRegex(req.query, req);
        const newLine = req.preserveCase
          ? lines[i].replace(lineRegex, (match: string) => { count++; return preserveCaseReplace(match, req.replacement); })
          : lines[i].replace(lineRegex, () => { count++; return req.replacement; });
        lines[i] = newLine;
      }
      if (count > 0) {
        await fsp.writeFile(absPath, lines.join('\n'), 'utf-8');
      }
      return { replacements: count };
    } else {
      // Replace all in file
      const replaceRegex = buildSearchRegex(req.query, req);
      let count = 0;
      const newContent = req.preserveCase
        ? content.replace(replaceRegex, (match: string) => { count++; return preserveCaseReplace(match, req.replacement); })
        : content.replace(replaceRegex, () => { count++; return req.replacement; });
      if (count > 0) {
        await fsp.writeFile(absPath, newContent, 'utf-8');
      }
      return { replacements: count };
    }
  } catch (err: any) {
    return { replacements: 0, error: err.message };
  }
}
