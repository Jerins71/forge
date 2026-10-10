# WebSocket backend context

## Structure

- HTTP routes live in `ws/http/routes/`.
- Native RPC feature modules live in `ws/rpc/`.
- HTTP services live in `ws/http/services/`.
- Shared HTTP helpers live in `ws/http/shared/`.

## Composition root

`ws/server.ts` is the wiring point. It assembles the HTTP server, native RPC server, route bundles, services, and typed feature publication.

## Command flow

Paired clients use `/api/v2/rpc`. Shared strict schemas and scopes in
`@forge/protocol/environment-v2` own request validation. `rpc/rpc-handlers.ts`
dispatches native methods to the environment's control/stream owners or focused RPC modules.
Lifecycle changes share `control.admitLifecycle`; do not create a second admission policy.

Shell and detail streams do not mark sessions read. Explicit `session.readState` owns read state.
`SessionFeaturePublisher` bridges bounded domain metadata to typed feature streams. Terminal
byte transport and local browser-host attachment retain their separate native owners.

## Import rules

- Route code should not reach directly into `swarm/` internals.
- Use `SwarmManager` as the boundary when websocket or HTTP work needs swarm behavior.
- Shared helpers belong in `ws/http/shared/` or the relevant command/service module, not in route handlers.
- Builder-only adapters such as local Git Monitoring, Stream Deck pairing, and History index diagnostics belong behind focused HTTP services/routes. `GET` / `PATCH /api/history/index` is Builder-only; `PATCH` accepts only boolean `paused`.
