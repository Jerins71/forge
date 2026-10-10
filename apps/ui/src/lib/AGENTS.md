# Local context for `apps/ui/src/lib`

This directory contains shared client-side infrastructure. Treat the websocket client as a layered module with a stable facade and smaller internal pieces.

## ws-client

`@forge/client-runtime` owns environment catalog, the single socket/supervisor per enabled environment, shell/detail stores, authentication and command recovery. React consumers use environment-qualified selector hooks and mounted detail leases. `ManagerWsClient` is a temporary socketless facade/reducer on the V2 path; inject `EnvironmentClient`, use native lifecycle RPCs for actions. Feature components never own sockets or construct backend URLs.

Keep the presentation `ManagerWsState` facade stable while auditing every consumer of changed
fields. Primary identity comes from bootstrap as a paired UUID; unknown environments never route
to the primary. Shell/detail/runtime caches are authoritative; do not restore a second presentation
cache or raw WebSocket reducer path.

Decomposition lives in `ws-client/`: native projection, outbox, browser and bounded typed detail
features. Terminal and throughput presentation retain their focused event reducers. Native lifecycle
senders use the same RPCs as CLI consumers.

Key tests are `ws-client/environment-commands.acceptance.test.ts`,
`ws-client/detail-features.acceptance.test.ts`, and the fresh environment UI fleet.

## General

Keep facade contracts intact and update focused native modules when changing behavior.
