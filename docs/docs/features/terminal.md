---
sidebar_position: 8
---

# Terminal

Atoo Studio provides full terminal sessions running directly on the server via real PTY (pseudo-terminal) instances.

## Features

- Multiple terminal tabs running in parallel
- Full terminal capabilities (colors, cursor movement, interactive programs)
- Scrollback buffer preserved across browser reconnections
- Broadcast to multiple connected browsers simultaneously

## Local Terminals

Open standalone shell terminals that are independent of agent sessions. These run in the project directory and support any shell command.

## Remote Terminals

For projects connected via SSH, terminals execute on the remote machine. The experience is identical to local terminals — the SSH transport is handled transparently.

## Agent Terminals

Each agent session runs in its own dedicated terminal. You can view the raw terminal output alongside the chat interface to see exactly what the agent is doing.
