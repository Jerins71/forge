# Protocol package context

## Ownership

This package owns shared wire types, request/response contracts, event definitions, and DTOs consumed
across Forge. Add or change a contract here before updating backend, UI, Electron, or CLI consumers.
Do not maintain private copies of shared contracts in application packages.

Keep domain types in focused leaf modules under `src/` and re-export public contracts through the
package barrel. Preserve the root-barrel contract when moving or splitting modules.

## Compatibility

- Within one V2 `protocolVersion`, clients ignore unknown properties in received data, including
  nested objects, descriptors, pairing/session responses, RPC results, streams, and restored data caches.
  Use `decodeEnvironmentValue`; keep outbound schemas strict so producers emit only declared fields.
- Backend RPC/command inputs remain strict: reject unknown request fields rather than silently discard
  unsupported intent. Clients must gate new request options on a capability or `protocolVersion`.
- Additive optional response fields preserve defaults and absence behavior. Breaking changes (removing
  fields, changing their meaning/type, or required behavior) require a `protocolVersion` bump.
  Descriptor or known-data mismatches block the environment with “Update required” instead of retrying.
- Optional does not mean semantically unimportant. Preserve defaults and absence behavior across
  serializers, parsers, persisted history, and bootstrap/replay paths.
- Request identifiers used for optimistic reconciliation are not automatically exactly-once or
  idempotency guarantees.

## Environment transport

Paired clients use the native environment RPC contract. Protocol 2 removes the legacy
command registry and root/CLI WebSocket routes. Version mismatches block with “Update required”;
they must preserve credentials and avoid reconnect loops. Cached protocol 1 data may be discarded
cleanly. Shell/detail subscriptions remain read-only; explicit read-state RPCs own read mutations.

## Downstream validation

For every contract change, audit the relevant consumers in:

- `apps/backend/src/ws/` for parsing, handlers, routes, subscriptions, and serialization.
- `apps/ui/src/lib/` and feature components for request builders, reducers, stores, and rendering.
- `packages/cli/` when the contract is exposed through CLI commands or output.
- persisted session/history projection paths when an event can be replayed after restart.

Run the focused protocol contract test plus targeted backend and UI tests for the changed behavior.
Update fixtures on both sides of the wire rather than weakening contract assertions.
