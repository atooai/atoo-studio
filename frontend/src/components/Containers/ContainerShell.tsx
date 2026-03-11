import React from 'react';

type Runtime = 'docker' | 'podman' | 'lxc';

interface Props {
  runtime: Runtime;
  containerId: string;
}

export function ContainerShell({ runtime, containerId }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const cleanupRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    (async () => {
      const [xterm, fit] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css'),
      ]);
      if (cancelled) return;

      const termEl = document.createElement('div');
      termEl.style.cssText = 'width:100%;height:100%';
      el.innerHTML = '';
      el.appendChild(termEl);

      const term = new xterm.Terminal({
        theme: {
          background: '#0a0b0f', foreground: '#e0e0e0', cursor: '#5b8af5',
          selectionBackground: '#5b8af53a',
        },
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        cursorBlink: true,
      });

      // Ctrl+C copy / Ctrl+V paste passthrough
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== 'keydown') return true;
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          if (e.key === 'c' && term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection());
            term.clearSelection();
            return false;
          }
          if (e.key === 'v') return false;
        }
        return true;
      });

      const fitAddon = new fit.FitAddon();
      term.loadAddon(fitAddon);
      term.open(termEl);
      fitAddon.fit();

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/container-shell/${runtime}/${encodeURIComponent(containerId)}`);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'output' && msg.data) term.write(msg.data);
          if (msg.type === 'exit') term.write('\r\n\x1b[90m[shell exited]\x1b[0m\r\n');
        } catch {}
      };
      ws.onclose = () => term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');

      term.onData((data: string) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });

      const resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(el);

      cleanupRef.current = () => {
        resizeObserver.disconnect();
        ws.close();
        term.dispose();
      };

      setTimeout(() => fitAddon.fit(), 50);
    })().catch(() => {
      if (el) el.innerHTML = '<div style="color:var(--text-muted);padding:8px;font-size:12px">Failed to load terminal</div>';
    });

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [runtime, containerId]);

  return <div ref={containerRef} className="container-terminal" />;
}
