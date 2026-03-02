import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  sessionId: string;
}

export default function TerminalView({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#e6edf3',
        brightBlack: '#484f58',
        brightRed: '#f85149',
        brightGreen: '#3fb950',
        brightYellow: '#d29922',
        brightBlue: '#58a6ff',
        brightMagenta: '#bc8cff',
        brightCyan: '#39d353',
        brightWhite: '#f0f6fc',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output') {
          term.write(msg.data);
        }
      } catch {}
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[Terminal disconnected]\x1b[0m\r\n');
    };

    // Send user input to server
    term.onData((data) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Re-fit when container becomes visible or resizes
    const resizeObserver = new ResizeObserver(() => {
      // Only fit when the container has non-zero dimensions (i.e., visible)
      if (containerRef.current && containerRef.current.offsetWidth > 0) {
        fitAddon.fit();
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    // Also use IntersectionObserver to detect visibility changes (display:none → visible)
    const intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          // Small delay to let the layout settle
          requestAnimationFrame(() => {
            fitAddon.fit();
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
          });
        }
      }
    });
    intersectionObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#0d1117',
        padding: 4,
      }}
    />
  );
}
