# Atoo-Any Session Schema

> **Status:** Draft / Design Phase
> **Date:** 2026-03-30

This document defines the normalized data model for atoo-any sessions. It replaces the previous flat JSONL approach with a tree-based structure that cleanly separates conversation structure from event data.

## File Structure

Each session is a directory:

```
.atoo-studio/atoo-any-sessions/
  {sessionUuid}/
    session.json              # Structure + metadata (atomic rewrite, small)
    prompts/
      {uuid}.jsonl            # Append-only event stream per user prompt
      {uuid}.jsonl
    blobs/
      {contenthash}.png       # Deduplicated attachments by content hash
      {contenthash}.pdf
```

- **`session.json`** is the only file that gets rewritten. It contains the tree structure, metadata, fork/branch info, and client state. It stays small (typically < 50 KB).
- **`prompts/{uuid}.jsonl`** files are append-only. Each file contains the user prompt and all agent run events for that prompt. They are never rewritten.
- **`blobs/`** stores binary attachments (images, PDFs, etc.) deduplicated by content hash. Referenced by UUID from prompts and agent runs.

### Write Safety

- **`session.json`**: Atomic write via write-to-temp-then-rename (`fsync` + `rename`). Crash-safe.
- **Prompt JSONL files**: Append-only (`appendFileSync`). Worst case on crash: lose the last partial line. All previous lines remain intact.
- **Concurrency**: Single in-process write queue (promise chain). The adapter is the sole writer.

---

## session.json

The session file contains all structural and metadata information.

### Top-Level Structure

```typescript
interface Session {
  version: number;                          // Schema version (currently 1)
  uuid: string;                             // Session UUID
  directory: string;                        // Working directory (cwd)
  createdAt: string;                        // ISO timestamp
  updatedAt: string;                        // ISO timestamp

  metadata: SessionMetadata;                // Session-level metadata
  prompts: Record<string, Prompt>;          // UUID -> prompt index (flat)
  tree: TreeNode[];                         // Conversation forest (multiple roots)
  fileChanges: Record<string, FileChanges>; // Prompt UUID -> file change tracking
  clientState: Record<string, ClientState>; // Client ID -> view state
}
```

### Session Metadata

Set by LLMs via MCP tools or by the user through the UI.

```typescript
interface SessionMetadata {
  title: string;                            // Auto-derived from first user message
  name?: string;                            // Display name (shown as tab title)
  description?: string;                     // Markdown description
  tags: string[];                           // Shown as badges in the UI
}
```

### Prompt Index

A flat lookup of all prompts in the session. Every prompt that appears anywhere in the tree has an entry here. The tree references prompts by UUID; this index holds the data.

```typescript
interface Prompt {
  uuid: string;
  startedAt: string;                        // ISO timestamp
  endedAt?: string;                         // ISO timestamp, set when all agent runs complete
  title?: string;                           // LLM-defined via MCP
  tags?: string[];                          // LLM-defined via MCP
  description?: string;                     // LLM-defined via MCP
  agents: AgentRun[];                       // Agent runs triggered by this prompt
  attachments?: Attachment[];               // User-provided attachments (images, PDFs, etc.)
  compaction?: {
    replaces: string[];                     // Prompt UUIDs that were compacted into this one
  };
  git?: {
    branch?: string;                        // Git branch at time of prompt
    commit?: string;                        // Git commit hash at time of prompt
    worktree?: string;                      // Git worktree path if applicable
  };
}
```

**Notes:**
- If `compaction` is present, this is a synthetic prompt (not typed by a human). The user message is a compaction marker, and the agent response is the LLM-generated summary.
- `compaction.replaces` can reference other compaction prompt UUIDs, enabling nested compaction (compacting previously compacted prompts).
- A prompt's `agents` array is immutable once all runs for that prompt have started. Tree nodes reference agent runs by their index in this array.
- `title`, `tags`, and `description` are set by the LLMs through MCP calls, not by the user. This allows agents to self-document their work.

### Agent Run

Each agent run represents one dispatch to a specific harness + model combination.

```typescript
interface AgentRun {
  uuid: string;                             // Unique run identifier
  startedAt: string;                        // ISO timestamp
  endedAt?: string;                         // ISO timestamp
  harness: string;                          // 'claude-code' | 'gemini-cli' | 'open-code' | ...
  model: string;                            // 'opus' | 'sonnet-4' | 'gemini-3.0' | ...
  effort?: string;                          // Harness-specific reasoning effort (free-form)
  attachments?: Attachment[];               // Agent-provided attachments (generated images, etc.)
  tokens?: {
    input: number;                          // Input tokens consumed
    inputCached: number;                    // Input tokens served from cache
    output: number;                         // Output tokens generated
    costCents: number;                      // Pre-calculated cost in cents
  };
}
```

**Notes:**
- `effort` is free-form, not an enum. Different harnesses have different effort levels (e.g., Claude's "high/medium/low", others may use different labels).
- Duration is derived from `endedAt - startedAt`, not stored separately.
- `costCents` is pre-calculated at write time so the UI doesn't need pricing tables.
- `attachments` on agent runs are for output attachments (e.g., image generation models producing images).

### Attachment

```typescript
interface Attachment {
  uuid: string;                             // Used as filename in blobs/ directory
  filename: string;                         // Original filename
  mime: string;                             // MIME type (e.g., 'image/png', 'application/pdf')
}
```

The binary data is stored in `blobs/{uuid}` (no extension, the MIME type is in the metadata). Deduplicated by content hash — if two attachments have the same content, they share the same blob file.

### Conversation Tree

The tree is a recursive structure representing the conversation as a forest (multiple roots). Each node is a user prompt. Branching happens when a node has multiple children.

```typescript
interface TreeNode {
  uuid: string;                             // References prompts[uuid]
  agents?: number[];                        // Indices into the prompt's agents array
  hidden?: boolean;                         // Excluded from context on this path
  children?: TreeNode[];                    // Continuations (>1 child = fork point)
}
```

**Notes:**
- `agents` specifies which agent runs from the prompt are active on this tree path. After a fork, a user might re-dispatch with only a subset of agents. If omitted, all agents are active.
- `hidden` means the prompt exists on this path but is excluded from the conversation context sent to agents. The prompt data is unchanged.
- A node with multiple `children` is a fork point. Each child is the start of a different branch.
- The same prompt UUID can appear in multiple places in the tree (original path, compacted branch, extracted root) but always references the same `prompts/{uuid}.jsonl` file.

### File Changes (3-Layer Detection)

Tracks which files were modified during each prompt, using three independent detection layers for redundancy:

```typescript
interface FileChanges {
  gitDiff?: string[];                       // Layer 1: detected via git diff
  fsWatcher?: string[];                     // Layer 2: detected via inotify/fs.watch
  byAgentLDPreload?: Record<number, string[]>; // Layer 3: agent index -> files (LD_PRELOAD syscall interception)
}
```

**Detection layers:**
1. **`gitDiff`**: Files detected via `git diff` — most reliable for committed changes.
2. **`fsWatcher`**: Files detected via kernel-level file watching (inotify). Catches changes in real-time but may include non-agent modifications.
3. **`byAgentLDPreload`**: Files detected via `LD_PRELOAD` syscall interception, attributed to a specific agent run by index. Most precise — knows exactly which agent modified which file.

In some cases, file changes can only be attributed to the prompt level (layers 1-2). In others, they can be pinpointed to a specific agent run (layer 3).

### Client State

Each connected browser tab gets a client session. Tracks view state per client, enabling multiple users/windows to navigate the same session independently.

```typescript
interface ClientState {
  lastSeen: string;                         // ISO timestamp
  activePath: number[];                     // Child indices at each fork level
}
```

**Notes:**
- `activePath` is an array of child indices. At each fork point in the tree, the index tells which child branch to follow. Example: `[0, 1, 2]` means "first child at root fork, second child at next fork, third child at the next."
- New clients default to the most recent branch, found by reverse-searching the tree by the youngest prompt's `startedAt`.
- Branch switching is an update to `activePath` in `session.json`. No append-only bloat.

---

## prompts/{uuid}.jsonl

Each prompt has its own append-only JSONL file containing the user message and all agent run events.

### Event Types

```typescript
type PromptEvent =
  | PromptMessage
  | RunStart
  | RunMessage
  | RunEnd;

interface PromptMessage {
  type: 'prompt';
  message: string;                          // User's message text
  timestamp: string;                        // ISO timestamp
  blobs?: string[];                         // Attachment UUIDs (files in blobs/ directory)
}

interface RunStart {
  type: 'run_start';
  runId: string;                            // Matches AgentRun.uuid in session.json
}

interface RunMessage {
  type: 'run_msg';
  runId: string;
  role: 'assistant' | 'tool_result';
  content: ContentBlock;                    // Text, thinking, tool_use, tool_result, etc.
}

interface RunEnd {
  type: 'run_end';
  runId: string;
}
```

### Content Blocks

Content blocks follow the same structure as the existing `SessionEvent` content types:

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolResultContentBlock[]; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };
```

### Example Prompt File

```jsonl
{"type":"prompt","message":"fix the login redirect loop when tokens expire","timestamp":"2026-03-30T10:05:00Z","blobs":["a1b2c3d4"]}
{"type":"run_start","runId":"run-claude-1"}
{"type":"run_msg","runId":"run-claude-1","role":"assistant","content":{"type":"thinking","thinking":"Let me look at the auth middleware to understand the redirect flow..."}}
{"type":"run_msg","runId":"run-claude-1","role":"assistant","content":{"type":"text","text":"I can see the issue. The redirect loop happens because..."}}
{"type":"run_msg","runId":"run-claude-1","role":"assistant","content":{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/src/auth/middleware.ts"}}}
{"type":"run_msg","runId":"run-claude-1","role":"tool_result","content":{"type":"tool_result","tool_use_id":"tu1","content":"export function authMiddleware..."}}
{"type":"run_msg","runId":"run-claude-1","role":"assistant","content":{"type":"tool_use","id":"tu2","name":"Edit","input":{"file_path":"/src/auth/middleware.ts","old_string":"if (!token)","new_string":"if (!token || isExpired(token))"}}}
{"type":"run_msg","runId":"run-claude-1","role":"tool_result","content":{"type":"tool_result","tool_use_id":"tu2","content":"File edited successfully"}}
{"type":"run_msg","runId":"run-claude-1","role":"assistant","content":{"type":"text","text":"I've fixed the redirect loop by adding an expiry check..."}}
{"type":"run_end","runId":"run-claude-1"}
{"type":"run_start","runId":"run-gemini-1"}
{"type":"run_msg","runId":"run-gemini-1","role":"assistant","content":{"type":"text","text":"The redirect loop is caused by the missing token expiry validation..."}}
{"type":"run_msg","runId":"run-gemini-1","role":"assistant","content":{"type":"tool_use","id":"tu3","name":"Edit","input":{"file_path":"/src/auth/middleware.ts","old_string":"if (!token)","new_string":"if (!token || tokenExpired(token))"}}}
{"type":"run_msg","runId":"run-gemini-1","role":"tool_result","content":{"type":"tool_result","tool_use_id":"tu3","content":"File edited successfully"}}
{"type":"run_end","runId":"run-gemini-1"}
```

---

## Comprehensive Example: session.json

This example shows a session with:
- 6 user prompts on the main path
- A compaction of prompts p2+p3 into a synthetic prompt c1
- A fork at p4 with two alternative branches (Redis vs JWT approach)
- A nested fork within the JWT branch
- A hiding operation within the compacted branch
- An extracted root for exploring a subtopic independently
- File change tracking with 3-layer detection
- Two connected clients on different branches

```json
{
  "version": 1,
  "uuid": "d6eacc5d-179c-4dfd-930f-ebb653d873c4",
  "directory": "/workspaces/myproject",
  "createdAt": "2026-03-30T10:00:00Z",
  "updatedAt": "2026-03-30T12:30:00Z",

  "metadata": {
    "title": "Fix login bug",
    "name": "Login redirect debugging",
    "description": "Investigating the redirect loop that occurs when users have expired authentication tokens. Comparing Redis session store vs JWT-based approaches.",
    "tags": ["auth", "bugfix", "redirect-loop"]
  },

  "prompts": {
    "p1": {
      "uuid": "p1",
      "startedAt": "2026-03-30T10:00:00Z",
      "endedAt": "2026-03-30T10:02:30Z",
      "title": "Initial investigation of login redirect",
      "agents": [
        {
          "uuid": "run-claude-1",
          "startedAt": "2026-03-30T10:00:05Z",
          "endedAt": "2026-03-30T10:01:20Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 12000, "inputCached": 8000, "output": 3500, "costCents": 42 }
        },
        {
          "uuid": "run-gemini-1",
          "startedAt": "2026-03-30T10:00:05Z",
          "endedAt": "2026-03-30T10:02:30Z",
          "harness": "gemini-cli",
          "model": "gemini-2.5-pro",
          "effort": "medium",
          "tokens": { "input": 11000, "inputCached": 0, "output": 2800, "costCents": 18 }
        }
      ],
      "attachments": [
        { "uuid": "blob-screenshot-1", "filename": "error-screenshot.png", "mime": "image/png" }
      ],
      "git": {
        "branch": "fix/login-redirect",
        "commit": "abc1234"
      }
    },
    "p2": {
      "uuid": "p2",
      "startedAt": "2026-03-30T10:03:00Z",
      "endedAt": "2026-03-30T10:05:00Z",
      "title": "Set up auth middleware",
      "agents": [
        {
          "uuid": "run-claude-2",
          "startedAt": "2026-03-30T10:03:05Z",
          "endedAt": "2026-03-30T10:05:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 15000, "inputCached": 12000, "output": 4200, "costCents": 38 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect",
        "commit": "abc1234"
      }
    },
    "p3": {
      "uuid": "p3",
      "startedAt": "2026-03-30T10:06:00Z",
      "endedAt": "2026-03-30T10:08:00Z",
      "title": "Add token validation logic",
      "agents": [
        {
          "uuid": "run-claude-3",
          "startedAt": "2026-03-30T10:06:05Z",
          "endedAt": "2026-03-30T10:08:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 18000, "inputCached": 15000, "output": 5100, "costCents": 45 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect",
        "commit": "def5678"
      }
    },
    "p4": {
      "uuid": "p4",
      "startedAt": "2026-03-30T10:10:00Z",
      "endedAt": "2026-03-30T10:15:00Z",
      "title": "Explore session storage options",
      "tags": ["architecture", "decision"],
      "agents": [
        {
          "uuid": "run-claude-4",
          "startedAt": "2026-03-30T10:10:05Z",
          "endedAt": "2026-03-30T10:12:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 22000, "inputCached": 18000, "output": 6300, "costCents": 52 }
        },
        {
          "uuid": "run-gemini-4",
          "startedAt": "2026-03-30T10:10:05Z",
          "endedAt": "2026-03-30T10:15:00Z",
          "harness": "gemini-cli",
          "model": "gemini-2.5-pro",
          "tokens": { "input": 20000, "inputCached": 0, "output": 5800, "costCents": 35 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect",
        "commit": "def5678"
      }
    },
    "p5": {
      "uuid": "p5",
      "startedAt": "2026-03-30T10:16:00Z",
      "endedAt": "2026-03-30T10:20:00Z",
      "title": "Implement cookie-based session",
      "agents": [
        {
          "uuid": "run-claude-5",
          "startedAt": "2026-03-30T10:16:05Z",
          "endedAt": "2026-03-30T10:20:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 25000, "inputCached": 20000, "output": 7200, "costCents": 58 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect",
        "commit": "ghi9012"
      }
    },
    "p6": {
      "uuid": "p6",
      "startedAt": "2026-03-30T10:22:00Z",
      "endedAt": "2026-03-30T10:25:00Z",
      "title": "Write tests for auth flow",
      "agents": [
        {
          "uuid": "run-claude-6",
          "startedAt": "2026-03-30T10:22:05Z",
          "endedAt": "2026-03-30T10:25:00Z",
          "harness": "claude-code",
          "model": "sonnet-4",
          "effort": "medium",
          "tokens": { "input": 20000, "inputCached": 18000, "output": 8500, "costCents": 32 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect",
        "commit": "jkl3456"
      }
    },
    "c1": {
      "uuid": "c1",
      "startedAt": "2026-03-30T10:30:00Z",
      "endedAt": "2026-03-30T10:30:15Z",
      "title": "Compacted: Auth middleware setup",
      "agents": [
        {
          "uuid": "run-compact-1",
          "startedAt": "2026-03-30T10:30:00Z",
          "endedAt": "2026-03-30T10:30:15Z",
          "harness": "claude-code",
          "model": "haiku",
          "effort": "low",
          "tokens": { "input": 8000, "inputCached": 0, "output": 500, "costCents": 1 }
        }
      ],
      "compaction": {
        "replaces": ["p2", "p3"]
      }
    },
    "p7": {
      "uuid": "p7",
      "startedAt": "2026-03-30T10:35:00Z",
      "endedAt": "2026-03-30T10:40:00Z",
      "title": "Set up Redis connection pool",
      "agents": [
        {
          "uuid": "run-claude-7",
          "startedAt": "2026-03-30T10:35:05Z",
          "endedAt": "2026-03-30T10:40:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 28000, "inputCached": 22000, "output": 6800, "costCents": 55 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect-redis",
        "commit": "mno7890"
      }
    },
    "p8": {
      "uuid": "p8",
      "startedAt": "2026-03-30T10:42:00Z",
      "endedAt": "2026-03-30T10:45:00Z",
      "title": "Redis session store integration",
      "agents": [
        {
          "uuid": "run-claude-8",
          "startedAt": "2026-03-30T10:42:05Z",
          "endedAt": "2026-03-30T10:45:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 30000, "inputCached": 25000, "output": 7500, "costCents": 60 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect-redis",
        "commit": "pqr1234"
      }
    },
    "p9": {
      "uuid": "p9",
      "startedAt": "2026-03-30T10:35:00Z",
      "endedAt": "2026-03-30T10:42:00Z",
      "title": "JWT token generation and validation",
      "agents": [
        {
          "uuid": "run-claude-9",
          "startedAt": "2026-03-30T10:35:05Z",
          "endedAt": "2026-03-30T10:42:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 26000, "inputCached": 20000, "output": 8200, "costCents": 62 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect-jwt",
        "commit": "stu5678"
      }
    },
    "p10": {
      "uuid": "p10",
      "startedAt": "2026-03-30T10:50:00Z",
      "endedAt": "2026-03-30T10:55:00Z",
      "title": "Add refresh token rotation",
      "agents": [
        {
          "uuid": "run-claude-10",
          "startedAt": "2026-03-30T10:50:05Z",
          "endedAt": "2026-03-30T10:55:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 32000, "inputCached": 28000, "output": 9100, "costCents": 68 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect-jwt",
        "commit": "vwx9012"
      }
    },
    "p11": {
      "uuid": "p11",
      "startedAt": "2026-03-30T10:44:00Z",
      "endedAt": "2026-03-30T10:48:00Z",
      "title": "JWT middleware integration",
      "agents": [
        {
          "uuid": "run-claude-11",
          "startedAt": "2026-03-30T10:44:05Z",
          "endedAt": "2026-03-30T10:48:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 30000, "inputCached": 26000, "output": 7800, "costCents": 58 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect-jwt",
        "commit": "yza3456"
      }
    },
    "p12": {
      "uuid": "p12",
      "startedAt": "2026-03-30T11:00:00Z",
      "endedAt": "2026-03-30T11:05:00Z",
      "title": "Deep dive into middleware chain",
      "description": "Extracted exploration of the auth middleware chain order and error handling",
      "agents": [
        {
          "uuid": "run-claude-12",
          "startedAt": "2026-03-30T11:00:05Z",
          "endedAt": "2026-03-30T11:05:00Z",
          "harness": "claude-code",
          "model": "opus",
          "effort": "high",
          "tokens": { "input": 18000, "inputCached": 12000, "output": 5500, "costCents": 48 }
        }
      ],
      "git": {
        "branch": "fix/login-redirect",
        "commit": "def5678"
      }
    }
  },

  "tree": [
    {
      "uuid": "p1",
      "agents": [0, 1],
      "children": [
        {
          "uuid": "p2",
          "agents": [0],
          "children": [
            {
              "uuid": "p3",
              "agents": [0],
              "children": [
                {
                  "uuid": "p4",
                  "agents": [0, 1],
                  "children": [
                    {
                      "uuid": "p5",
                      "agents": [0],
                      "children": [
                        {
                          "uuid": "p6",
                          "agents": [0]
                        }
                      ]
                    },
                    {
                      "uuid": "p7",
                      "agents": [0],
                      "children": [
                        {
                          "uuid": "p8",
                          "agents": [0]
                        }
                      ]
                    },
                    {
                      "uuid": "p9",
                      "agents": [0],
                      "children": [
                        {
                          "uuid": "p11",
                          "agents": [0]
                        },
                        {
                          "uuid": "p10",
                          "agents": [0]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "uuid": "c1",
          "agents": [0],
          "children": [
            {
              "uuid": "p4",
              "agents": [0, 1],
              "children": [
                {
                  "uuid": "p5",
                  "agents": [0],
                  "children": [
                    {
                      "uuid": "p6",
                      "agents": [0]
                    }
                  ]
                }
              ]
            },
            {
              "uuid": "p4",
              "agents": [0, 1],
              "hidden": true,
              "children": [
                {
                  "uuid": "p5",
                  "agents": [0],
                  "children": [
                    {
                      "uuid": "p6",
                      "agents": [0]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "uuid": "p2",
      "agents": [0],
      "children": [
        {
          "uuid": "p3",
          "agents": [0],
          "children": [
            {
              "uuid": "p12",
              "agents": [0]
            }
          ]
        }
      ]
    }
  ],

  "fileChanges": {
    "p1": {
      "gitDiff": ["src/auth/middleware.ts"],
      "fsWatcher": ["src/auth/middleware.ts", "src/auth/types.ts"],
      "byAgentLDPreload": {
        "0": ["src/auth/middleware.ts", "src/auth/types.ts"],
        "1": ["src/auth/middleware.ts"]
      }
    },
    "p2": {
      "gitDiff": ["src/auth/middleware.ts", "src/auth/config.ts"],
      "fsWatcher": ["src/auth/middleware.ts", "src/auth/config.ts"],
      "byAgentLDPreload": {
        "0": ["src/auth/middleware.ts", "src/auth/config.ts"]
      }
    },
    "p4": {
      "gitDiff": ["src/auth/middleware.ts", "src/session/store.ts"],
      "fsWatcher": ["src/auth/middleware.ts", "src/session/store.ts", "package.json"],
      "byAgentLDPreload": {
        "0": ["src/auth/middleware.ts", "src/session/store.ts"],
        "1": ["src/auth/middleware.ts"]
      }
    }
  },

  "clientState": {
    "browser-tab-a1b2c3": {
      "lastSeen": "2026-03-30T12:30:00Z",
      "activePath": [0, 0, 0, 0, 0, 0]
    },
    "browser-tab-d4e5f6": {
      "lastSeen": "2026-03-30T12:28:00Z",
      "activePath": [0, 0, 0, 2, 1]
    }
  }
}
```

### Reading the Tree

**Visualized tree structure:**

```
Root 1 (Main conversation):
p1 [claude, gemini]
├── p2 [claude]                                    ← original path
│   └── p3 [claude]
│       └── p4 [claude, gemini]
│           ├── p5 [claude]                        ← original continuation
│           │   └── p6 [claude]
│           ├── p7 [claude]                        ← "Try Redis sessions" fork
│           │   └── p8 [claude]
│           └── p9 [claude]                        ← "Try JWT approach" fork
│               ├── p11 [claude]                   ← original JWT continuation
│               └── p10 [claude]                   ← "With refresh tokens" fork
│
└── c1 [haiku]                                     ← compacted p2+p3
    ├── p4 [claude, gemini]                        ← compacted path continuation
    │   └── p5 [claude]
    │       └── p6 [claude]
    └── p4 [claude, gemini] (hidden)               ← hidden p4 path
        └── p5 [claude]
            └── p6 [claude]

Root 2 (Extracted: Auth middleware exploration):
p2 [claude]
└── p3 [claude]
    └── p12 [claude]                               ← new prompt added to extraction
```

**Client paths:**
- `browser-tab-a1b2c3` with `activePath: [0, 0, 0, 0, 0, 0]`: follows first child at every fork = `p1 → p2 → p3 → p4 → p5 → p6` (original path)
- `browser-tab-d4e5f6` with `activePath: [0, 0, 0, 2, 1]`: follows `p1 → p2 → p3 → p4 → p9 (3rd child) → p10 (2nd child)` (JWT with refresh tokens)

### Walking the Active Path

To resolve what a client sees, walk the tree following `activePath` indices:

```
function walkActivePath(roots: TreeNode[], activePath: number[]): TreeNode[] {
  Start at roots[0] (or whichever root the client is viewing)
  For each node:
    1. Add it to the result (unless hidden)
    2. If it has children and there's a next index in activePath:
       follow children[activePath[depth]]
    3. If no more indices, follow children[0] (default to first/original)
  Return the flat list of visible prompts
}
```

---

## Operations

### Send Message
1. Create new `Prompt` entry in `prompts` index with agent runs
2. Create `prompts/{uuid}.jsonl` file
3. Append `TreeNode` as child of the current leaf node in the active path
4. Update `session.json` atomically

### Fork
1. At the current prompt node, add a new child `TreeNode`
2. The existing children represent the original path; the new child starts the fork
3. Update `clientState.activePath` to point to the new child

### Compact
1. Create a new synthetic `Prompt` with `compaction.replaces` referencing the target prompts
2. Create the compaction's `prompts/{uuid}.jsonl` with the summary
3. At the parent of the first compacted prompt, add a new child branch:
   - First node is the compaction prompt
   - Remaining nodes are copies of everything after the compacted range
4. Update `clientState.activePath` to follow the compacted branch

### Hide
1. At the parent of the hidden prompt, add a new child branch:
   - Copy the subtree but with `hidden: true` on the target node
2. Update `clientState.activePath` to follow the new branch

### Extract (New Root)
1. Copy the selected prompt nodes as a new root in the `tree` array
2. Prompt files are shared (same UUIDs, same JSONL files)
3. New prompts added to the extraction get their own new JSONL files

### Extract (New Session)
1. Create a new session directory
2. Copy/reference the selected prompt JSONL files and blob files
3. Create a new `session.json` with the extracted prompts as the sole root

### Switch Branch
1. Update `clientState.activePath` at the relevant fork depth
2. Rewrite `session.json` atomically

---

## Migration from JSONL

The existing flat JSONL format can be migrated to this schema:

1. Read all events from `{sessionUuid}.jsonl`
2. Group events by user message + dispatch responses
3. Create `Prompt` entries and `prompts/{uuid}.jsonl` files for each group
4. Rebuild the tree from `branch_operation` records (fork, compact, extract)
5. Map `switch_branch` records to `clientState.activePath`
6. Write `session.json`
7. Move blobs (base64 attachments) to `blobs/` directory
