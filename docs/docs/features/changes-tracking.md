---
sidebar_position: 3
---

# Changes Tracking

Atoo Studio tracks what has been done across your project with a project-scoped changelog. Every time an agent creates, modifies, or deletes files, it logs a change entry describing what was accomplished, how many files were affected, and when.

## How It Works

The `track_project_changes` MCP tool is available to all agents. When an agent performs work, it:

1. Calls `get` to see existing change entries
2. Calls `set` to log what it did — with a description and approximate file count

Each entry is automatically linked to the session that created it and timestamped by the backend.

## Viewing Changes

The **Changes** tab in the right panel shows all tracked changes for the current project, ordered by most recent first. Each card displays:

- **Description** of what was done
- **Approximate files affected**
- **Timestamp** (relative, e.g. "5m ago")

## Managing Entries

- **Delete individual entries** using the delete button on each card
- **Clear all entries** using the "Clear All" button in the toolbar

Changes are stored in the database and persist across sessions. Deleting a project also removes all its change entries.

## MCP Tool Reference

### track_project_changes

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `get` \| `set` \| `delete` | Yes | Operation mode |
| `id` | string | For `delete`, optional for `set` | Entry ID. Omit on `set` to create new. |
| `description` | string | For `set` | What was done |
| `approx_files_affected` | number | For `set` | Approximate number of files affected |

The `session_id` and `created_at` fields are filled automatically by the backend.

## Real-Time Updates

When an agent logs a change, the UI updates in real time via WebSocket. Multiple browser windows stay in sync without polling.
