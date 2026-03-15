---
sidebar_position: 1
slug: /intro
---

# Getting Started

Atoo Studio is an agentic development environment that provides a web-based UI for managing AI coding agents, terminal sessions, and development workflows.

## Installation

### npm

```bash
npx atoo-studio
```

Or install globally:

```bash
npm install -g atoo-studio
atoo-studio
```

### Docker

```bash
docker run -d \
  --name atoo-studio \
  -p 3010:3010 \
  ghcr.io/atooai/atoo-studio:latest
```

### LXC / LXD

Pre-built LXC images are available from [GitHub Releases](https://github.com/atooai/atoo-studio/releases).

### Proxmox

See the [Proxmox installation scripts](https://github.com/atooai/atoo-studio/tree/master/proxmox) for VM and LXC setup.

## Prerequisites

- **Node.js** >= 18
- **git** and **gh** (GitHub CLI)
- At least one AI coding agent: `claude`, `codex`, etc.
- **Docker**, **Podman**, or **LXC** (for container-based workflows)
