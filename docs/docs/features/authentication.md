---
sidebar_position: 11
---

# Authentication

Atoo Studio includes an optional authentication layer to secure access to the workspace. Authentication is disabled by default.

## Authentication Methods

Three authentication factors are supported, and can be combined:

### Password

Basic username and password authentication.

### TOTP

Time-based one-time passwords compatible with any authenticator app (Google Authenticator, Authy, 1Password, etc.).

### WebAuthn / Passkeys

Hardware security keys (YubiKey, etc.) or platform biometrics (Touch ID, Windows Hello). This is the most secure option.

## Multi-User Support

- Create multiple user accounts with different roles
- **Admin** — full access, can manage users and environments
- **User** — access to assigned environments only

## Agent Authentication

When authentication is enabled, agents must provide a valid token in the `Authorization` header when calling MCP endpoints. Tokens are scoped to agent sessions and validated on every request.

## MCP Security

MCP endpoints are restricted to localhost connections only, regardless of whether authentication is enabled. This prevents external access to agent control tools.
