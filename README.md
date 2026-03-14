<p align="center">
  <img src="docs/logo.png" alt="Atoo Studio" width="64" height="64">
</p>

<h1 align="center">Atoo Studio</h1>

<p align="center">
  <strong>Agent Development Environment (ADE)</strong><br>
  A workspace where coding agents build, run and debug real systems.
</p>

<p align="center">
  <a href="https://atoo.ai">Website</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a>
</p>

---

## What is Atoo Studio?

Atoo Studio is a lightweight, browser-based development environment designed for working with coding agents like **Claude Code**, **Codex CLI** and **Gemini CLI**.

Instead of juggling terminals, browser tabs, preview windows and disconnected agent sessions, Atoo Studio brings everything into one workspace — agents, code, preview, DevTools, Git and even hardware devices.

It runs alongside your agents on Linux, macOS or WSL as a local web server. No cloud dependency, no vendor lock-in.

## Why?

Working with coding agents across multiple projects gets chaotic fast. You end up with dozens of terminals, scattered browser tabs, dev servers running on random ports, and no clear overview of what each agent is doing.

Atoo Studio was built from that exact pain — managing five projects in parallel with multiple coding agents and needing a workspace that actually matches how agentic development works.

## Features

### Multi-agent workflows
Run multiple coding agents (Claude Code, Codex CLI, Gemini CLI) in parallel across isolated environments and projects.

### Fork sessions like Git branches
Branch agent conversations at any point and explore different solutions without losing the original context. Fork from a specific message or select a range of messages for the new session.

### Continue work across agents
Start a session with Claude, continue it with Codex, hand it to Gemini. Compare approaches without starting over.

### Operate real development environments
Agents can start services and dev servers. Atoo Studio automatically detects them and exposes live previews with valid HTTPS certificates from a built-in CA.

### Preview, inspect and debug
Built-in app preview via CDP pixel streaming (not iframes — no cross-origin issues), integrated Chrome DevTools, and live terminal logs. All in the same workspace.

### Responsive testing
Test across device presets (iPhone, Pixel, iPad, Desktop) with device pixel ratio and touch emulation. Custom viewports, zoom levels and rotation.

### Flash and debug real hardware
Agents can connect to devices like ESP32 boards through the browser via Web Serial. Flash firmware, monitor serial output — even when the agent runs on a remote server.

### Real-time collaboration
Multiple browsers can connect to the same workspace. Views synchronize in real-time — chat, preview, terminal, everything shared.

### Session tree visualization
Forked sessions are displayed as a parent-child tree, making it easy to see the full history of exploration and decisions.

### Drag & drop with native file system
Move files and folders between Atoo Studio and your OS file explorer. Folders export as ZIP when dragging from browser (Chromium limitation).

### Git integration
Branch overview with commit history, worktree support (new or existing branches), and diff views.

### Multi-environment support
Run projects in isolated environments. Switch between them from the workspace.

### Reverse proxy & networking
Built-in reverse proxy with subdomain and path-based routing. Host header injection for multi-domain testing.

### File explorer & editor
File tree, source/diff/rendered/hex view modes. Built-in hex editor.

### Integrated terminal
Multiple terminal tabs running directly on the server.

## Getting Started

### Requirements
- Node.js 18+
- Linux, macOS or WSL

### Quick start

```bash
npx atoo-studio
```

Then open `http://localhost:3000` in your browser.

### Docker

```bash
docker run -p 3000:3000 atooai/atoo-studio
```

## Architecture

Atoo Studio is a lightweight web application that runs on the same server as your coding agents. Everything is in one process — workspace, agents, preview, proxy, terminal, Git integration.

```
Browser (any device)
    │
    │ WebSocket
    ▼
Atoo Studio Backend
    │
    ├── Agent sessions (xterm)
    ├── Project & worktree manager
    ├── Git integration
    ├── Reverse proxy
    ├── CDP preview (headless Chrome)
    ├── Certificate authority
    ├── Service registry
    ├── Serial device bridge
    └── MCP server
```

Agents run inside real terminal sessions (xterm). Atoo Studio does not replace the agent — it provides the environment where agents operate.

## MCP Functions

Atoo Studio provides MCP tools that agents can call:

- **`generate_certificate`** — Request a trusted HTTPS certificate for any hostname. The built-in CA is trusted by the preview browser.
- **`report_tcp_services`** — Report started services (dev servers, APIs, etc.) so Atoo Studio can auto-detect and expose them in the preview panel.

More MCP functions are planned, including cross-session search and project memory.

## Status

**Early alpha.** Built for personal use across multiple projects. Works, but has rough edges.

Known limitations:
- UI needs polish in some areas
- Some edge cases in session forking
- Documentation is minimal

Sharing because the ideas and architecture might be useful to others building in this space.

## Roadmap

- [ ] Cross-session project memory via MCP (search decisions and context across all agent sessions)
- [ ] Pluggable agent adapters (standardized interface for any CLI agent)
- [ ] Service topology view
- [ ] Session migration between environments
- [ ] Trust level configuration per tool

## Contributing

Contributions are welcome. If you find a bug or have an idea, open an issue.

## License

[MIT](LICENSE)

## Author

Built by [Markus Furtlehner](https://github.com/markusfurtlehner) — founder of [IT Trail GmbH](https://www.ittrail.at).

Built from real pain, not a pitch deck.

→ [atoo.ai](https://atoo.ai)