---
sidebar_position: 9
---

# SSH & Remote Projects

Connect to remote machines via SSH and manage projects as if they were local.

## Connecting

Add an SSH connection with:

- **Hostname** and **port**
- **Authentication**: password, private key, or system SSH key
- Connections are saved and auto-reconnect on startup

## Remote Projects

Once connected, add projects from the remote machine's filesystem. Remote projects support:

- **File browsing** via SFTP
- **File editing** with the built-in editor
- **Git operations** (if `git` is available on the remote)
- **Terminal shells** executing on the remote machine
- **Agent sessions** running remotely

## Port Forwarding

### Forward Tunnels

Access services running on the remote machine through Atoo Studio. Remote ports are mapped to local endpoints and accessible via the reverse proxy.

### Reverse Tunnels

Expose Atoo Studio's services to the remote machine. This enables agents running remotely to communicate back with Atoo Studio's MCP server.

## Proxy Routing

Remote services are accessible through the reverse proxy:

- **Subdomain**: `{port}.remote.{connId}.on.{domain}`
- **Path**: `/at/remote/{connId}/port/{port}/[path]`
