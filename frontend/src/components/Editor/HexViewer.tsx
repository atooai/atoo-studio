import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { EditorFile } from '../../types';

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
const CHUNK_SIZE = 128 * 1024;

function formatOffset(offset: number, totalSize: number): string {
  const digits = Math.max(8, totalSize.toString(16).length);
  return offset.toString(16).toUpperCase().padStart(digits, '0');
}
function toHex(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, '0');
}
function toAscii(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}

// Parse a search query into bytes
function parseSearchPattern(query: string, mode: 'string' | 'hex'): Uint8Array | null {
  if (!query) return null;
  if (mode === 'string') return new TextEncoder().encode(query);
  // Hex mode: strip spaces, parse pairs
  const hex = query.replace(/\s+/g, '');
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

interface UndoEntry { offset: number; oldValue: number; newValue: number; }

export function HexViewer({ file }: { file: EditorFile }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(300);
  const [error, setError] = useState('');

  // Text mode
  const isTextMode = !file.isBinary;
  const textBytesRef = useRef<Uint8Array | null>(null);
  const textContentRef = useRef('');
  if (isTextMode && file.content !== textContentRef.current) {
    textBytesRef.current = new TextEncoder().encode(file.content);
    textContentRef.current = file.content;
  }

  // Binary chunk cache
  const chunkCache = useRef<Map<number, Uint8Array>>(new Map());
  const [totalSize, setTotalSize] = useState(file.fileSize || 0);
  const loadingChunks = useRef<Set<number>>(new Set());
  const [renderTick, setRenderTick] = useState(0);
  const prevPathRef = useRef(file.fullPath);

  // Editing state
  const edits = useRef<Map<number, number>>(new Map());
  const [editCount, setEditCount] = useState(0);
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);

  // Cursor & selection
  const [cursor, setCursor] = useState(-1); // byte offset
  const [nibble, setNibble] = useState(0); // 0=high, 1=low for hex editing
  const [focusArea, setFocusArea] = useState<'hex' | 'ascii'>('hex');
  const [selStart, setSelStart] = useState(-1);
  const [selEnd, setSelEnd] = useState(-1);
  const selecting = useRef(false);

  // Search/replace
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'string' | 'hex'>('string');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [replaceMode, setReplaceMode] = useState<'string' | 'hex'>('string');
  const [matches, setMatches] = useState<number[]>([]);
  const [matchIdx, setMatchIdx] = useState(-1);
  const [matchLen, setMatchLen] = useState(0);
  const [saving, setSaving] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Selection range (ordered)
  const selMin = selStart >= 0 && selEnd >= 0 ? Math.min(selStart, selEnd) : -1;
  const selMax = selStart >= 0 && selEnd >= 0 ? Math.max(selStart, selEnd) : -1;

  // Match set for fast lookup
  const matchSet = useMemo(() => {
    const s = new Set<number>();
    for (const m of matches) {
      for (let i = 0; i < matchLen; i++) s.add(m + i);
    }
    return s;
  }, [matches, matchLen]);

  const activeMatchStart = matchIdx >= 0 && matchIdx < matches.length ? matches[matchIdx] : -1;

  // Reset when file changes
  useEffect(() => {
    if (file.fullPath !== prevPathRef.current) {
      chunkCache.current.clear();
      loadingChunks.current.clear();
      edits.current.clear();
      undoStack.current = [];
      redoStack.current = [];
      setEditCount(0);
      prevPathRef.current = file.fullPath;
      setScrollTop(0);
      setTotalSize(file.fileSize || 0);
      setCursor(-1);
      setSelStart(-1);
      setSelEnd(-1);
      setMatches([]);
    }
    if (!isTextMode) loadChunkAt(0);
  }, [file.path, file.fullPath]);

  useEffect(() => {
    if (isTextMode) {
      textBytesRef.current = new TextEncoder().encode(file.content);
      textContentRef.current = file.content;
      setRenderTick(n => n + 1);
    }
  }, [file.content, isTextMode]);

  const chunkAlignedOffset = (off: number) => Math.floor(off / CHUNK_SIZE) * CHUNK_SIZE;

  const loadChunkAt = useCallback(async (alignedOffset: number) => {
    if (isTextMode) return;
    if (chunkCache.current.has(alignedOffset)) return;
    if (loadingChunks.current.has(alignedOffset)) return;
    loadingChunks.current.add(alignedOffset);
    try {
      const res = await fetch(`/api/files/raw?path=${encodeURIComponent(file.fullPath)}&offset=${alignedOffset}&length=${CHUNK_SIZE}`);
      if (!res.ok) throw new Error('Failed to load chunk');
      const json = await res.json();
      const bytes = Uint8Array.from(atob(json.data), c => c.charCodeAt(0));
      setTotalSize(json.size);
      chunkCache.current.set(alignedOffset, bytes);
      if (chunkCache.current.size > 8) {
        const keys = [...chunkCache.current.keys()].sort((a, b) =>
          Math.abs(a - alignedOffset) - Math.abs(b - alignedOffset));
        for (const k of keys.slice(6)) chunkCache.current.delete(k);
      }
      setError('');
      setRenderTick(n => n + 1);
    } catch (e: any) { setError(e.message); }
    finally { loadingChunks.current.delete(alignedOffset); }
  }, [file.fullPath, isTextMode]);

  const getByte = useCallback((off: number): number | null => {
    if (edits.current.has(off)) return edits.current.get(off)!;
    if (isTextMode) {
      const bytes = textBytesRef.current;
      return bytes && off < bytes.length ? bytes[off] : null;
    }
    const aligned = chunkAlignedOffset(off);
    const chunk = chunkCache.current.get(aligned);
    if (!chunk) return null;
    const idx = off - aligned;
    return idx < chunk.length ? chunk[idx] : null;
  }, [isTextMode, editCount, renderTick]);

  const effectiveSize = isTextMode ? (textBytesRef.current?.length || 0) : totalSize;

  // Set a byte (edit)
  const setByte = useCallback((off: number, val: number) => {
    const old = getByte(off);
    if (old === null) return;
    undoStack.current.push({ offset: off, oldValue: old, newValue: val });
    redoStack.current = [];
    edits.current.set(off, val & 0xFF);
    setEditCount(n => n + 1);
  }, [getByte]);

  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    redoStack.current.push(entry);
    if (entry.oldValue === getByte(entry.offset)) {
      edits.current.delete(entry.offset);
    } else {
      edits.current.set(entry.offset, entry.oldValue);
    }
    setCursor(entry.offset);
    setEditCount(n => n + 1);
  }, [getByte]);

  const redo = useCallback(() => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    undoStack.current.push(entry);
    edits.current.set(entry.offset, entry.newValue);
    setCursor(entry.offset);
    setEditCount(n => n + 1);
  }, []);

  // Save edits
  const saveEdits = useCallback(async () => {
    if (edits.current.size === 0) return;
    setSaving(true);
    try {
      const editArr = [...edits.current.entries()].map(([offset, value]) => ({ offset, value }));
      const res = await fetch('/api/files/raw', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.fullPath, edits: editArr }),
      });
      if (!res.ok) throw new Error('Save failed');
      // Apply edits into chunk cache and clear
      for (const [off, val] of edits.current) {
        const aligned = chunkAlignedOffset(off);
        const chunk = chunkCache.current.get(aligned);
        if (chunk) chunk[off - aligned] = val;
      }
      edits.current.clear();
      undoStack.current = [];
      redoStack.current = [];
      setEditCount(0);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }, [file.fullPath]);

  // Search
  const doSearch = useCallback(async (query: string, mode: 'string' | 'hex') => {
    const pattern = parseSearchPattern(query, mode);
    if (!pattern || pattern.length === 0) { setMatches([]); setMatchIdx(-1); setMatchLen(0); return; }
    setMatchLen(pattern.length);

    if (isTextMode) {
      // Client-side search for text files
      const data = textBytesRef.current;
      if (!data) return;
      const results: number[] = [];
      let idx = 0;
      while (idx <= data.length - pattern.length && results.length < 1000) {
        let found = true;
        for (let j = 0; j < pattern.length; j++) {
          if (data[idx + j] !== pattern[j]) { found = false; break; }
        }
        if (found) { results.push(idx); idx++; } else { idx++; }
      }
      setMatches(results);
      setMatchIdx(results.length > 0 ? 0 : -1);
      if (results.length > 0) scrollToOffset(results[0]);
      return;
    }

    // Server-side search for binary files
    try {
      const b64 = btoa(String.fromCharCode(...pattern));
      const res = await fetch('/api/files/raw/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.fullPath, pattern: b64 }),
      });
      if (!res.ok) throw new Error('Search failed');
      const json = await res.json();
      setMatches(json.matches);
      setMatchIdx(json.matches.length > 0 ? 0 : -1);
      if (json.matches.length > 0) scrollToOffset(json.matches[0]);
    } catch (e: any) { setError(e.message); }
  }, [file.fullPath, isTextMode]);

  const goToMatch = useCallback((dir: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (matchIdx + dir + matches.length) % matches.length;
    setMatchIdx(next);
    scrollToOffset(matches[next]);
    setCursor(matches[next]);
  }, [matches, matchIdx]);

  const replaceMatch = useCallback(() => {
    if (matchIdx < 0 || matchIdx >= matches.length) return;
    const replacement = parseSearchPattern(replaceQuery, replaceMode);
    if (!replacement) return;
    const off = matches[matchIdx];
    const searchPattern = parseSearchPattern(searchQuery, searchMode);
    if (!searchPattern) return;
    // Replace bytes
    for (let i = 0; i < searchPattern.length; i++) {
      const val = i < replacement.length ? replacement[i] : 0;
      setByte(off + i, val);
    }
    // If replacement is shorter, we can't shrink in hex editor - fill with 00
    // Re-search after replace
    const newMatches = matches.filter((_, i) => i !== matchIdx);
    setMatches(newMatches);
    if (newMatches.length > 0) {
      const newIdx = Math.min(matchIdx, newMatches.length - 1);
      setMatchIdx(newIdx);
      scrollToOffset(newMatches[newIdx]);
    } else {
      setMatchIdx(-1);
    }
  }, [matches, matchIdx, replaceQuery, replaceMode, searchQuery, searchMode, setByte]);

  const replaceAll = useCallback(() => {
    const replacement = parseSearchPattern(replaceQuery, replaceMode);
    const searchPattern = parseSearchPattern(searchQuery, searchMode);
    if (!replacement || !searchPattern) return;
    for (const off of matches) {
      for (let i = 0; i < searchPattern.length; i++) {
        setByte(off + i, i < replacement.length ? replacement[i] : 0);
      }
    }
    setMatches([]);
    setMatchIdx(-1);
  }, [matches, replaceQuery, replaceMode, searchQuery, searchMode, setByte]);

  const scrollToOffset = useCallback((off: number) => {
    const row = Math.floor(off / BYTES_PER_ROW);
    const targetTop = row * ROW_HEIGHT - bodyHeight / 2;
    bodyRef.current?.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }, [bodyHeight]);

  // Ensure chunk is loaded for cursor
  useEffect(() => {
    if (!isTextMode && cursor >= 0) loadChunkAt(chunkAlignedOffset(cursor));
  }, [cursor, isTextMode, loadChunkAt]);

  // Track body size
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) { const h = entry.contentRect.height; if (h > 0) setBodyHeight(h); }
    });
    ro.observe(el);
    if (el.clientHeight > 0) setBodyHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = (e.target as HTMLDivElement).scrollTop;
    setScrollTop(top);
    if (isTextMode) return;
    const firstRow = Math.floor(top / ROW_HEIGHT);
    const lastRow = Math.ceil((top + bodyHeight) / ROW_HEIGHT) + 1;
    const firstByte = firstRow * BYTES_PER_ROW;
    const lastByte = lastRow * BYTES_PER_ROW;
    for (let off = chunkAlignedOffset(firstByte); off < lastByte; off += CHUNK_SIZE) loadChunkAt(off);
  }, [bodyHeight, loadChunkAt, isTextMode]);

  // Click on a byte (hex or ascii column)
  const handleByteClick = useCallback((off: number, area: 'hex' | 'ascii', e: React.MouseEvent) => {
    setCursor(off);
    setNibble(0);
    setFocusArea(area);
    if (e.shiftKey && cursor >= 0) {
      setSelEnd(off);
    } else {
      setSelStart(off);
      setSelEnd(off);
    }
    selecting.current = false;
    viewerRef.current?.focus();
  }, [cursor]);

  const handleByteMouseDown = useCallback((off: number, area: 'hex' | 'ascii', e: React.MouseEvent) => {
    if (e.shiftKey) return;
    selecting.current = true;
    setSelStart(off);
    setSelEnd(off);
    setFocusArea(area);
    setCursor(off);
    setNibble(0);
  }, []);

  const handleByteMouseEnter = useCallback((off: number) => {
    if (selecting.current) {
      setSelEnd(off);
      setCursor(off);
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    selecting.current = false;
  }, []);

  // Keyboard handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setShowSearch(s => !s);
      setTimeout(() => searchInputRef.current?.focus(), 50);
      return;
    }
    if (e.key === 'h' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setShowSearch(true);
      setTimeout(() => searchInputRef.current?.focus(), 50);
      return;
    }
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveEdits();
      return;
    }
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
        (e.key === 'y' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'g' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const input = prompt('Go to offset (hex):');
      if (input) {
        const off = parseInt(input, 16);
        if (!isNaN(off) && off >= 0 && off < effectiveSize) {
          setCursor(off);
          setSelStart(off);
          setSelEnd(off);
          scrollToOffset(off);
        }
      }
      return;
    }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelStart(0);
      setSelEnd(effectiveSize - 1);
      return;
    }
    if (e.key === 'Escape') {
      if (showSearch) { setShowSearch(false); return; }
      setSelStart(-1);
      setSelEnd(-1);
      return;
    }

    if (cursor < 0) return;

    // Arrow navigation
    let newCursor = cursor;
    if (e.key === 'ArrowRight') newCursor = Math.min(cursor + 1, effectiveSize - 1);
    else if (e.key === 'ArrowLeft') newCursor = Math.max(cursor - 1, 0);
    else if (e.key === 'ArrowDown') newCursor = Math.min(cursor + BYTES_PER_ROW, effectiveSize - 1);
    else if (e.key === 'ArrowUp') newCursor = Math.max(cursor - BYTES_PER_ROW, 0);
    else if (e.key === 'Home') newCursor = e.ctrlKey ? 0 : cursor - (cursor % BYTES_PER_ROW);
    else if (e.key === 'End') newCursor = e.ctrlKey ? effectiveSize - 1 : Math.min(cursor - (cursor % BYTES_PER_ROW) + BYTES_PER_ROW - 1, effectiveSize - 1);
    else if (e.key === 'PageDown') newCursor = Math.min(cursor + BYTES_PER_ROW * Math.floor(bodyHeight / ROW_HEIGHT), effectiveSize - 1);
    else if (e.key === 'PageUp') newCursor = Math.max(cursor - BYTES_PER_ROW * Math.floor(bodyHeight / ROW_HEIGHT), 0);
    else if (e.key === 'Tab') {
      e.preventDefault();
      setFocusArea(f => f === 'hex' ? 'ascii' : 'hex');
      setNibble(0);
      return;
    }

    if (newCursor !== cursor) {
      e.preventDefault();
      setCursor(newCursor);
      setNibble(0);
      if (e.shiftKey) {
        setSelEnd(newCursor);
      } else {
        setSelStart(newCursor);
        setSelEnd(newCursor);
      }
      // Auto-scroll
      const row = Math.floor(newCursor / BYTES_PER_ROW);
      const rowTop = row * ROW_HEIGHT;
      const body = bodyRef.current;
      if (body) {
        if (rowTop < body.scrollTop) body.scrollTop = rowTop;
        else if (rowTop + ROW_HEIGHT > body.scrollTop + bodyHeight) body.scrollTop = rowTop + ROW_HEIGHT - bodyHeight;
      }
      return;
    }

    // Typing input
    if (focusArea === 'hex') {
      const hexChar = e.key.toLowerCase();
      if (/^[0-9a-f]$/.test(hexChar)) {
        e.preventDefault();
        const current = getByte(cursor) ?? 0;
        const digit = parseInt(hexChar, 16);
        let newVal: number;
        if (nibble === 0) {
          newVal = (digit << 4) | (current & 0x0F);
          setByte(cursor, newVal);
          setNibble(1);
        } else {
          newVal = (current & 0xF0) | digit;
          setByte(cursor, newVal);
          setNibble(0);
          // Advance cursor
          if (cursor < effectiveSize - 1) {
            setCursor(cursor + 1);
            setSelStart(cursor + 1);
            setSelEnd(cursor + 1);
          }
        }
      }
    } else {
      // ASCII input
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setByte(cursor, e.key.charCodeAt(0));
        if (cursor < effectiveSize - 1) {
          setCursor(cursor + 1);
          setSelStart(cursor + 1);
          setSelEnd(cursor + 1);
        }
      }
    }
  }, [cursor, nibble, focusArea, effectiveSize, bodyHeight, showSearch, getByte, setByte, undo, redo, saveEdits, scrollToOffset, selStart]);

  // Render rows
  const totalRows = Math.ceil(effectiveSize / BYTES_PER_ROW);
  const totalHeight = totalRows * ROW_HEIGHT;
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const visibleRowCount = Math.ceil(bodyHeight / ROW_HEIGHT) + 2;
  const lastVisRow = Math.min(firstVisibleRow + visibleRowCount, totalRows);

  const rows: React.ReactNode[] = [];
  for (let r = firstVisibleRow; r < lastVisRow; r++) {
    const rowOffset = r * BYTES_PER_ROW;
    const bytesInRow = Math.min(BYTES_PER_ROW, effectiveSize - rowOffset);

    const hexCells: React.ReactNode[] = [];
    const asciiCells: React.ReactNode[] = [];

    for (let c = 0; c < BYTES_PER_ROW; c++) {
      const off = rowOffset + c;
      if (c < bytesInRow) {
        const byte = getByte(off);
        const isCursor = off === cursor;
        const isSelected = selMin >= 0 && off >= selMin && off <= selMax;
        const isEdited = edits.current.has(off);
        const isMatch = matchSet.has(off);
        const isActiveMatch = activeMatchStart >= 0 && off >= activeMatchStart && off < activeMatchStart + matchLen;

        let hexCls = 'hb';
        let ascCls = 'ab';
        if (isActiveMatch) { hexCls += ' hx-amatch'; ascCls += ' hx-amatch'; }
        else if (isMatch) { hexCls += ' hx-match'; ascCls += ' hx-match'; }
        if (isSelected) { hexCls += ' hx-sel'; ascCls += ' hx-sel'; }
        if (isEdited) { hexCls += ' hx-edit'; ascCls += ' hx-edit'; }
        if (isCursor && focusArea === 'hex') hexCls += ' hx-cur';
        if (isCursor && focusArea === 'ascii') ascCls += ' hx-cur';

        const hexText = byte !== null ? toHex(byte) : '..';
        const ascText = byte !== null ? toAscii(byte) : ' ';

        hexCells.push(
          <span key={c} className={hexCls}
            onMouseDown={e => handleByteMouseDown(off, 'hex', e)}
            onMouseEnter={() => handleByteMouseEnter(off)}
            onClick={e => handleByteClick(off, 'hex', e)}
          >{hexText}</span>
        );
        if (c === 7) hexCells.push(<span key="gap" className="hg"> </span>);

        asciiCells.push(
          <span key={c} className={ascCls}
            onMouseDown={e => handleByteMouseDown(off, 'ascii', e)}
            onMouseEnter={() => handleByteMouseEnter(off)}
            onClick={e => handleByteClick(off, 'ascii', e)}
          >{ascText}</span>
        );
      } else {
        hexCells.push(<span key={c} className="hb he">{'\u00A0\u00A0'}</span>);
        if (c === 7) hexCells.push(<span key="gap" className="hg"> </span>);
        asciiCells.push(<span key={c} className="ab">{'\u00A0'}</span>);
      }
    }

    rows.push(
      <div key={r} className="hex-row"
        style={{ position: 'absolute', top: r * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}>
        <span className="hex-offset">{formatOffset(rowOffset, effectiveSize)}</span>
        <span className="hex-bytes">{hexCells}</span>
        <span className="hex-ascii">{asciiCells}</span>
      </div>
    );
  }

  const sizeLabel = effectiveSize >= 1024 * 1024
    ? (effectiveSize / 1024 / 1024).toFixed(1) + ' MB'
    : effectiveSize >= 1024
    ? (effectiveSize / 1024).toFixed(1) + ' KB'
    : effectiveSize + ' B';

  const statusParts: string[] = [sizeLabel];
  if (cursor >= 0) statusParts.push(`Off: 0x${cursor.toString(16).toUpperCase()}`);
  if (selMin >= 0 && selMin !== selMax) statusParts.push(`Sel: ${selMax - selMin + 1} bytes`);
  if (edits.current.size > 0) statusParts.push(`${edits.current.size} edit${edits.current.size > 1 ? 's' : ''}`);
  if (saving) statusParts.push('saving...');

  return (
    <div className="hex-viewer" ref={viewerRef} tabIndex={0}
      onKeyDown={handleKeyDown} onMouseUp={handleMouseUp}>
      <div className="hex-header">
        <span className="hex-offset">Offset</span>
        <span className="hex-bytes hex-bytes-hdr">00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F</span>
        <span className="hex-ascii">ASCII</span>
        <span className="hex-info">{statusParts.join(' | ')}</span>
      </div>
      {showSearch && (
        <div className="hex-search">
          <div className="hex-search-row">
            <span className="hex-search-label">Find</span>
            <input ref={searchInputRef} className="hex-search-input" value={searchQuery} placeholder={searchMode === 'hex' ? 'e.g. 89 50 4E 47' : 'text...'}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(searchQuery, searchMode); } if (e.key === 'Escape') { setShowSearch(false); viewerRef.current?.focus(); } }}
            />
            <button className={`hex-sbtn ${searchMode === 'string' ? 'active' : ''}`} onClick={() => setSearchMode('string')} title="String search">Str</button>
            <button className={`hex-sbtn ${searchMode === 'hex' ? 'active' : ''}`} onClick={() => setSearchMode('hex')} title="Hex search">Hex</button>
            <button className="hex-sbtn" onClick={() => doSearch(searchQuery, searchMode)}>Search</button>
            <button className="hex-sbtn" onClick={() => goToMatch(-1)} title="Previous">&lt;</button>
            <button className="hex-sbtn" onClick={() => goToMatch(1)} title="Next">&gt;</button>
            {matches.length > 0 && <span className="hex-search-count">{matchIdx + 1}/{matches.length}</span>}
            <button className="hex-sbtn hex-search-close" onClick={() => { setShowSearch(false); viewerRef.current?.focus(); }} title="Close">x</button>
          </div>
          <div className="hex-search-row">
            <span className="hex-search-label">Replace</span>
            <input className="hex-search-input" value={replaceQuery} placeholder={replaceMode === 'hex' ? 'e.g. FF FF' : 'text...'}
              onChange={e => setReplaceQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); viewerRef.current?.focus(); } }}
            />
            <button className={`hex-sbtn ${replaceMode === 'string' ? 'active' : ''}`} onClick={() => setReplaceMode('string')}>Str</button>
            <button className={`hex-sbtn ${replaceMode === 'hex' ? 'active' : ''}`} onClick={() => setReplaceMode('hex')}>Hex</button>
            <button className="hex-sbtn" onClick={replaceMatch}>Replace</button>
            <button className="hex-sbtn" onClick={replaceAll}>All</button>
          </div>
        </div>
      )}
      {error && <div style={{ color: 'var(--error)', padding: '4px 12px', fontSize: 11 }}>{error}</div>}
      <div className="hex-body" ref={bodyRef} onScroll={handleScroll}>
        <div style={{ height: totalHeight, position: 'relative' }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
