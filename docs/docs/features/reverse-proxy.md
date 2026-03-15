---
sidebar_position: 12
---

# Reverse Proxy

Atoo Studio includes a built-in reverse proxy that routes traffic to services running on the host or remote machines.

## Routing Modes

### Subdomain-Based

```
{port}.port.on.{domain} → localhost:{port}
```

Access any local service by prefixing the port number as a subdomain.

### Path-Based

```
/at/port/{port}/[path] → localhost:{port}/[path]
```

Access services via URL path when subdomains are not available.

### Remote Services (SSH)

```
{port}.remote.{connId}.on.{domain}
/at/remote/{connId}/port/{port}/[path]
```

Access services running on SSH-connected remote machines.

## Service Registry

Agents report their services via the `report_tcp_services` MCP tool. Reported services appear in the **Forwarded Connections** panel with direct links for quick access.

## Host Header Injection

Set a custom `Host` header for any proxied connection. This is useful for testing applications that use virtual hosting or domain-specific logic.

## HTTPS

All proxied connections go through Atoo Studio's HTTPS server. The built-in certificate authority generates trusted certificates, so preview browsers and agents can access services without TLS warnings.
