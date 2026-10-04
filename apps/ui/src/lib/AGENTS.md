# Local context for `apps/ui/src/lib`

This directory contains shared client-side infrastructure. Treat the websocket client as a layered module with a stable facade and smaller internal pieces.

## ws-client

`@forge/client-runtime` owns environment catalog, the single socket/supervisor per enabled environment, shell/detail stores, authentication and command recovery. React consumers use environment-qualified selector hooks and mounted detail leases. `ManagerWsClient` is a temporary socketless facade/reducer on the V2 path; inject `EnvironmentClient`, never call its legacy `start()` for an environment. Feature components never own sockets or construct backend URLs.

Keep the compatibility `ManagerWsState` shape stable. Primary identity comes from bootstrap as a paired UUID; unknown environments never route to the primary. Any change to the state contract needs a full consumer audit across the UI.

Decomposition lives in:
- `ws-client/` for request builders, runtime constants, reducers, utilities, and helpers
- `ws-client/event-handlers/` for event-specific reducers and dispatch logic

Event handlers are grouped by domain:
- `agent`
- `session`
- `conversation`
- `config`
- `directory`
- `project-agent`
- `system`
- `terminal`

Key test:
- `apps/ui/src/lib/ws-client.test.ts`

## General

When editing ws-client behavior, keep the facade contract intact and update handler submodules in the matching domain instead of centralizing more logic in the top-level file.