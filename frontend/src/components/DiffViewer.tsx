import React, { useMemo } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { objectUrl } from '../api/client';

export interface DiffSide {
  content: string | null;   // base64 for binary, utf-8 text for text
  hash: string;
  size: number;
  isBinary: boolean;
}

interface DiffViewerProps {
  path: string;
  before: DiffSide | null;
  after: DiffSide | null;
  onClose?: () => void;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', sh: 'shell', bash: 'shell', zsh: 'shell',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', sql: 'sql', graphql: 'graphql',
  dockerfile: 'dockerfile', makefile: 'makefile',
};

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const basename = filePath.split('/').pop()?.toLowerCase() || '';
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  return EXT_TO_LANGUAGE[ext] || 'plaintext';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageMime(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext);
}

export default function DiffViewer({ path, before, after, onClose }: DiffViewerProps) {
  const language = useMemo(() => detectLanguage(path), [path]);
  const isBinary = before?.isBinary || after?.isBinary;
  const isImage = isImageMime(path);

  const beforeText = useMemo(() => {
    if (!before?.content || before.isBinary) return '';
    try { return atob(before.content); } catch { return ''; }
  }, [before]);

  const afterText = useMemo(() => {
    if (!after?.content || after.isBinary) return '';
    try { return atob(after.content); } catch { return ''; }
  }, [after]);

  // Compute line diff summary for text files
  const diffSummary = useMemo(() => {
    if (isBinary) return 'binary changed';
    const beforeLines = beforeText ? beforeText.split('\n').length : 0;
    const afterLines = afterText ? afterText.split('\n').length : 0;
    const added = Math.max(0, afterLines - beforeLines);
    const removed = Math.max(0, beforeLines - afterLines);
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`-${removed}`);
    return parts.length > 0 ? `${parts.join(' / ')} lines` : 'no changes';
  }, [beforeText, afterText, isBinary]);

  // Size diff
  const sizeBefore = before?.size || 0;
  const sizeAfter = after?.size || 0;
  const sizeDelta = sizeAfter - sizeBefore;
  const sizeDeltaStr = sizeDelta > 0 ? `+${formatSize(sizeDelta)}` : sizeDelta < 0 ? `-${formatSize(-sizeDelta)}` : 'no change';

  return (
    <div style={styles.container}>
      {/* Metadata bar */}
      <div style={styles.metaBar}>
        <div style={styles.metaRow}>
          <span style={styles.filePath}>{path}</span>
          {onClose && (
            <button onClick={onClose} style={styles.closeBtn}>Close</button>
          )}
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaItem}>
            Size: {formatSize(sizeBefore)} → {formatSize(sizeAfter)} ({sizeDeltaStr})
          </span>
          <span style={styles.metaItem}>{diffSummary}</span>
        </div>
        <div style={styles.metaRow}>
          {before?.hash && (
            <a href={objectUrl(before.hash)} download style={styles.downloadBtn}>
              Download Before
            </a>
          )}
          {after?.hash && (
            <a href={objectUrl(after.hash)} download style={styles.downloadBtn}>
              Download After
            </a>
          )}
        </div>
      </div>

      {/* Content area */}
      {isBinary && isImage ? (
        <div style={styles.imageCompare}>
          <div style={styles.imageSide}>
            <div style={styles.imageLabel}>Before</div>
            {before?.content ? (
              <img
                src={`data:image/${path.split('.').pop()};base64,${before.content}`}
                alt="Before"
                style={styles.image}
              />
            ) : (
              <div style={styles.placeholder}>No file</div>
            )}
          </div>
          <div style={styles.imageSide}>
            <div style={styles.imageLabel}>After</div>
            {after?.content ? (
              <img
                src={`data:image/${path.split('.').pop()};base64,${after.content}`}
                alt="After"
                style={styles.image}
              />
            ) : (
              <div style={styles.placeholder}>No file</div>
            )}
          </div>
        </div>
      ) : isBinary ? (
        <div style={styles.binaryInfo}>
          <p>Binary file changed</p>
          <div style={styles.sizeBar}>
            <div style={styles.sizeBarItem}>
              <div style={styles.sizeLabel}>Before</div>
              <div style={{ ...styles.sizeBlock, width: `${Math.min(100, (sizeBefore / Math.max(sizeBefore, sizeAfter, 1)) * 100)}%` }}>
                {formatSize(sizeBefore)}
              </div>
            </div>
            <div style={styles.sizeBarItem}>
              <div style={styles.sizeLabel}>After</div>
              <div style={{ ...styles.sizeBlock, width: `${Math.min(100, (sizeAfter / Math.max(sizeBefore, sizeAfter, 1)) * 100)}%`, background: '#2ea04370' }}>
                {formatSize(sizeAfter)}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={styles.editorContainer}>
          <DiffEditor
            original={beforeText}
            modified={afterText}
            language={language}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              lineNumbers: 'on',
              wordWrap: 'off',
            }}
            height="400px"
          />
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    border: '1px solid #333',
    borderRadius: 6,
    overflow: 'hidden',
    margin: '8px 0',
    background: '#1e1e2e',
  },
  metaBar: {
    padding: '8px 12px',
    borderBottom: '1px solid #333',
    background: '#252540',
    fontSize: 12,
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
    flexWrap: 'wrap' as const,
  },
  filePath: {
    fontWeight: 600,
    color: '#e0e0e0',
    flex: 1,
    fontFamily: 'monospace',
  },
  closeBtn: {
    background: '#444',
    border: 'none',
    color: '#ccc',
    padding: '2px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
  },
  metaItem: {
    color: '#999',
    fontSize: 11,
  },
  downloadBtn: {
    color: '#7aa2f7',
    textDecoration: 'none',
    fontSize: 11,
    padding: '2px 6px',
    border: '1px solid #444',
    borderRadius: 4,
  },
  editorContainer: {
    height: 400,
  },
  imageCompare: {
    display: 'flex',
    gap: 8,
    padding: 12,
  },
  imageSide: {
    flex: 1,
    textAlign: 'center' as const,
  },
  imageLabel: {
    color: '#999',
    fontSize: 11,
    marginBottom: 4,
  },
  image: {
    maxWidth: '100%',
    maxHeight: 300,
    objectFit: 'contain' as const,
    border: '1px solid #444',
    borderRadius: 4,
  },
  placeholder: {
    color: '#666',
    padding: 40,
    border: '1px dashed #444',
    borderRadius: 4,
  },
  binaryInfo: {
    padding: 16,
    color: '#999',
    textAlign: 'center' as const,
  },
  sizeBar: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    maxWidth: 400,
    margin: '12px auto',
  },
  sizeBarItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  sizeLabel: {
    width: 50,
    textAlign: 'right' as const,
    fontSize: 11,
    color: '#888',
  },
  sizeBlock: {
    background: '#e5534b40',
    padding: '4px 8px',
    borderRadius: 4,
    fontSize: 11,
    color: '#ccc',
    minWidth: 60,
    textAlign: 'center' as const,
  },
};
