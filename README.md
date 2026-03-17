<p align="center">
  <img src="https://atoo.ai/img/logo_64x64.png" alt="Atoo Studio" width="64" height="64">
</p>

<h1 align="center">Atoo Studio</h1>

<p align="center">
  <strong>Local-first workspace for Claude Code, Codex CLI, and other coding agents.</strong><br>
  Run multiple agents across projects and worktrees, fork and chain sessions, preview apps with real Chrome + DevTools, and manage Git, GitHub, databases, containers, and hardware from one browser UI.
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

> **30-second demo coming soon**
>
> A short walkthrough showing:
> - two agent sessions running in parallel
> - forking a session
> - continuing the same task in another agent
> - live app preview with integrated DevTools
> - switching to Git / database / hardware panels

<!--
Replace this block with a linked thumbnail when the demo is ready.

Example:

<p align="center">
  <a href="https://your-video-url">
    <img src="docs/demo-thumbnail.png" alt="Atoo Studio 30-second demo" width="900">
  </a>
</p>
-->

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

### Docker

```bash
docker run -p 3010:3010 ghcr.io/atooai/atoo-studio
```

To persist data across container restarts:

```bash
docker run -p 3010:3010 -v atoo-data:/home/atoo/.atoo-studio ghcr.io/atooai/atoo-studio
```

### LXC / LXD

Download the LXC image from the [latest release](https://github.com/atooai/atoo-studio/releases) and import it:

```bash
lxc image import atoo-studio-lxc-amd64.tar.gz --alias atoo-studio
lxc launch atoo-studio my-atoo-studio
```

### Proxmox

Run one of the setup scripts on your Proxmox host:

**LXC container** — lightweight, 2 CPU / 2 GB RAM / 20 GB disk

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/master/proxmox/lxc.sh)"
```

**VM** — stronger isolation, CUSE/serial support, 4 CPU / 4 GB RAM / 50 GB disk

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/master/proxmox/vm.sh)"
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

Atoo Studio is used for real day-to-day development across multiple projects and worktrees. It is moving fast and still has rough edges.

Bug reports, feedback, and focused contributions are welcome.

## Roadmap

- [ ] More agent adapters (Gemini CLI and others)
- [ ] Service topology visualization
- [ ] Session migration between environments
- [ ] Configurable trust levels per tool

## Contributing

Contributions are welcome. For bugs, feature ideas, or workflow pain points, open an issue first so the direction stays coherent.

## License

[MIT](LICENSE)

## Author

Built by [Markus Furtlehner](https://github.com/markusfurtlehner) — founder of [IT Trail GmbH](https://www.ittrail.at).

Built from real pain, not a pitch deck.

> [atoo.ai](https://atoo.ai)