---
sidebar_position: 3
---

# GitHub Integration

Atoo Studio integrates with GitHub via the `gh` CLI, providing issue and pull request management directly in the workspace.

## Prerequisites

The [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated:

```bash
gh auth login
```

## Issues

- Browse open and closed issues
- View issue details and comments
- Create new issues
- Close and reopen issues
- Link agent sessions to specific issues for context

## Pull Requests

- Browse open, closed, and merged pull requests
- View PR details, diffs, and comments
- Create new pull requests directly from the UI
- Close and reopen pull requests

## Agent Integration

Agents can interact with GitHub through the `gh` CLI in their terminal sessions. When an agent modifies an issue or PR (comments, edits, changes state), it calls the `github_issue_pr_changed` MCP tool to keep the UI in sync.
