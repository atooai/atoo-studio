---
sidebar_position: 3
---

# Changes Tracking

When you run multiple agents in parallel — each fixing bugs, adding features, or doing chores — it is easy to lose track of what was actually done. By the time all agents finish, you may not remember what to review or test.

Changes Tracking solves this. Each agent logs a scannable summary of what it accomplished, so you always have a single place to see everything that happened across all sessions.

## How It Works

The `track_project_changes` MCP tool is available to all agents. Agents are instructed to:

1. Call `get` at the start to see what other sessions have already logged
2. Call `set` after completing a meaningful task to log what was done

Each entry has a structured format designed for quick scanning:

- **Short description** (max 10 words) — the headline, always visible
- **Long description** (max 50 words) — details on what to review/test, shown when expanded
- **Tags** (max 10, each max 3 words) — categorization badges
- **Approx files affected** — scope indicator

If work needs more than 50 words to describe, agents split it into multiple entries.

## Viewing Changes

The **Changes** tab in the right panel shows all tracked entries for the current project, ordered by most recent first.

Cards are **collapsed by default** showing only the short description, tags, file count, and timestamp. Click a card to expand it and see the long description with review/test instructions.

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
| `short_description` | string | For `set` | Headline, max 10 words |
| `long_description` | string | No | What to review/test, max 50 words |
| `tags` | string[] | No | Short labels (max 3 words each, max 10) |
| `approx_files_affected` | number | For `set` | Approximate number of files affected |

The `session_id` and `created_at` fields are filled automatically by the backend.

## Real-Time Updates

When an agent logs a change, the UI updates in real time via WebSocket. Multiple browser windows stay in sync without polling.
