---
sidebar_position: 1
---

# Agents

Atoo Studio integrates AI coding agents into a unified workspace. Agents run in real PTY (pseudo-terminal) sessions with full terminal capabilities — Atoo Studio doesn't replace agents, it provides the environment where they operate.

## Supported Agents

| Agent | Description |
|-------|-------------|
| **Claude Code** | Anthropic's CLI agent for coding tasks |
| **Codex CLI** | OpenAI's terminal-based coding agent |

More agents can be added through the adapter system.

## Starting an Agent

1. Select a project in the sidebar
2. Click the **+** button to create a new session
3. Choose which agent to use
4. Type your prompt and the agent starts working in its own terminal

Each agent session runs in an isolated PTY with the project directory as its working directory.

## Session Forking

Fork a conversation at any point to explore alternative solutions without losing the original context:

- Fork from a specific message to branch the conversation
- Select a message range to fork a subset of the conversation
- Forked sessions appear as a parent-child tree in the sidebar

This is useful when you want to try a different approach while keeping the original conversation intact.

## Session Chaining

Chain sessions across different agents:

- Start a session with Claude Code, then continue it with Codex (or vice versa)
- Full conversation history is preserved across agent boundaries
- The new agent picks up exactly where the previous one left off

Chain relationships are tracked via UUIDs, forming a linked history from oldest ancestor through each chain link.

## Session Metadata

Agents (or users) can tag sessions with metadata for organization:

- **Name** — displayed as the tab title for quick identification
- **Description** — detailed notes about what the session is working on
- **Tags** — short badges displayed in the sidebar for categorization

## Session History Search

All session conversations are stored and searchable:

- **Full project search** — search across all sessions in the project
- **Current chain search** — search only previous sessions in the current chain
- Regex pattern support with text fallback
- Fetch full messages by range for context around matches

Agents use this to recall past decisions, failed approaches, and implementation reasoning from previous sessions.

## Parallel Sessions

Run multiple agents in parallel across different projects or branches. Each agent operates independently in its own terminal, and you can switch between them using the sidebar.
