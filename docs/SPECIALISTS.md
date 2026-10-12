# Worker presets

The manager works directly. It spawns a worker when you ask for one or when a worker clearly helps: separable parallel work, a different model, or an independent check.

A **worker preset** is a saved model choice the manager can name when it spawns a worker. Worker presets are one flat, global list. They are unrelated to the model family presets (`pi-fable`, `pi-opus`, and similar) described in [Model Catalog](MODEL_CATALOG.md).

## Fields

| Field | Meaning |
|---|---|
| `name` | Lowercase slug (letters, digits, hyphens; up to 64 characters). Unique across the list. |
| `provider` / `modelId` | The model the worker runs on. |
| `reasoningLevel` | The reasoning level for that model. |
| `note` | Optional one-line hint shown to the manager and in Settings (up to 300 characters). |

Manage the list under **Settings → Worker presets**. Forge stores it in `<dataDir>/shared/config/worker-presets.json`.

## Spawning workers

`spawn_agent` takes a required `initialMessage`, plus optional `preset`, `cwd`, `planStepId`, and `requiresSecureRuntime`.

- With a `preset`, the worker uses that worker preset's model and reasoning.
- With no `preset`, the worker uses the manager's own model.

Workers receive the assignment in `initialMessage`, not a copy of the manager conversation. Each worker's final response returns to the manager automatically; the manager verifies and integrates it.

## Specialist files

User-authored specialist markdown files also appear as worker presets, and additionally carry their own worker instructions:

- Shared: `<dataDir>/shared/specialists/<handle>.md`
- Profile: `<dataDir>/profiles/<profileId>/specialists/<handle>.md`
- Repository: `<repo>/.forge/specialists/<handle>.md`

| File | Worker preset |
|---|---|
| Handle (filename without `.md`) | `name` |
| `whenToUse` | `note` |
| Markdown body | That worker's instructions |

```markdown
---
whenToUse: Payment provider integration analysis and implementation
modelId: grok-4.5
provider: cursor-sdk
reasoningLevel: high
---
You are the payments integration worker. Own the assigned payment-provider outcome, inspect the real code path, and verify changes with focused tests.

You are not user-facing. Return status, summary, changed files, verification, and remaining risks to the manager.
```

Every frontmatter value must fit on one line. The parser reads `key: value` pairs line by line and does not support YAML block scalars (`>-`, `|`). Put comments on their own lines; a trailing inline comment is read as part of the value.

The old keys `defaultTier`, `fallbackModelId`, `fallbackReasoningLevel`, `color`, `pinned`, and `webSearch` are ignored. Forge never rewrites these files. When a specialist file and a saved worker preset share a name, the file wins.

## Upgrading

On first boot after the upgrade, Forge converts each existing roster entry into a worker preset once: the name is the route id, the model and reasoning are unchanged, and the note is the first sentence of its `useWhen` guidance.

These are gone: work modes, task types, rosters and routes, `useWhen`/`avoidWhen` guidance, automatic fallback models, escalation to a stronger worker, effort tiers, the builtin `planner`, `code-reviewer`, `code-reviewer-2`, `researcher`, and `architect` role prompts, the post-update recommended-defaults offer, and the per-turn `[delegationRoster]` context.

## Codex Plugin

Codex Plugin delegation is unchanged and is not a worker preset. It is available only when a user turn includes an active `@Codex` plugin selector, and Forge binds the dedicated worker to the server-stored selector scope. Scoped plugin tools return bounded preview and metadata only; full connector exports are written as redacted session artifacts. An explicit retry or continuation turn can reuse a stopped or failed worker's stored scope; unrelated turns require a fresh selector tag.

## Related

- [Model Catalog](MODEL_CATALOG.md) — available models, reasoning levels, and OpenRouter routing
- [Project resources](PROJECT_RESOURCES.md) — repository `.forge/specialists/`
- [Secure Sessions](SECURE_SESSIONS.md) — `requiresSecureRuntime`
