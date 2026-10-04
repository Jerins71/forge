# Forge backend

The backend owns Builder orchestration, local persistence, HTTP/WebSocket APIs, runtime integrations, and terminal lifecycle.

## Development

From the repository root:

```bash
pnpm dev:backend
```

Use the repository [README](../../README.md) for prerequisites and common commands. Backend-specific validation and data-path rules are in [the root instructions](../../AGENTS.md), and subsystem boundaries are documented in [`src/swarm/AGENTS.md`](src/swarm/AGENTS.md), [`src/ws/AGENTS.md`](src/ws/AGENTS.md), and [`src/terminal/AGENTS.md`](src/terminal/AGENTS.md).

## Key boundaries

- Shared wire contracts belong in [`@forge/protocol`](../../packages/protocol/README.md); update every producer, parser, consumer, persistence path, and test when a contract changes.
- Use `src/swarm/storage/data-paths.ts` for Forge-managed data locations. Do not construct those paths ad hoc.
- User-authored specialists, prompts, reference documents, and skills are file-backed.

See [Quality](../../docs/QUALITY.md) for the supported validation tiers.
