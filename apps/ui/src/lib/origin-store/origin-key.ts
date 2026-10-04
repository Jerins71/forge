/**
 * Composite `(originId, id)` identity for the origin-aware store.
 *
 * Agent, profile, and session ids are only unique within one backend, so store
 * keys carry the pair.
 */

/** Opaque origin identifier: the environment UUID. */
export type OriginId = string

/**
 * Separator between origin and id in a flat composite key string.  Chosen to
 * not collide with agent/profile id characters (which are hex-ish handles).
 */
const COMPOSITE_SEPARATOR = '::'

/**
 * Build a stable, flat key from an `(originId, id)` pair — suitable for `Map`
 * keys, React `key` props, and per-slice subscription keys.
 */
export function compositeKey(originId: OriginId, id: string): string {
  return `${originId}${COMPOSITE_SEPARATOR}${id}`
}
