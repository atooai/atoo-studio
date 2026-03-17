# Atoo Studio

**Agentic Development Environment** — A workspace where coding agents build, run and debug real systems.

Atoo Studio is a browser-based development environment for working with coding agents like Claude Code and Codex CLI. It brings agents, code, preview, DevTools, Git, GitHub, databases and hardware devices into one workspace.

Runs on Linux, macOS or WSL as a local web server. No cloud dependency, no vendor lock-in.

## Quick Start

```bash
npx atoo-studio
```

Then open `https://localhost:3010` in your browser.

To use a different port:

```bash
ATOO_PORT=4000 npx atoo-studio
```

## Install Globally

```bash
npm install -g atoo-studio
atoo-studio
```

## Docker

```bash
docker run -p 3010:3010 ghcr.io/atooai/atoo-studio
```

## Features

- **Multi-agent workflows** — Run Claude Code, Codex CLI and more in parallel across projects and worktrees
- **Session forking & chaining** — Chain sessions across agents, search history via MCP
- **Project changes tracking** — Know what was done, by which session, and when
- **App preview** — Live preview via headless Chrome (CDP pixel streaming), with DevTools and responsive testing
- **GitHub integration** — Issues, PRs, comments, labels — all from the workspace
- **Git integration** — Branches, commits, worktrees, stash, diff views, one-click publish
- **Database explorer** — 15+ database types with specialized views (PostgreSQL, MySQL, SQLite, Redis, MongoDB, Neo4j, InfluxDB, and more)
- **Container management** — Docker, Podman, and LXC containers
- **File editor** — Source, diff, rendered, and hex views with drag-and-drop
- **Serial devices** — Flash ESP32 and Arduino boards through the browser via Web Serial
- **Terminal** — Multiple PTY sessions with full terminal capabilities
- **Reverse proxy** — Subdomain and path-based routing with automatic service detection
- **Authentication** — Password, TOTP, and WebAuthn/passkey support
- **HTTPS** — Built-in certificate authority trusted by the preview browser
- **Mobile layout** — Responsive UI with swipe gestures
- **PWA** — Installable as a desktop app

## Requirements

- Node.js 18+
- Linux, macOS or WSL
- git

### Optional dependencies

| Dependency | Feature |
|------------|---------|
| `claude` (Claude Code) | Claude Code agent |
| `codex` (Codex CLI) | Codex agent |
| `gh` (GitHub CLI) | GitHub integration |
| docker / podman / lxc | Container management |
| ffmpeg | Screen recording |

Missing dependencies are reported as warnings on startup.

### Linux setup

```bash
# Install Chrome/Puppeteer dependencies and ffmpeg
sudo ./setup.sh

# Optional: Serial control signals (DTR/RTS) for device flashing
sudo ./setup-cuse.sh
```

### macOS setup

```bash
# Install ffmpeg for screen recording (optional)
./setup.sh
```

## Platform Support

| Feature | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Core (agents, terminal, git, files) | Yes | Yes | No (use WSL) |
| Browser preview | Yes | Yes | — |
| Serial devices (CUSE) | Yes | No | — |
| Serial devices (PTY fallback) | Yes | Yes | — |

## MCP Tools

Atoo Studio exposes MCP tools for agent integration:

`generate_certificate` · `report_tcp_services` · `request_serial_device` · `search_session_history` · `suggest_continue_in_other_session` · `open_file` · `get_session_metadata` · `set_session_metadata` · `github_issue_pr_changed` · `connect_database` · `track_project_changes`

## Other Installation Methods

- **Docker**: `ghcr.io/atooai/atoo-studio`
- **LXC/LXD**: Download from [GitHub Releases](https://github.com/atooai/atoo-studio/releases)
- **Proxmox**: One-command [LXC](https://github.com/atooai/atoo-studio/tree/master/proxmox) and [VM](https://github.com/atooai/atoo-studio/tree/master/proxmox) scripts

## Links

- [GitHub](https://github.com/atooai/atoo-studio)
- [Website](https://atoo.ai)

## License

MIT — Built by [Markus Furtlehner](https://github.com/markusfurtlehner)
