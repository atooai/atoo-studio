<p align="center">
  <img src="https://atoo.ai/img/logo_64x64.png" alt="Atoo Studio" width="64" height="64">
</p>

<h1 align="center">Atoo Studio</h1>

<p align="center">
  <strong>Local-first workspace for Claude Code, Codex CLI, and other coding agents.</strong><br>
  Run multiple agents across projects and worktrees, fork and chain sessions, preview apps with real Chrome + DevTools, and manage Git, GitHub, databases, containers, and hardware from one browser UI.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-early%20alpha-orange" alt="Early Alpha">
</p>

<p align="center">
  <a href="https://atoo.ai">Website</a> ·
  <a href="#demo">Demo</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#core-capabilities">Core Capabilities</a> ·
  <a href="#platform-support">Platform Support</a>
</p>

<p align="center">
  Built by <a href="https://github.com/markusfurtlehner">Markus Furtlehner</a> ·
  <a href="https://www.ittrail.at">IT Trail GmbH</a>
</p>

---

## Demo

<table align="center">
  <tr>
    <td align="center"><img src="demoassets/layout-21-9.png" alt="Atoo Studio on an ultrawide display" width="820"></td>
  </tr>
  <tr>
    <td align="center"><sub>Ultrawide (21:9) — the full workspace with agent sessions, file tree, editor, and live app preview side by side.</sub></td>
  </tr>
</table>

<table align="center">
  <tr>
    <td align="center"><img src="demoassets/layout-16-9.png" alt="Atoo Studio on a standard display" width="560"></td>
    <td align="center"><img src="demoassets/mobile-mockup-portrait.jpg" alt="Atoo Studio on mobile" width="225"></td>
  </tr>
  <tr>
    <td align="center"><sub>Standard (16:9) — collapsible sidebars keep the full workspace usable, including the live app preview.</sub></td>
    <td align="center"><sub>Mobile — a dedicated layout with all features accessible on any phone or tablet.</sub></td>
  </tr>
</table>

<table align="center">
  <tr>
    <td align="center"><img src="demoassets/atoo-studio-carousel-mode.gif" alt="Atoo Studio carousel mode" width="420"></td>
  </tr>
  <tr>
    <td align="center"><sub>Experimental carousel view — a 2D panel layout where the active view follows mouse movement automatically.</sub></td>
  </tr>
</table>

## What is Atoo Studio?

Atoo Studio is a browser-based control room for working with coding agents like **Claude Code** and **Codex CLI**.

It does not replace your editor or your agent. It gives them a shared environment: agent sessions, code, live preview, DevTools, Git, GitHub, databases, containers, and even hardware access in one place.

Run it locally on Linux, macOS, or WSL as a local web server. No cloud dependency. No vendor lock-in.

## Why it exists

Coding agents are great at focused tasks. The chaos starts around them.

Once you work across multiple projects, worktrees, terminals, dev servers, browser tabs, and agent sessions, the workflow breaks down fast. You lose context, you lose overview, and you spend too much time managing the environment instead of shipping.

Atoo Studio was built from that exact pain: creating a workspace that actually matches how agent-driven development works in practice.

## Core capabilities

### Agent workflows

- Run multiple coding agents in parallel across isolated projects and worktrees.
- Each agent runs in a real PTY session with full terminal capabilities.
- Fork sessions to explore alternative approaches without losing the original context.
- Chain sessions across agents, so you can start with Claude Code and continue with Codex using the same conversation history.
- Search session history via MCP so agents can reuse past decisions, failed attempts, and implementation context.
- Set session names, descriptions, and tags for better navigation and recall.
- Track project-level changes so you always know what has been done, by which session, and when.

### Preview and debugging

- Built-in app preview powered by headless Chrome and the Chrome DevTools Protocol.
- Pixel-streamed preview, not iframes, so there are no cross-origin limitations.
- Open Chrome DevTools directly inside the workspace.
- Request trusted HTTPS certificates from the built-in CA for local testing.
- Test responsive layouts with device presets, custom viewports, zoom, rotation, and touch emulation.

### Git and GitHub workflow

- Browse issues and pull requests, view comments, and open or update PRs from the GitHub panel.
- Link sessions to issues or pull requests for better task context.
- Inspect branches, commit history, stashes, and diffs from the Git panel.
- Work with multiple Git worktrees side by side as separate projects.
- Use the one-click **Publish** flow to commit, push, and open a PR.

### Data, infrastructure, and devices

- Explore 15 database types including PostgreSQL, MySQL, SQLite, Redis, MongoDB, Elasticsearch, ClickHouse, CockroachDB, Cassandra, Neo4j, and InfluxDB.
- Auto-discover database connections from `docker-compose` files, environment variables, and port scanning.
- Manage Docker, Podman, and LXC containers from the workspace.
- Browse container images, networks, volumes, compose projects, logs, and stats.
- Connect real hardware like ESP32 boards through Web Serial, bridged to a virtual PTY so agents can flash firmware and monitor output.

### Workspace experience

- File explorer and editor with source, diff, rendered, and hex views.
- Integrated terminal tabs running directly on the server.
- Built-in reverse proxy with subdomain and path-based routing.
- Optional authentication with password, TOTP, and WebAuthn/passkeys.
- Real-time shared workspace views across multiple browsers.
- Responsive mobile layout for monitoring and control on the go.
- Installable as a desktop app via PWA.

## Platform support

| Capability | Linux | macOS | Native Windows |
|------------|-------|-------|----------------|
| Core workspace (agents, terminal, git, files) | Yes | Yes | No |
| Browser preview (CDP streaming) | Yes | Yes | - |
| Serial devices (PTY bridge) | Yes | Yes | - |
| Serial control signals (DTR/RTS via CUSE) | Yes | No | - |

**Native Windows is not supported. Use WSL instead.**

**macOS support is completely untested at this time.** It should work in principle, but expect rough edges.

## Getting started

### Requirements

**Required**
- Node.js 18+
- Git
- Linux, macOS, or WSL

**Optional dependencies**

| Dependency | Enables |
|------------|---------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) | Claude Code agent support |
| [Codex CLI](https://github.com/openai/codex) (`codex`) | Codex agent support |
| [GitHub CLI](https://cli.github.com/) (`gh`) | GitHub issues and PR integration |
| `docker`, `podman`, or `lxc` | Container management |
| `ffmpeg` | Screen recording |
| Chrome libraries on Linux | Browser preview |
| CUSE on Linux | Serial control signals (DTR/RTS) |

Missing optional dependencies are reported as warnings on startup.

### Quick start

```bash
npx atoo-studio
```

Then open `https://localhost:3010` in your browser.

To use a different port, set the `ATOO_PORT` environment variable:

```bash
ATOO_PORT=4000 npx atoo-studio
```

### Docker (untested)

```bash
docker run -p 3010:3010 ghcr.io/atooai/atoo-studio
```

To persist data across container restarts:

```bash
docker run -p 3010:3010 -v atoo-data:/home/atoo/.atoo-studio ghcr.io/atooai/atoo-studio
```

### LXC / LXD (untested)

Download the LXC image from the [latest release](https://github.com/atooai/atoo-studio/releases) and import it:

```bash
lxc image import atoo-studio-lxc-amd64.tar.gz --alias atoo-studio
lxc launch atoo-studio my-atoo-studio
```

### Proxmox (experimental, untested)

Run one of the setup scripts on your Proxmox host:

**LXC container** — lightweight, 2 CPU / 2 GB RAM / 20 GB disk

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/lxc.sh)"
```

**VM** — stronger isolation, CUSE/serial support, 4 CPU / 4 GB RAM / 50 GB disk

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/vm.sh)"
```

Both scripts prompt for container or VM ID, hostname, storage, and resources with sensible defaults.

### Linux setup

To enable browser preview and screen recording support:

```bash
sudo ./setup.sh
```

To enable CUSE for serial control signals like DTR/RTS:

```bash
sudo ./setup-cuse.sh
```

`setup.sh` supports `apt-get` (Debian/Ubuntu), `dnf` (Fedora/RHEL), and `pacman` (Arch).

`setup-cuse.sh` builds the native CUSE helper, loads the kernel module, and configures permissions. Check the script header for container-specific notes for Docker or LXC.

### macOS setup

No additional setup is required for core functionality.

For screen recording support, install `ffmpeg` via the setup script:

```bash
./setup.sh
```

CUSE is not available on macOS, so serial control signals like DTR/RTS are not supported. When flashing boards such as ESP32, use the **BOOT** button manually.

## Architecture

Atoo Studio runs as a single local backend process on the same machine or server as your coding agents.

```text
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
    └── MCP server
```

Agents run inside real terminal sessions. Atoo Studio does not replace the agent — it provides the environment where agents operate.

## MCP integration

Atoo Studio exposes MCP tools that let agents talk back to the workspace UI.

| Tool | Description |
|------|-------------|
| `generate_certificate` | Request a trusted HTTPS certificate for any hostname |
| `report_tcp_services` | Report started services so they appear in the preview panel |
| `request_serial_device` | Request USB serial device access via the Web Serial bridge |
| `search_session_history` | Search across all session history or within the current session chain |
| `suggest_continue_in_other_session` | Suggest switching to an existing session with relevant context |
| `open_file` | Open a file in the browser editor with user approval |
| `get_session_metadata` | Read session name, description, and tags |
| `set_session_metadata` | Set session name, description, and tags |
| `github_issue_pr_changed` | Notify the UI when a GitHub issue or PR changes |
| `connect_database` | Open the database explorer with a specific connection |
| `track_project_changes` | Track what has been done in a project (get/set/delete) |

## Commercial support

Need help building agent tooling, multi-agent workflows, local-first developer environments, or custom integrations around Claude Code and Codex?

Commercial support and consulting are available via [IT Trail GmbH](https://www.ittrail.at).

## Status

Atoo Studio is in **early alpha**. It is used for real day-to-day development across multiple projects and worktrees, but APIs, configuration, and UI may change without notice.

Bug reports and feedback are welcome.

## Roadmap

- [ ] Add Gemini CLI as a third supported agent
- [ ] Standalone Electron app with real browser sessions for preview (in addition to headless CDP streaming)
- [ ] Refine mobile layout and bring all recently added features to the mobile view
- [ ] Self-hosted Git platform support: Gitea, GitLab, and Azure DevOps Server
- [ ] Evaluate cloud platforms for native management (containers, databases, infrastructure)
- [ ] Experiment with alternative workspace layouts
- [ ] Optional per-project development containers
- [ ] Replace xterm.js with atoo-term (currently in development)

## Feedback

Atoo Studio is not accepting code contributions at this stage. The architecture is evolving quickly and external PRs would likely conflict with ongoing changes.

Bug reports, feature ideas, and workflow pain points are very welcome — please open an issue.

## License

[MIT](LICENSE)

## Author

Built by [Markus Furtlehner](https://github.com/markusfurtlehner) — founder of [IT Trail GmbH](https://www.ittrail.at).

Built from real pain, not a pitch deck.

> [atoo.ai](https://atoo.ai)