---
sidebar_position: 6
---

# Container Management

Manage Docker, Podman, and LXC/LXD containers directly from the Atoo Studio workspace.

## Supported Runtimes

| Runtime | Features |
|---------|----------|
| **Docker** | Full management, compose projects |
| **Podman** | Full management, compose projects |
| **LXC/LXD** | Container listing, start/stop |

Features are disabled gracefully if a runtime is not installed or accessible.

## Container Operations

- **List** all containers with status indicators
- **Inspect** container details (ports, volumes, environment)
- **Start / Stop / Restart** containers
- **Delete** containers
- **View logs** in real-time
- **Monitor stats** (CPU, memory, network)
- **Shell access** — open an interactive terminal inside any running container

## Images & Volumes

- Browse available images
- View volume details
- Inspect network configuration

## Docker Compose

Browse docker-compose projects and manage their services as a group. Compose projects are auto-detected from `docker-compose.yml` files in your project directories.
