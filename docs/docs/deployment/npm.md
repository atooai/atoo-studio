---
sidebar_position: 1
---

# npm

The simplest way to run Atoo Studio.

## Quick Start

```bash
npx atoo-studio
```

## Global Install

```bash
npm install -g atoo-studio
atoo-studio
```

## Prerequisites

- **Node.js** >= 18
- **git**

### Optional Dependencies

| Dependency | Purpose |
|-----------|---------|
| `claude` | Claude Code agent support |
| `codex` | Codex CLI agent support |
| `gh` | GitHub integration |
| `docker` / `podman` | Container management |
| `lxc` / `lxd` | LXC container management |
| `ffmpeg` | Screen recording |

### Linux Setup

On Linux, run the setup script to install Chrome/Puppeteer dependencies:

```bash
npx atoo-studio --setup
# or after global install:
atoo-studio --setup
```

This installs required system libraries for headless Chrome (used for app preview).

## Configuration

Atoo Studio starts an HTTPS server on port **3010** by default. The server generates a self-signed CA certificate on first run.

Access the workspace at: `https://localhost:3010`

To use a different port, set the `ATOO_PORT` environment variable:

```bash
ATOO_PORT=4000 npx atoo-studio
```
