Forge separates task notes, session memory, profile memory, and global common memory. All memory files are plain Markdown on disk that you can open and edit.

## Profile memory

Each profile has a canonical `memory.md` for durable project facts, conventions, and decisions shared through the memory-merge lifecycle.

## Session memory

Each chat session has its own `memory.md` for durable facts and decisions you ask the agent to remember. Approved durable session insights can enter the profile memory-merge lifecycle.

## Task notes

The agent can keep task notes automatically while doing authorized work: the objective, your corrections, progress, open questions, evidence references, and next steps. These notes are separate from `memory.md`. They survive context transitions and restart without automatically becoming profile memory. Context v2 uses these notes to continue the same task and retrieves earlier evidence when more detail is needed.

Each agent owns its notes. A fork from the current state receives an independent snapshot; a fork at an earlier message starts fresh notes so later discoveries do not leak into that branch. Clearing or deleting a session removes its task notes. Notes preserve working state, but do not create new permission or prove the current state of files and services.

## Common memory

`shared/knowledge/common.md` holds cross-profile preferences and facts that apply to every project. Forge reads it when present; it is maintained only by you or by agents you explicitly ask to update it.

## Prompt sources

Manager prompts receive `common.md`, the canonical profile `memory.md`, and the current session `memory.md`. A missing file is simply skipped.

## History recall

Transcript history preserves messages and tool results. Local Builder managers and ordinary workers can browse context windows, list earlier items, search, and read evidence with the agent-only `history` tool. The agent starts with the current session and associated workers, then widens to a project or explicitly selected session when needed. Searches outside the current project need a reason, without a separate approval prompt.

Ranked word searches help discover related work. Literal search finds exact wording, paths, or errors. Results report incomplete coverage or bounded scans, so an empty partial result does not prove that evidence is absent. The agent should read relevant results and verify current state before acting.

**Settings → History** pauses or resumes indexing. Conversation recording and direct window/item browsing, literal scans, and canonical reads remain available while the index is paused. Canonical JSONL is the source of truth; the local index is a rebuildable cache. Restricted runtime content and Secure Sessions secrets remain excluded. There is no separate human history drawer.
