The manager works directly. It spawns a worker when you ask for one or when a worker clearly helps: separable parallel work, a different model, or an independent check.

## Worker presets

A worker preset is a saved model choice for a worker: a name, a model, a reasoning level, and an optional one-line note. The manager names a worker preset when it wants a worker on that model. With no worker preset, the worker uses the manager's own model.

Worker presets are one flat, global list. They are not the model family presets described in the Provider Guide.

## Specialist files

Specialist markdown files you wrote also appear as worker presets. The file's handle is the name, `whenToUse` is the note, and the markdown body is that worker's instructions. Forge never rewrites these files, and a file wins over a saved worker preset with the same name.

## What a worker receives

A worker gets the assignment the manager writes for it, not a copy of the manager conversation. Its final response returns to the manager automatically. The manager verifies the result and stays accountable for the outcome.

Manage the list under **Settings → Worker presets**.
