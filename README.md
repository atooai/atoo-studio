<p align="center">
  <img src="https://atoo.ai/img/logo_64x64.png" alt="Atoo Studio" width="64" height="64">
</p>

<h1 align="center">Atoo Studio</h1>

<p align="center">
  <strong>Agentic Development Environment</strong><br>
  A workspace where coding agents build, run and debug real systems.
</p>

<p align="center">
  <a href="https://atoo.ai">Website</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#features">Features</a>
</p>

---

## What is Atoo Studio?

Atoo Studio is a browser-based development environment designed for working with coding agents like **Claude Code** and **Codex CLI**.

Instead of juggling terminals, browser tabs, preview windows and disconnected agent sessions, Atoo Studio brings everything into one workspace — agents, code, preview, DevTools, Git, GitHub, databases and even hardware devices.

It runs alongside your agents on Linux, macOS or WSL as a local web server. No cloud dependency, no vendor lock-in.

## Why?

Working with coding agents across multiple projects gets chaotic fast. You end up with dozens of terminals, scattered browser tabs, dev servers running on random ports, and no clear overview of what each agent is doing.

Atoo Studio was built from that exact pain — managing multiple projects in parallel with coding agents and needing a workspace that actually matches how agentic development works.

## Features

### Multi-agent workflows
Run multiple coding agents (Claude Code, Codex CLI) in parallel across isolated projects and worktrees. Each agent runs in a real PTY session with full terminal capabilities.

### Fork sessions like Git branches
Branch agent conversations at any point and explore different solutions without losing the original context. Fork from a specific message or select a range of messages for the new session. Forked sessions are displayed as a parent-child tree in the sidebar.

### Chain sessions across agents
Start a session with Claude Code, continue it with Codex. The session chain system preserves full conversation history across agent boundaries, so agents can pick up exactly where the previous one left off.

### Session history search
Search across all agent session history for a project via MCP. Agents can recall past decisions, failed approaches, and implementation reasoning from any previous session — including sessions in other worktrees.

### Session metadata
Agents can set session names, descriptions, and tags via MCP tools. Tags appear as badges in the sidebar, and session names are used as tab titles for quick identification.

### App preview with CDP pixel streaming
Built-in app preview powered by headless Chrome and the Chrome DevTools Protocol — not iframes, so there are no cross-origin issues. Agents start dev servers and Atoo Studio automatically detects them and renders live previews with full interaction support.

### Integrated Chrome DevTools
Open Chrome DevTools directly inside the workspace panel to inspect and debug previewed applications without leaving Atoo Studio.

### HTTPS certificates from built-in CA
Agents can request trusted TLS certificates for any hostname via MCP. The built-in certificate authority is trusted by the preview browser, enabling HTTPS testing without manual cert setup.

### Responsive testing
Test across device presets (iPhone, Pixel, iPad, Desktop) with device pixel ratio and touch emulation. Custom viewports, zoom levels and rotation — all within the preview panel.

### GitHub integration
Browse issues and pull requests, view details and comments, close/reopen issues and PRs, and create new pull requests — all from the GitHub panel. Link sessions to specific issues or PRs for context. Create new issues directly through an agent session.

### Git integration
Branch overview with full commit history, stash management, diff views, and one-click commit/push workflow. Worktree support for working on multiple branches simultaneously as separate projects in the sidebar. A "Publish" button commits, pushes, and creates a PR in one action.

### Database explorer
Connect to 15 database types (PostgreSQL, MySQL, SQLite, Redis, MongoDB, Elasticsearch, ClickHouse, CockroachDB, Cassandra, Neo4j, InfluxDB, and more) with specialized views for each — key browsers for Redis, document viewers for MongoDB, graph visualization for Neo4j, charts for InfluxDB. Auto-discovers connections from docker-compose files, environment variables, and port scanning.

### Container management
Manage Docker, Podman and LXC containers from the workspace. List, inspect, start, stop, restart and delete containers. Browse images, volumes, networks, and docker-compose projects. View container logs and stats.

### File explorer & editor
File tree with drag-and-drop support (between Atoo Studio and your OS file manager). Source, diff, rendered and hex view modes. Built-in hex editor with search and replace. Tab drag-and-drop reordering with context menus.

### Flash and debug real hardware
Agents can connect to devices like ESP32 boards through the browser via Web Serial. The serial connection is bridged to a virtual PTY on the server, so agents can flash firmware and monitor serial output — even when the agent runs on a remote server.

### Integrated terminal
Multiple terminal tabs running directly on the server with full PTY support.

### Reverse proxy & networking
Built-in reverse proxy with subdomain and path-based routing. Host header injection for multi-domain testing. Forwarded connections modal shows all detected services with direct links.

### Authentication
Optional session-based authentication with password, TOTP two-factor, and WebAuthn/passkey support. MCP token validation ensures only authenticated agents can call back to the UI.

### Real-time collaboration
Multiple browsers can connect to the same workspace. Views synchronize in real-time — chat, preview, terminal output, everything shared.

### Mobile layout
Responsive mobile layout with swipe gestures, bottom navigation, and dedicated views for dashboard, files, git, agents, and terminal.

### Installable as desktop app
PWA support — install Atoo Studio as a standalone desktop application from the browser.

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
docker run -p 3010:3010 ghcr.io/atooai/atoo-studio
```

## Architecture

Atoo Studio runs as a single process on the same server as your coding agents — workspace, agents, preview, proxy, terminal, and Git integration all in one.

```
Browser (any device)
    │
    │ WebSocket + HTTP
    ▼
Atoo Studio Backend
    │
    ├── Agent adapters (Claude Code, Codex)
    ├── PTY session manager
    ├── Session chain & fork system
    ├── Project & worktree manager
    ├── Git & GitHub integration
    ├── Database explorer
    ├── Container manager (Docker, Podman, LXC)
    ├── Reverse proxy with service registry
    ├── CDP preview (headless Chrome)
    ├── Certificate authority
    ├── Serial device bridge
    ├── Authentication system
    └── MCP server (11 tools)
```

Agents run inside real terminal sessions. Atoo Studio does not replace the agent — it provides the environment where agents operate.

## MCP Tools

Atoo Studio exposes 11 MCP tools that agents can call:

| Tool | Description |
|------|-------------|
| `generate_certificate` | Request a trusted HTTPS certificate for any hostname |
| `report_tcp_services` | Report started services so they appear in the preview panel |
| `request_serial_device` | Request USB serial device access via Web Serial bridge |
| `search_session_history` | Search across all session history or within the current session chain |
| `suggest_continue_in_other_session` | Suggest switching to an existing session that has relevant context |
| `open_file` | Open a file in the browser editor (requires user approval) |
| `get_session_metadata` | Read session name, description, and tags |
| `set_session_metadata` | Set session name, description, and tags |
| `github_issue_pr_changed` | Notify the UI when a GitHub issue or PR is created/modified |
| `connect_database` | Open the database explorer with a specific connection |

## Status

Actively used for daily development work across multiple projects. Still evolving fast — expect rough edges. Contributions and feedback welcome.

## Roadmap

- [ ] More agent adapters (Gemini CLI, Aider, and others)
- [ ] Service topology visualization
- [ ] Session migration between environments
- [ ] Configurable trust levels per tool

## Contributing

Contributions are welcome. If you find a bug or have an idea, open an issue.

## License

[MIT](LICENSE)

## Author

Built by [Markus Furtlehner](https://github.com/markusfurtlehner) — founder of [IT Trail GmbH](https://www.ittrail.at).

Built from real pain, not a pitch deck.

> [atoo.ai](https://atoo.ai)
