import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { EditorFile } from '../../types';

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
const CHUNK_SIZE = 128 * 1024; // 128KB per chunk

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

export function HexViewer({ file }: { file: EditorFile }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(300);
  const [error, setError] = useState('');

  // For text files, encode content to bytes
  const isTextMode = !file.isBinary;
  const textBytesRef = useRef<Uint8Array | null>(null);
  const textContentRef = useRef('');
  if (isTextMode && file.content !== textContentRef.current) {
    textBytesRef.current = new TextEncoder().encode(file.content);
    textContentRef.current = file.content;
  }

  // For binary files: sparse chunk cache
  const chunkCache = useRef<Map<number, Uint8Array>>(new Map());
  const [totalSize, setTotalSize] = useState(file.fileSize || 0);
  const loadingChunks = useRef<Set<number>>(new Set());
  const [renderTick, setRenderTick] = useState(0);
  const prevPathRef = useRef(file.fullPath);

  // Reset when file changes
  useEffect(() => {
    if (file.fullPath !== prevPathRef.current) {
      chunkCache.current.clear();
      loadingChunks.current.clear();
      prevPathRef.current = file.fullPath;
      setScrollTop(0);
      setTotalSize(file.fileSize || 0);
    }
    if (!isTextMode) loadChunkAt(0);
  }, [file.path, file.fullPath]);

  // Update text bytes when content changes
  useEffect(() => {
    if (isTextMode) {
      textBytesRef.current = new TextEncoder().encode(file.content);
      textContentRef.current = file.content;
      setRenderTick(n => n + 1);
    }
  }, [file.content, isTextMode]);

  const chunkAlignedOffset = (byteOffset: number) =>
    Math.floor(byteOffset / CHUNK_SIZE) * CHUNK_SIZE;

  const loadChunkAt = useCallback(async (alignedOffset: number) => {
    if (isTextMode) return;
    if (chunkCache.current.has(alignedOffset)) return;
    if (loadingChunks.current.has(alignedOffset)) return;

    loadingChunks.current.add(alignedOffset);
    try {
      const res = await fetch(
        `/api/files/raw?path=${encodeURIComponent(file.fullPath)}&offset=${alignedOffset}&length=${CHUNK_SIZE}`
      );
      if (!res.ok) throw new Error('Failed to load chunk');
      const json = await res.json();
      const bytes = Uint8Array.from(atob(json.data), c => c.charCodeAt(0));
      setTotalSize(json.size);
      chunkCache.current.set(alignedOffset, bytes);

      // Evict old chunks (keep max 8 = 1MB)
      if (chunkCache.current.size > 8) {
        const keys = [...chunkCache.current.keys()].sort((a, b) =>
          Math.abs(a - alignedOffset) - Math.abs(b - alignedOffset)
        );
        // Keep closest 6 chunks
        for (const k of keys.slice(6)) {
          chunkCache.current.delete(k);
        }
      }

      setError('');
      setRenderTick(n => n + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      loadingChunks.current.delete(alignedOffset);
    }
  }, [file.fullPath, isTextMode]);

  const getByte = (byteOffset: number): number | null => {
    if (isTextMode) {
      const bytes = textBytesRef.current;
      if (!bytes || byteOffset >= bytes.length) return null;
      return bytes[byteOffset];
    }
    const aligned = chunkAlignedOffset(byteOffset);
    const chunk = chunkCache.current.get(aligned);
    if (!chunk) return null;
    const idx = byteOffset - aligned;
    if (idx >= chunk.length) return null;
    return chunk[idx];
  };

  // Track body size
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) setBodyHeight(h);
      }
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

    for (let off = chunkAlignedOffset(firstByte); off < lastByte; off += CHUNK_SIZE) {
      loadChunkAt(off);
    }
  }, [bodyHeight, loadChunkAt, isTextMode]);

  const effectiveSize = isTextMode ? (textBytesRef.current?.length || 0) : totalSize;
  const totalRows = Math.ceil(effectiveSize / BYTES_PER_ROW);
  const totalHeight = totalRows * ROW_HEIGHT;
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const visibleRowCount = Math.ceil(bodyHeight / ROW_HEIGHT) + 2;
  const lastRow = Math.min(firstVisibleRow + visibleRowCount, totalRows);

  const rows: React.ReactNode[] = [];
  for (let r = firstVisibleRow; r < lastRow; r++) {
    const rowOffset = r * BYTES_PER_ROW;
    const bytesInRow = Math.min(BYTES_PER_ROW, effectiveSize - rowOffset);

    let hexParts: string[] = [];
    let asciiParts: string[] = [];

    for (let c = 0; c < BYTES_PER_ROW; c++) {
      if (c < bytesInRow) {
        const byte = getByte(rowOffset + c);
        if (byte !== null) {
          hexParts.push(toHex(byte));
          asciiParts.push(toAscii(byte));
        } else {
          hexParts.push('..');
          asciiParts.push(' ');
        }
      } else {
        hexParts.push('  ');
        asciiParts.push(' ');
      }
    }

    // Format hex with gap between byte 7 and 8
    const hexLeft = hexParts.slice(0, 8).join(' ');
    const hexRight = hexParts.slice(8).join(' ');

    rows.push(
      <div
        key={r}
        className="hex-row"
        style={{ position: 'absolute', top: r * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
      >
        <span className="hex-offset">{formatOffset(rowOffset, effectiveSize)}</span>
        <span className="hex-bytes">{hexLeft}  {hexRight}</span>
        <span className="hex-ascii">{asciiParts.join('')}</span>
      </div>
    );
  }

  const sizeLabel = effectiveSize >= 1024 * 1024
    ? (effectiveSize / 1024 / 1024).toFixed(1) + ' MB'
    : effectiveSize >= 1024
    ? (effectiveSize / 1024).toFixed(1) + ' KB'
    : effectiveSize + ' B';

  return (
    <div className="hex-viewer">
      <div className="hex-header">
        <span className="hex-offset">Offset</span>
        <span className="hex-bytes">00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F</span>
        <span className="hex-ascii">ASCII</span>
        <span className="hex-info">{sizeLabel}</span>
      </div>
      {error && <div style={{ color: 'var(--error)', padding: 8 }}>{error}</div>}
      <div className="hex-body" ref={bodyRef} onScroll={handleScroll}>
        <div style={{ height: totalHeight, position: 'relative' }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
