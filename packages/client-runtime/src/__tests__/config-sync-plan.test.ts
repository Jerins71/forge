import { describe, expect, it } from 'vitest'
import { planConfigSyncKey, type ConfigSyncSide } from '../config-sync.js'

// Ways a key's plan can go wrong: losing an edit to a stale side, overwriting a group's file with a
// fresh environment's default, resurrecting or swallowing a delete, ignoring an edit made after a
// conflict, and pushing while two different edits exist.
const side = (environmentId: string, cur: string | null, base?: string | null, extra: Partial<ConfigSyncSide> = {}): ConfigSyncSide =>
  ({ environmentId, cur, ...(base === undefined ? {} : { base, baseAt: 't1' }), joining: false, ...extra })

describe('planConfigSyncKey', () => {
  it('does nothing when every side matches its base', () => {
    expect(planConfigSyncKey([side('a', 'h1', 'h1'), side('b', 'h1', 'h1')])).toEqual({ kind: 'none' })
    expect(planConfigSyncKey([side('a', null), side('b', null)])).toEqual({ kind: 'none' })
  })

  it('records agreement when both sides hold the same new content', () => {
    expect(planConfigSyncKey([side('a', 'h2', 'h1'), side('b', 'h2', 'h1')])).toEqual({ kind: 'push', hash: 'h2', from: 'a' })
  })

  it('pushes the one changed version', () => {
    expect(planConfigSyncKey([side('a', 'h2', 'h1'), side('b', 'h1', 'h1')])).toEqual({ kind: 'push', hash: 'h2', from: 'a' })
    expect(planConfigSyncKey([side('a', 'h1', 'h1'), side('b', 'h1', 'h1'), side('c', 'h3', 'h1')]))
      .toEqual({ kind: 'push', hash: 'h3', from: 'c' })
  })

  it('pushes a new file and a delete', () => {
    expect(planConfigSyncKey([side('a', 'h1'), side('b', null)])).toEqual({ kind: 'push', hash: 'h1', from: 'a' })
    expect(planConfigSyncKey([side('a', null, 'h1'), side('b', 'h1', 'h1')])).toEqual({ kind: 'push', hash: null, from: 'a' })
  })

  it('records a conflict when two sides changed differently, including edit against delete', () => {
    expect(planConfigSyncKey([side('a', 'h2', 'h1'), side('b', 'h3', 'h1')]))
      .toEqual({ kind: 'conflict', record: { a: 'h2', b: 'h3' } })
    expect(planConfigSyncKey([side('a', null, 'h1'), side('b', 'h3', 'h1')]))
      .toEqual({ kind: 'conflict', record: { a: null, b: 'h3' } })
    expect(planConfigSyncKey([side('a', 'h2'), side('b', 'h3')])).toEqual({ kind: 'conflict', record: { a: 'h2', b: 'h3' } })
  })

  it('treats an edit made while offline, over a version the others have since replaced, as a conflict', () => {
    // b missed the push of h2 from a to c, then edited its stale h1.
    const newer = { baseAt: 't2' }
    expect(planConfigSyncKey([side('a', 'h2', 'h2', newer), side('b', 'h3', 'h1'), side('c', 'h2', 'h2', newer)]))
      .toEqual({ kind: 'conflict', record: { a: 'h2', b: 'h3', c: 'h2' } })
    // b missed the push but did not edit: it simply catches up.
    expect(planConfigSyncKey([side('a', 'h2', 'h2', newer), side('b', 'h1', 'h1'), side('c', 'h2', 'h2', newer)]))
      .toEqual({ kind: 'push', hash: 'h2', from: 'a' })
    // a deletion b missed reaches b too.
    expect(planConfigSyncKey([side('a', null, null, newer), side('b', 'h1', 'h1')]))
      .toEqual({ kind: 'push', hash: null, from: 'a' })
  })

  it('keeps an open conflict until one side is edited, then that edit wins', () => {
    const record = { a: 'h2', b: 'h3' }
    expect(planConfigSyncKey([side('a', 'h2', 'h1', { conflict: record }), side('b', 'h3', 'h1', { conflict: record })]))
      .toEqual({ kind: 'conflict', record })
    expect(planConfigSyncKey([side('a', 'h4', 'h1', { conflict: record }), side('b', 'h3', 'h1', { conflict: record })]))
      .toEqual({ kind: 'push', hash: 'h4', from: 'a' })
    expect(planConfigSyncKey([side('a', 'h4', 'h1', { conflict: record }), side('b', 'h5', 'h1', { conflict: record })]))
      .toEqual({ kind: 'conflict', record: { a: 'h4', b: 'h5' } })
  })

  it('resolves a conflict that both sides already agree on', () => {
    const record = { a: 'h2', b: 'h3' }
    expect(planConfigSyncKey([side('a', 'h3', 'h1', { conflict: record }), side('b', 'h3', 'h1', { conflict: record })]))
      .toEqual({ kind: 'push', hash: 'h3', from: 'a' })
  })

  it('makes a joining environment adopt the group version but contribute files the group lacks', () => {
    expect(planConfigSyncKey([side('a', 'h1', 'h1'), side('b', 'default', undefined, { joining: true })]))
      .toEqual({ kind: 'push', hash: 'h1', from: 'a' })
    expect(planConfigSyncKey([side('a', null), side('b', 'only-b', undefined, { joining: true })]))
      .toEqual({ kind: 'push', hash: 'only-b', from: 'b' })
    expect(planConfigSyncKey([side('a', 'x', undefined, { joining: true }), side('b', 'y', undefined, { joining: true })]))
      .toEqual({ kind: 'conflict', record: { a: 'x', b: 'y' } })
  })
})
