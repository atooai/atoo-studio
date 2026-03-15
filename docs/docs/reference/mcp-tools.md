---
sidebar_position: 2
---

# MCP Tools

Atoo Studio exposes tools via the [Model Context Protocol](https://modelcontextprotocol.io/) that agents can call during their sessions. These tools enable agents to interact with the Atoo Studio workspace.

## Available Tools

### report_tcp_services

Report services that the agent has started. Reported services appear in the preview panel and forwarded connections list.

**Parameters:**
- `services` — Array of service objects:
  - `name` — Short service name (e.g., "vite-dev-server")
  - `description` — What the service does
  - `port` — TCP port number
  - `protocol` — `http`, `https`, `ws`, `wss`, `tcp`, `grpc`, or `other`
  - `host` (optional) — Custom hostname for the Host header

### generate_certificate

Generate a TLS certificate signed by Atoo Studio's CA. The preview browser trusts this CA, so generated certificates work without security warnings.

**Parameters:**
- `outputDir` — Directory to write certificate files
- `hostnames` — Array of hostnames for the certificate SAN

**Output files:** `cert.pem`, `key.pem`, `ca.pem`

### request_serial_device

Request access to a USB serial device. The user is prompted in their browser to connect the device via Web Serial API.

**Returns:** Virtual serial port path (e.g., `/dev/pts/XX`)

### search_session_history

Search or fetch messages from session history.

**Search mode** (provide `query`):
- `query` — String or array of strings (regex supported)
- `type` — `FullProjectSearch` (all sessions) or `CurrentSessionChain` (chain only)
- `sort` — `newest_first` or `oldest_first`
- `max_results_per_query` — Limit results (default: 50)

**Range mode** (provide `session` + `from` + `to`):
- `target_session_uuid` — UUID of session to fetch from
- `from` / `to` — Message range (inclusive, 1-indexed)

### get_session_metadata

Get the current session's metadata (name, description, tags).

### set_session_metadata

Set metadata on the current session.

**Parameters:**
- `name` — Session name (displayed as tab title)
- `description` — Markdown description
- `tags` — Array of short tags (displayed as badges)

### suggest_continue_in_other_session

Suggest that the user switches to a different existing session. Blocks until the user accepts or rejects.

**Parameters:**
- `sessionUuid` — UUID of the session to suggest
- `prompt` — Refined prompt for continuing in that session

### open_file

Open a file in the browser's editor panel.

**Parameters:**
- `filePath` — Path to the file to open

### github_issue_pr_changed

Notify the UI that a GitHub issue or PR was modified.

**Parameters:**
- `repository` — Repository in `owner/repo` format
- `type` — `issue` or `pr`
- `number` — Issue or PR number

### connect_database

Open the database explorer with a specific connection.

### track_project_changes

Track what has been done in a project. Agents use this to maintain a human-readable changelog of work performed. Each entry is scoped to a project and includes the session that created it.

**Parameters:**
- `mode` — `get`, `set`, or `delete`
- `id` (optional) — ID of an existing entry to update or delete. Omit to create a new entry.
- `description` — What was done (required for `set`)
- `approx_files_affected` — Approximate number of files affected (required for `set`)

The backend automatically fills `session_id` and `created_at`. Entries are visible in the **Changes** tab in the right panel.

## Security

All MCP endpoints are restricted to localhost connections only. When authentication is enabled, agents must provide a valid session token in the `Authorization` header.
