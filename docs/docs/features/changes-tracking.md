---
sidebar_position: 3
---

# Changes Tracking

When you run multiple agents in parallel — each fixing bugs, adding features, or doing chores — it is easy to lose track of what was actually done. By the time all agents finish, you may not remember what to review or test.

Changes Tracking solves this. Each agent logs a high-level summary of what it accomplished, so you always have a single place to see everything that happened across all sessions.

## How It Works

The `track_project_changes` MCP tool is available to all agents. Agents are instructed to:

1. Call `get` at the start to see what other sessions have already logged
2. Call `set` after completing a meaningful task to log what was done and what you should review or test

Entries are written from your perspective — not file-level noise, but actionable summaries like:

- "Fixed login redirect loop — test login with expired session tokens"
- "Added dark mode toggle to settings page — review UI in both themes"
- "Refactored API error handling — check that error toasts still appear correctly"

Each entry is automatically linked to the session that created it and timestamped by the backend.

## Viewing Changes

The **Changes** tab in the right panel shows all tracked entries for the current project, ordered by most recent first. Each card displays:

- **Description** — what was done and what to review
- **Approximate files affected**
- **Timestamp** (relative, e.g. "5m ago")

## Managing Entries

- **Delete individual entries** using the delete button on each card
- **Clear all entries** using the "Clear All" button in the toolbar

Entries persist across sessions and are stored in the database. Deleting a project also removes all its entries.

## MCP Tool Reference

### track_project_changes

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `get` \| `set` \| `delete` | Yes | Operation mode |
| `id` | string | For `delete`, optional for `set` | Entry ID. Omit on `set` to create new. |
| `description` | string | For `set` | What was done and what to review/test |
| `approx_files_affected` | number | For `set` | Approximate number of files affected |

The `session_id` and `created_at` fields are filled automatically by the backend.

## Real-Time Updates

When an agent logs a change, the UI updates in real time via WebSocket. Multiple browser windows stay in sync without polling.
