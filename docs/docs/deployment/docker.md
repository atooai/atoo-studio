---
sidebar_position: 2
---

# Docker

Run Atoo Studio as a Docker container with all dependencies pre-installed.

## Quick Start

```bash
docker run -d \
  --name atoo-studio \
  -p 3010:3010 \
  -p 8081:8081 \
  ghcr.io/atooai/atoo-studio:latest
```

## Multi-Platform

The Docker image supports both `linux/amd64` and `linux/arm64` architectures.

## Ports

| Port | Purpose |
|------|---------|
| 3010 | HTTPS web server |
| 8081 | Additional service port |

## Tags

| Tag | Description |
|-----|-------------|
| `latest` | Most recent release |
| `x.y.z` | Specific version |
| `x.y` | Latest patch of major.minor |

## Persistent Data

Mount a volume for persistent project data and configuration:

```bash
docker run -d \
  --name atoo-studio \
  -p 3010:3010 \
  -v atoo-data:/home/atoo \
  ghcr.io/atooai/atoo-studio:latest
```

The container runs as a non-root `atoo` user.
