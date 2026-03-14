import React from 'react';

const shortcuts: { key: string; description: string }[] = [
  { key: 'Ctrl+S', description: 'Save current file' },
  { key: 'Ctrl+Shift+S', description: 'New session' },
  { key: 'Ctrl+Shift+T', description: 'New terminal' },
  { key: 'Ctrl+Shift+W', description: 'Create worktree' },
  { key: 'F1', description: 'Open this help dialog' },
  { key: 'Ctrl+Shift+?', description: 'Open this help dialog' },
  { key: 'Delete', description: 'Delete selected file/folder (in file tree)' },
  { key: 'Escape', description: 'Close dialog / modal' },
  { key: 'Enter', description: 'Confirm dialog' },
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = React.useState<'shortcuts' | 'about'>('shortcuts');

  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="help-modal">
      <div className="help-modal-header">
        <div className="help-modal-tabs">
          <button className={`help-tab ${tab === 'shortcuts' ? 'active' : ''}`} onClick={() => setTab('shortcuts')}>Keyboard Shortcuts</button>
          <button className={`help-tab ${tab === 'about' ? 'active' : ''}`} onClick={() => setTab('about')}>About</button>
        </div>
        <button className="help-modal-close" onClick={onClose}>&#x2715;</button>
      </div>
      <div className="help-modal-body">
        {tab === 'shortcuts' && <ShortcutsTab />}
        {tab === 'about' && <AboutTab />}
      </div>
    </div>
  );
}

function ShortcutsTab() {
  return (
    <div className="help-shortcuts">
      <table className="help-shortcuts-table">
        <thead>
          <tr>
            <th>Shortcut</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {shortcuts.map((s, i) => (
            <tr key={i}>
              <td><kbd className="help-kbd">{s.key}</kbd></td>
              <td>{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="help-about">
      <div className="help-about-logo">
        <img src="/logo_64x64.png" alt="Atoo Studio" className="help-about-icon" />
        <div>
          <div className="help-about-title">Atoo Studio</div>
          <div className="help-about-subtitle">Agentic Development Environment</div>
        </div>
      </div>

      <div className="help-about-section">
        <div className="help-about-label">Created by</div>
        <div className="help-about-value help-about-creator">Markus Furtlehner</div>
      </div>

      <div className="help-about-section">
        <div className="help-about-label">GitHub</div>
        <a className="help-about-link" href="https://github.com/atooai/atoo-studio" target="_blank" rel="noopener noreferrer">
          github.com/atooai/atoo-studio
        </a>
      </div>

      <div className="help-about-section">
        <div className="help-about-label">License</div>
        <div className="help-about-value">MIT License</div>
        <div className="help-about-license-text">
          Copyright (c) {new Date().getFullYear()} Markus Furtlehner
          {'\n\n'}
          Permission is hereby granted, free of charge, to any person obtaining a copy
          of this software and associated documentation files (the &quot;Software&quot;), to deal
          in the Software without restriction, including without limitation the rights
          to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
          copies of the Software, and to permit persons to whom the Software is
          furnished to do so, subject to the following conditions:
          {'\n\n'}
          The above copyright notice and this permission notice shall be included in all
          copies or substantial portions of the Software.
          {'\n\n'}
          THE SOFTWARE IS PROVIDED &quot;AS IS&quot;, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
          IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
          AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
          LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
          OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
          SOFTWARE.
        </div>
      </div>

      <div className="help-about-section">
        <div className="help-about-label">Description</div>
        <div className="help-about-value">
          Atoo Studio is a browser-based agentic development environment that combines
          AI-powered coding sessions, a full file editor, Git integration, GitHub issue/PR
          management, live preview, terminal access, database exploration, and container
          management &mdash; all in a single unified interface.
        </div>
      </div>

      <div className="help-about-section">
        <div className="help-about-label">Key Features</div>
        <ul className="help-about-features">
          <li>Multi-agent AI sessions with Claude, Codex, Gemini &amp; more</li>
          <li>Monaco-based code editor with diff, hex, and rendered views</li>
          <li>Git history, branching, worktrees, and stash management</li>
          <li>GitHub issues &amp; pull requests integration</li>
          <li>Live app preview with device emulation &amp; DevTools</li>
          <li>Integrated terminal with full PTY support</li>
          <li>Multi-environment &amp; multi-project workspace</li>
          <li>Database explorer with multi-driver support</li>
          <li>Container management (Docker, Podman, LXC)</li>
          <li>Remote development via SSH</li>
          <li>PWA installable as desktop app</li>
        </ul>
      </div>
    </div>
  );
}
