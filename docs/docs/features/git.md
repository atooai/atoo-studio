---
sidebar_position: 4
---

# Git Integration

Atoo Studio provides a full Git workflow built into the workspace, supporting both local and remote (SSH) repositories.

## Branch Overview

- View all local and remote branches
- See commit history with visualization
- Switch branches directly from the UI

## Working with Changes

- Stage and unstage files
- View diffs (source, binary, and hex views)
- Commit with messages
- Push to remote

## Publish

The **Publish** button combines multiple steps into one action:

1. Commits staged changes
2. Pushes to the remote
3. Creates a pull request

## Worktrees

Work on multiple branches simultaneously using Git worktrees. Each worktree appears as a separate project in the sidebar, sharing the same repository but operating on different branches independently.

Atoo Studio automatically reconciles worktrees — when you create or remove worktrees, the sidebar updates accordingly.

## Stash Management

- Create stashes
- Browse stash contents
- Apply or drop stashes

## Remote Repositories

For projects accessed via SSH, Git operations are executed on the remote machine. All Git features work the same way, provided `git` is available on the remote host.
