import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';
import { getFileIconSvg } from '../../icons';

interface SearchMatch {
  line: number;
  column: number;
  length: number;
  lineContent: string;
}

interface SearchFileResult {
  file: string;
  matches: SearchMatch[];
  filenameMatch?: boolean;
}

interface SearchResponse {
  results: SearchFileResult[];
  truncated: boolean;
  totalFiles: number;
  totalMatches: number;
}

export function SearchPanel() {
  const { activeProjectId, openFiles, showHidden, setModal } = useStore();

  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [matchWholeWord, setMatchWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [includeFilenames, setIncludeFilenames] = useState(false);
  const [preserveCase, setPreserveCase] = useState(false);
  const [includeFilter, setIncludeFilter] = useState('');
  const [excludeFilter, setExcludeFilter] = useState('');
  const [includeFilterIsRegex, setIncludeFilterIsRegex] = useState(false);
  const [excludeFilterIsRegex, setExcludeFilterIsRegex] = useState(false);
  const [openFilesOnly, setOpenFilesOnly] = useState(false);
  const [results, setResults] = useState<SearchFileResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [totalMatches, setTotalMatches] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [replacing, setReplacing] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async () => {
    if (!query.trim() || !activeProjectId) {
      setResults(null);
      setError(null);
      setTotalMatches(0);
      setTotalFiles(0);
      setTruncated(false);
      return;
    }

    // Cancel previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearching(true);
    setError(null);

    try {
      const body: any = {
        query,
        isRegex,
        matchCase,
        matchWholeWord,
        includeFilenames,
        showHidden,
      };
      if (includeFilter.trim()) {
        body.includeFilter = includeFilter;
        body.includeFilterIsRegex = includeFilterIsRegex;
      }
      if (excludeFilter.trim()) {
        body.excludeFilter = excludeFilter;
        body.excludeFilterIsRegex = excludeFilterIsRegex;
      }
      if (openFilesOnly && openFiles.length > 0) {
        body.openFilesOnly = openFiles.map(f => f.fullPath);
      }

      const resp: SearchResponse = await api('POST', `/api/projects/${activeProjectId}/search`, body);

      if (controller.signal.aborted) return;

      setResults(resp.results);
      setTruncated(resp.truncated);
      setTotalMatches(resp.totalMatches);
      setTotalFiles(resp.totalFiles);
    } catch (err: any) {
      if (controller.signal.aborted) return;
      if (err.message?.includes('Invalid regex')) {
        setError(err.message);
      } else {
        setError(err.message || 'Search failed');
      }
      setResults(null);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [query, isRegex, matchCase, matchWholeWord, includeFilenames, includeFilter, includeFilterIsRegex, excludeFilter, excludeFilterIsRegex, openFilesOnly, openFiles, activeProjectId, showHidden]);

  // Debounced search trigger
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(doSearch, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [doSearch]);

  const toggleFileCollapse = (file: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const handleMatchClick = (file: string, line: number, _column: number) => {
    (window as any).openFileInEditor?.(file);
    // Give the editor a moment to open, then reveal line
    setTimeout(() => {
      (window as any).revealEditorLine?.(line, _column);
    }, 200);
  };

  const handleReplaceAll = () => {
    if (!query.trim() || !activeProjectId) return;

    if (includeFilenames) {
      setModal({
        type: 'confirm',
        props: {
          title: 'Replace All',
          message: `Replace "${query}" with "${replacement}" in file contents and rename matching filenames?`,
          confirmLabel: 'Replace & Rename',
          danger: false,
          secondaryAction: {
            label: 'Contents Only',
            onClick: () => executeReplace(false),
          },
          onConfirm: () => executeReplace(true),
        },
      });
    } else {
      setModal({
        type: 'confirm',
        props: {
          title: 'Replace All',
          message: `Replace all occurrences of "${query}" with "${replacement}"? This cannot be undone.`,
          confirmLabel: 'Replace All',
          danger: true,
          onConfirm: () => executeReplace(false),
        },
      });
    }
  };

  const executeReplace = async (renameFiles: boolean) => {
    if (!activeProjectId) return;
    setReplacing(true);

    try {
      const body: any = {
        query,
        replacement,
        isRegex,
        matchCase,
        matchWholeWord,
        includeFilenames,
        preserveCase,
        renameFiles,
        showHidden,
      };
      if (includeFilter.trim()) {
        body.includeFilter = includeFilter;
        body.includeFilterIsRegex = includeFilterIsRegex;
      }
      if (excludeFilter.trim()) {
        body.excludeFilter = excludeFilter;
        body.excludeFilterIsRegex = excludeFilterIsRegex;
      }
      if (openFilesOnly && openFiles.length > 0) {
        body.openFilesOnly = openFiles.map(f => f.fullPath);
      }

      const resp = await api('POST', `/api/projects/${activeProjectId}/replace-all`, body);

      const parts: string[] = [];
      if (resp.filesModified > 0) parts.push(`${resp.totalReplacements} replacements in ${resp.filesModified} files`);
      if (resp.filesRenamed > 0) parts.push(`${resp.filesRenamed} files renamed`);
      if (resp.errors?.length > 0) parts.push(`${resp.errors.length} errors`);

      useStore.getState().addToast('', parts.join(', ') || 'No replacements made', resp.errors?.length > 0 ? 'warning' : 'success');

      // Re-run search to update results
      doSearch();
    } catch (err: any) {
      useStore.getState().addToast('', `Replace failed: ${err.message}`, 'error');
    } finally {
      setReplacing(false);
    }
  };

  const getFileName = (filePath: string) => filePath.split('/').pop() || filePath;
  const getFileDir = (filePath: string) => {
    const parts = filePath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  };

  // Build regex from current query for highlighting text
  const buildHighlightRegex = useCallback((): RegExp | null => {
    if (!query.trim()) return null;
    try {
      let pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (matchWholeWord) pattern = `\\b${pattern}\\b`;
      return new RegExp(pattern, matchCase ? 'g' : 'gi');
    } catch { return null; }
  }, [query, isRegex, matchCase, matchWholeWord]);

  // Compute the replacement for a matched string (respecting preserveCase)
  const computeReplacement = (matched: string): string => {
    if (!preserveCase) return replacement;
    if (matched === matched.toUpperCase()) return replacement.toUpperCase();
    if (matched === matched.toLowerCase()) return replacement.toLowerCase();
    if (matched[0] === matched[0].toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
      return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
    }
    return replacement;
  };

  const hasReplace = showReplace && replacement !== '';

  // Highlight all regex matches in a string, returning React nodes
  // When hasReplace, shows match as red strikethrough + green replacement
  const highlightText = (text: string, regex: RegExp | null): React.ReactNode => {
    if (!regex || !text) return text;
    const re = new RegExp(regex.source, regex.flags);
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) parts.push(<span key={key++}>{text.slice(lastIdx, m.index)}</span>);
      if (hasReplace) {
        parts.push(<span key={key++} className="search-highlight-remove">{m[0]}</span>);
        parts.push(<span key={key++} className="search-highlight-add">{computeReplacement(m[0])}</span>);
      } else {
        parts.push(<span key={key++} className="search-highlight">{m[0]}</span>);
      }
      lastIdx = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (lastIdx < text.length) parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
    return parts.length > 0 ? <>{parts}</> : <>{text}</>;
  };

  const highlightMatch = (lineContent: string, matches: SearchMatch[]) => {
    if (matches.length === 0) return <span>{lineContent}</span>;
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    const sorted = [...matches].sort((a, b) => a.column - b.column);
    for (const m of sorted) {
      if (m.column > lastIdx) {
        parts.push(<span key={`t${lastIdx}`}>{lineContent.slice(lastIdx, m.column)}</span>);
      }
      const matched = lineContent.slice(m.column, m.column + m.length);
      if (hasReplace) {
        parts.push(<span key={`r${m.column}`} className="search-highlight-remove">{matched}</span>);
        parts.push(<span key={`a${m.column}`} className="search-highlight-add">{computeReplacement(matched)}</span>);
      } else {
        parts.push(<span key={`h${m.column}`} className="search-highlight">{matched}</span>);
      }
      lastIdx = m.column + m.length;
    }
    if (lastIdx < lineContent.length) {
      parts.push(<span key={`e${lastIdx}`}>{lineContent.slice(lastIdx)}</span>);
    }
    return <>{parts}</>;
  };

  // Replace in a single file (all matches)
  const replaceInFile = async (file: string) => {
    if (!activeProjectId || !query.trim()) return;
    try {
      const resp = await api('POST', `/api/projects/${activeProjectId}/replace-in-file`, {
        file, query, replacement, isRegex, matchCase, matchWholeWord, preserveCase,
      });
      useStore.getState().addToast('', `${resp.replacements} replacement${resp.replacements !== 1 ? 's' : ''} in ${getFileName(file)}`, resp.error ? 'warning' : 'success');
      doSearch();
    } catch (err: any) {
      useStore.getState().addToast('', `Replace failed: ${err.message}`, 'error');
    }
  };

  // Replace on a specific line in a file
  const replaceOnLine = async (file: string, line: number) => {
    if (!activeProjectId || !query.trim()) return;
    try {
      const resp = await api('POST', `/api/projects/${activeProjectId}/replace-in-file`, {
        file, query, replacement, isRegex, matchCase, matchWholeWord, preserveCase, lines: [line],
      });
      useStore.getState().addToast('', `${resp.replacements} replacement${resp.replacements !== 1 ? 's' : ''}`, resp.error ? 'warning' : 'success');
      doSearch();
    } catch (err: any) {
      useStore.getState().addToast('', `Replace failed: ${err.message}`, 'error');
    }
  };

  // Rename a single file (filename match)
  const renameFile = async (file: string) => {
    if (!activeProjectId || !query.trim()) return;
    const fName = getFileName(file);
    const hlRegex = buildHighlightRegex();
    if (!hlRegex) return;
    const newName = preserveCase
      ? fName.replace(hlRegex, (m: string) => computeReplacement(m))
      : fName.replace(hlRegex, replacement);
    if (newName === fName) return;
    try {
      await api('POST', '/api/files/rename', { from: file, to: file.replace(/[^/]+$/, newName) });
      useStore.getState().addToast('', `Renamed to ${newName}`, 'success');
      doSearch();
    } catch (err: any) {
      useStore.getState().addToast('', `Rename failed: ${err.message}`, 'error');
    }
  };

  // Group matches by line for highlight rendering
  const groupMatchesByLine = (matches: SearchMatch[]) => {
    const map = new Map<number, SearchMatch[]>();
    for (const m of matches) {
      const existing = map.get(m.line) || [];
      existing.push(m);
      map.set(m.line, existing);
    }
    return map;
  };

  return (
    <div className="search-panel">
      <div className="search-form">
        {/* Search row */}
        <div className="search-form-row">
          <button className="search-expand-btn" onClick={() => setShowReplace(!showReplace)} title={showReplace ? 'Hide replace' : 'Show replace'}>
            {showReplace ? '▾' : '▸'}
          </button>
          <div className="search-input-wrap">
            <input
              ref={searchInputRef}
              className="search-input"
              type="text"
              placeholder="Search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
            />
            <div className="search-input-toggles">
              <button className={`search-toggle-btn ${matchCase ? 'active' : ''}`} onClick={() => setMatchCase(!matchCase)} title="Match Case">Aa</button>
              <button className={`search-toggle-btn ${matchWholeWord ? 'active' : ''}`} onClick={() => setMatchWholeWord(!matchWholeWord)} title="Match Whole Word">Ab</button>
              <button className={`search-toggle-btn ${isRegex ? 'active' : ''}`} onClick={() => setIsRegex(!isRegex)} title="Use Regular Expression">.*</button>
              <button className={`search-toggle-btn ${includeFilenames ? 'active' : ''}`} onClick={() => setIncludeFilenames(!includeFilenames)} title="Include Filenames in Search">fn</button>
            </div>
          </div>
        </div>

        {/* Replace row */}
        {showReplace && (
          <div className="search-form-row">
            <div className="search-expand-btn-spacer" />
            <div className="search-input-wrap">
              <input
                className="search-input"
                type="text"
                placeholder="Replace"
                value={replacement}
                onChange={e => setReplacement(e.target.value)}
                spellCheck={false}
              />
              <div className="search-input-toggles">
                <button className={`search-toggle-btn ${preserveCase ? 'active' : ''}`} onClick={() => setPreserveCase(!preserveCase)} title="Preserve Case">Cc</button>
              </div>
            </div>
            <button
              className="search-replace-all-btn"
              onClick={handleReplaceAll}
              disabled={!query.trim() || replacing}
              title="Replace All"
            >
              {replacing ? '...' : '⇄'}
            </button>
          </div>
        )}

        {/* Filter toggle */}
        <div className="search-form-row search-filter-toggle-row">
          <button className={`search-toggle-btn filter-toggle ${showFilters ? 'active' : ''}`} onClick={() => setShowFilters(!showFilters)} title="Toggle Filters">
            ⋯
          </button>
          {(includeFilter || excludeFilter || openFilesOnly) && !showFilters && (
            <span className="search-filter-active-hint">filters active</span>
          )}
        </div>

        {/* Filters */}
        {showFilters && (
          <div className="search-filter-section">
            <div className="search-filter-row">
              <span className="search-filter-label">include</span>
              <div className="search-input-wrap">
                <input
                  className="search-input search-filter-input"
                  type="text"
                  placeholder="e.g. *.ts, src/**"
                  value={includeFilter}
                  onChange={e => setIncludeFilter(e.target.value)}
                  spellCheck={false}
                />
                <div className="search-input-toggles">
                  <button className={`search-toggle-btn ${includeFilterIsRegex ? 'active' : ''}`} onClick={() => setIncludeFilterIsRegex(!includeFilterIsRegex)} title="Use Regex">.*</button>
                </div>
              </div>
            </div>
            <div className="search-filter-row">
              <span className="search-filter-label">exclude</span>
              <div className="search-input-wrap">
                <input
                  className="search-input search-filter-input"
                  type="text"
                  placeholder="e.g. *.min.js, dist/**"
                  value={excludeFilter}
                  onChange={e => setExcludeFilter(e.target.value)}
                  spellCheck={false}
                />
                <div className="search-input-toggles">
                  <button className={`search-toggle-btn ${excludeFilterIsRegex ? 'active' : ''}`} onClick={() => setExcludeFilterIsRegex(!excludeFilterIsRegex)} title="Use Regex">.*</button>
                </div>
              </div>
            </div>
            <div className="search-filter-row">
              <label className="search-checkbox-label">
                <input type="checkbox" checked={openFilesOnly} onChange={e => setOpenFilesOnly(e.target.checked)} />
                <span>Search in open files only</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && <div className="search-error">{error}</div>}

      {/* Status */}
      {results !== null && (
        <div className="search-status">
          {searching ? 'Searching...' : (
            <>
              {totalMatches} result{totalMatches !== 1 ? 's' : ''} in {results.length} file{results.length !== 1 ? 's' : ''}
              {truncated && <span className="search-truncated"> (results truncated)</span>}
            </>
          )}
        </div>
      )}
      {searching && results === null && <div className="search-status">Searching...</div>}

      {/* Results */}
      <div className="search-results">
        {results && results.map(fileResult => {
          const hasContentMatches = fileResult.matches.length > 0;
          const isFilenameOnly = fileResult.filenameMatch && !hasContentMatches;
          const isCollapsed = isFilenameOnly || collapsedFiles.has(fileResult.file);
          const lineMap = groupMatchesByLine(fileResult.matches);
          const uniqueLines = Array.from(lineMap.entries()).sort((a, b) => a[0] - b[0]);
          const hlRegex = buildHighlightRegex();
          const fName = getFileName(fileResult.file);
          const fDir = getFileDir(fileResult.file);

          return (
            <div key={fileResult.file} className="search-file-group">
              <div
                className={`search-file-header ${isFilenameOnly ? 'filename-only' : ''}`}
                onClick={() => {
                  if (isFilenameOnly) {
                    (window as any).openFileInEditor?.(fileResult.file);
                  } else {
                    toggleFileCollapse(fileResult.file);
                  }
                }}
              >
                {!isFilenameOnly && <span className="search-file-arrow">{isCollapsed ? '▸' : '▾'}</span>}
                <span className="file-tree-icon" dangerouslySetInnerHTML={{ __html: getFileIconSvg(fName) }} />
                <span className="search-file-name">
                  {fileResult.filenameMatch ? highlightText(fName, hlRegex) : fName}
                </span>
                {fDir && <span className="search-file-dir">
                  {fileResult.filenameMatch ? highlightText(fDir, hlRegex) : fDir}
                </span>}
                {hasContentMatches && <span className="search-match-count">{fileResult.matches.length}</span>}
                {hasReplace && hasContentMatches && (
                  <button className="search-inline-replace-btn" title="Replace all in this file" onClick={(e) => { e.stopPropagation(); replaceInFile(fileResult.file); }}>⇄</button>
                )}
                {hasReplace && fileResult.filenameMatch && (
                  <button className="search-inline-replace-btn" title="Rename this file" onClick={(e) => { e.stopPropagation(); renameFile(fileResult.file); }}>✎</button>
                )}
              </div>
              {!isCollapsed && uniqueLines.map(([lineNum, lineMatches]) => (
                <div
                  key={`${fileResult.file}:${lineNum}`}
                  className="search-match"
                  onClick={() => handleMatchClick(fileResult.file, lineNum, lineMatches[0].column)}
                >
                  <span className="search-match-line">{lineNum}</span>
                  <span className="search-match-text">
                    {highlightMatch(lineMatches[0].lineContent, lineMatches)}
                  </span>
                  {hasReplace && (
                    <button className="search-inline-replace-btn" title="Replace on this line" onClick={(e) => { e.stopPropagation(); replaceOnLine(fileResult.file, lineNum); }}>⇄</button>
                  )}
                </div>
              ))}
            </div>
          );
        })}

        {results && results.length === 0 && !searching && query.trim() && (
          <div className="empty-state" style={{ padding: 20 }}>
            <div className="empty-state-icon">∅</div>
            <div className="empty-state-title">No results</div>
            <div className="empty-state-desc">No matches found for "{query}"</div>
          </div>
        )}
      </div>
    </div>
  );
}
