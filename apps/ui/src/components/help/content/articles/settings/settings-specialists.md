A worker preset is a saved model choice the manager can name when it spawns a worker. The manager works directly and spawns workers when you ask or when a worker clearly helps: separable parallel work, a different model, or an independent check.

Worker presets are different from the model family presets described in the Provider Guide.

## The list

**Settings → Worker presets** shows one flat, global list. Each worker preset has:

- **Name** — a lowercase slug the manager uses to pick it.
- **Model** — the provider and model the worker runs on.
- **Reasoning** — the reasoning level for that model.
- **Note** — an optional one-line hint that tells the manager when the worker preset fits.

When the manager spawns a worker without naming a worker preset, the worker uses the manager's own model.

Forge stores the list in `shared/config/worker-presets.json` in your Forge data directory.

## Specialist files

Specialist markdown files you wrote also appear in the list. Forge reads them from the shared and profile `specialists` folders and from a repository's `.forge/specialists/` folder.

- The file's handle becomes the name.
- `whenToUse` becomes the note.
- The markdown body becomes that worker's instructions.

Older keys such as `defaultTier`, the fallback keys, `color`, `pinned`, and `webSearch` are ignored. Forge never rewrites these files. If a file and a saved worker preset share a name, the file wins.

## After upgrading

Forge converts your existing rosters into worker presets once, on first start after the upgrade. Each keeps its model and reasoning, takes its route id as the name, and uses the first sentence of its old guidance as the note.

Work modes, task types, automatic fallback models, and the builtin planner, reviewer, researcher, and architect prompts are gone.

## Codex Plugin

Codex Plugin is not a worker preset. When you include an active `@Codex` plugin selector, Forge provides a dedicated tool and binds its worker to the server-owned selector scope. The model cannot supply or widen selectors. Explicit retry turns can reuse a stopped or failed worker's stored scope; unrelated turns require a fresh selector tag.
