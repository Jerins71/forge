// @vitest-environment jsdom
/* eslint-disable react-hooks/immutability -- record actual row render counts for acceptance evidence */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  createEnvironmentRegistry,
  createMemoryCredentialStore,
  createMemoryPersistence,
  createFeatureClients,
  type EnvironmentRegistry,
} from '@forge/client-runtime'
import {
  startFixtureServer,
  until,
  fixtureWebSocket,
} from '../../../../../packages/client-runtime/src/__tests__/fixture-server'
import { useSelectorStore } from '@/hooks/use-environment-selector'
import { OriginStore } from './origin-store'
import { createDesktopEnvironmentPersistence } from './environment-desktop-persistence'
import { createDesktopEnvironmentTransport } from './environment-platform'
import type {
  EnvironmentCredentialsBridge,
  EnvironmentPersistenceBridge,
  EnvironmentCredentialResult,
} from '@/lib/electron-bridge'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})
async function fleet(count = 8) {
  const servers = await Promise.all(
    Array.from({ length: count }, (_, i) => startFixtureServer(i)),
  )
  for (const s of servers) cleanups.push(() => s.close())
  const registry = createEnvironmentRegistry({
    persistence: createMemoryPersistence(),
    credentials: createMemoryCredentialStore(),
    fetch: (u, i) => globalThis.fetch(u, i),
    webSocket: fixtureWebSocket,
    random: () => 0.01,
  })
  cleanups.push(() => registry.dispose())
  for (const s of servers) await registry.register(s.seed.entry)
  await registry.start()
  await until(() =>
    servers.every(
      (s) =>
        registry.get(s.seed.entry.environmentId).connection.getSnapshot()
          .phase === 'online',
    ),
  )
  return { servers, registry }
}
describe('environment UI store acceptance', () => {
  it('preserves unchanged shell records and shares selector reads across React subscribers', async () => {
    const { servers: [server], registry } = await fleet(1)
    const environment = registry.get(server.seed.entry.environmentId)
    const origin = new OriginStore({ environmentClient: environment })
    cleanups.push(() => origin.destroy())
    const initial = origin.getSnapshot()
    let evaluations = 0
    const selector = (state: typeof initial) => { evaluations++; return state.agents }
    const detach = origin.subscribeSlice('acceptance', selector, () => {})
    cleanups.push(detach)
    origin.readSlice(selector)
    origin.readSlice(selector)
    expect(evaluations).toBe(1)
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 2, event: { type: 'session.upsert', session: { ...server.seed.shell!.sessions[0], title: 'Changed title' } } })
    await until(() => origin.getSnapshot().agents[0]?.displayName === 'Changed title')
    const changed = origin.getSnapshot()
    expect(changed.profiles[0]).toBe(initial.profiles[0])
    expect(changed.unreadCounts).toBe(initial.unreadCounts)
    const readsBefore = evaluations
    origin.readSlice(selector)
    origin.readSlice(selector)
    expect(evaluations).toBe(readsBefore)
    const previousAgent = changed.agents[0]
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 3, event: { type: 'session.upsert', session: { ...server.seed.shell!.sessions[0], title: 'Changed title' } } })
    await until(() => environment.shell.getSnapshot().cursor?.afterSequence === 3)
    expect(origin.getSnapshot().agents[0]).toBe(previousAgent)
  })
  it('projects inventory readiness and project-only changes from the shell when no detail was ever mounted', async () => {
    const { servers: [server], registry } = await fleet(1)
    const environment = registry.get(server.seed.entry.environmentId)
    const origin = new OriginStore({ environmentClient: environment })
    cleanups.push(() => origin.destroy())
    const initial = origin.getSnapshot()
    // A complete shell is the whole inventory; nothing else reports it on this path.
    expect.soft(initial.hasReceivedAgentsSnapshot).toBe(true)
    expect.soft(initial.hasReceivedProfilesSnapshot).toBe(true)
    // A change to a project alone reaches the projection and leaves the session list untouched.
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 2, event: { type: 'project.upsert', project: { ...server.seed.shell!.projects[0], title: 'Renamed project' } } })
    await until(() => environment.shell.getSnapshot().cursor?.afterSequence === 2)
    const renamed = origin.getSnapshot()
    expect.soft(renamed.profiles[0]?.displayName).toBe('Renamed project')
    expect.soft(renamed.agents).toBe(initial.agents)
    // A session change that alters nothing visible republishes neither list.
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 3, event: { type: 'session.upsert', session: { ...server.seed.shell!.sessions[0] } } })
    await until(() => environment.shell.getSnapshot().cursor?.afterSequence === 3)
    expect.soft(origin.getSnapshot().agents).toBe(initial.agents)
    expect.soft(origin.getSnapshot().profiles).toBe(renamed.profiles)
  })
  it('uses bounded Desktop binary requests for file, attachment and chat artifact previews', async () => {
    const bytes = new Uint8Array([0, 127, 128, 255])
    const requests: Array<{ path: string; maxBytes: number }> = []
    const bridge = {
      request: async () => { throw new Error('Binary preview used text IPC') },
      requestBinary: async (input: { path: string; maxBytes: number }) => {
        requests.push(input)
        return { ok: true as const, value: { status: 200, headers: { 'content-type': 'image/png' }, bytes } }
      },
    } as unknown as EnvironmentCredentialsBridge
    const entry = { environmentId: 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9', baseUrl: 'http://127.0.0.1:12345', primary: true, enabled: true, labelOverride: null, credentialRef: null }
    const transport = createDesktopEnvironmentTransport(bridge)
    const blobs: Blob[] = []
    const features = createFeatureClients({
      entry,
      fetch: (path, init) => transport.request(entry, path, init),
      fetchBinary: (path, maxBytes, init) => transport.requestBinary!(entry, path, maxBytes, init),
      json: async () => { throw new Error('Unused JSON request') },
    }, {} as never, blob => { blobs.push(blob); return { url: 'blob:fixture', release: () => {} } })
    await features.files.previewUrl({ agentId: 'session', path: 'image.png', kind: 'raw' })
    await features.sessions.attachmentUrl('image.png')
    await features.chatArtifacts.fileUrl({ agentId: 'session', path: 'image.png' })
    expect(requests).toHaveLength(3)
    expect(requests.every(input => input.maxBytes === 26214400)).toBe(true)
    for (const blob of blobs) expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
  })
  it('isolates actual React row renders across eight WS environments and serializes repeatable evidence', async () => {
    const { servers, registry } = await fleet()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(async () => {
      await act(() => root.unmount())
      host.remove()
    })
    const renders = Array.from({ length: 8 }, () => 0),
      selectors = Array.from({ length: 8 }, () => 0)
    function Row({
      registry,
      index,
    }: {
      registry: EnvironmentRegistry
      index: number
    }) {
      const client = registry.get(servers[index].seed.entry.environmentId)
      const session = useSelectorStore(
        client.shell,
        (state) => {
          selectors[index]++
          return state.sessions.get('session-1')
        },
        ['session:session-1'],
      )
      renders[index]++
      return createElement('span', { 'data-env': index }, session?.title)
    }
    await act(() =>
      root.render(
        createElement(
          'div',
          null,
          ...servers.map((_, index) =>
            createElement(Row, { registry, index, key: index }),
          ),
        ),
      ),
    )
    const before = [...renders],
      selectorBefore = [...selectors],
      a = servers[0]
    await act(async () => {
      a.emit({
        kind: 'event',
        streamEpoch: a.seed.descriptor.streamEpoch,
        sequence: 2,
        event: {
          type: 'session.upsert',
          session: { ...a.seed.shell!.sessions[0], title: 'Only A' },
        },
      })
      await until(
        () =>
          registry
            .get(a.seed.entry.environmentId)
            .shell.getSnapshot()
            .sessions.get('session-1')?.title === 'Only A',
      )
    })
    expect(host.querySelector('[data-env="0"]')?.textContent).toBe('Only A')
    expect(renders.slice(1)).toEqual(before.slice(1))
    expect(selectors.slice(1)).toEqual(selectorBefore.slice(1))
    expect(servers.every((s) => s.connections === 1)).toBe(true)
    await mkdir('../../.internal/forge-v2-remote/artifacts', {
      recursive: true,
    })
    await writeFile(
      '../../.internal/forge-v2-remote/artifacts/client-ui-selectors.json',
      JSON.stringify(
        {
          before,
          after: renders,
          unrelatedRenders: 0,
          unrelatedSelectorRecomputations: 0,
        },
        null,
        2,
      ),
    )
  })
  it('keeps OriginStore and socketless main/side facades on the runtime socket and releases detail streams', async () => {
    const {
      servers: [s],
      registry,
    } = await fleet(1)
    const environment = registry.get(s.seed.entry.environmentId)
    const origin = new OriginStore({ environmentClient: environment })
    cleanups.push(() => origin.destroy())
    origin.getClient().subscribeToAgent('session-1')
    await until(() => origin.getSnapshot().messages.length === 1)
    expect(origin.getSnapshot().conversationBootstrap.phase).toBe('ready')
    expect(s.connections).toBe(1)
    expect(origin.getSnapshot().messages[0]).toMatchObject({
      text: 'Fixture environment ready.',
    })
    await origin.getClient().stopSession('session-1')
    expect(s.inputs.some((i) => i.method === 'session.stop')).toBe(true)
    origin.destroy()
    await until(() => s.subscriptions.size === 1)
    expect(environment.shell.getSnapshot().sessions.size).toBe(1)
  })
  it('round-trips the Desktop encrypted persistence port, hydrates before online probe and clears on WS 4401', async () => {
    const server = await startFixtureServer()
    cleanups.push(() => server.close())
    const id = server.seed.entry.environmentId
    const values = new Map<string, string>()
    const cleared: string[] = []
    const ok = <T>(value: T): EnvironmentCredentialResult<T> => ({
      ok: true,
      value,
    })
    const main: EnvironmentPersistenceBridge = {
      load: async (input) => {
        expect(input.deviceSessionId).toBeUndefined()
        return ok(values.get(input.key) ?? null)
      },
      save: async (input) => {
        if (input.deviceSessionId) expect(input.deviceSessionId).toBe(id)
        values.set(input.key, input.value)
        return ok(undefined)
      },
      clear: async (input) => {
        cleared.push(input.environmentId)
        values.clear()
        return ok(undefined)
      },
    }
    const target = {
      ...server.seed.entry,
      label: 'Desktop',
      deviceSessionId: id,
      deviceName: 'Fixture desktop',
      scopes: ['session:read' as const],
      pairedAt: '2026-10-04T00:00:00.000Z',
      expiresAt: '2026-11-04T00:00:00.000Z',
    }
    const unsupported = async (): Promise<never> => {
      throw new Error('Unused operation')
    }
    const bridge: EnvironmentCredentialsBridge = {
      primary: async () => ok(target),
      list: async () => ok([target]),
      pair: unsupported,
      session: async () =>
        ok(
          await fetch(`${target.baseUrl}/api/v2/access/session`).then((r) =>
            r.json(),
          ),
        ),
      wsTicket: async () =>
        ok(
          await fetch(`${target.baseUrl}/api/v2/access/ws-ticket`).then((r) =>
            r.json(),
          ),
        ),
      request: async (input) => {
        const r = await fetch(`${target.baseUrl}${input.path}`, {
          method: input.method,
          headers: input.headers,
          body: input.body,
        })
        return ok({
          status: r.status,
          headers: Object.fromEntries(r.headers),
          body: await r.text(),
        })
      },
      requestBinary: unsupported,
      uploadArtifact: unsupported,
      artifact: unsupported,
      remove: async () => ok({ removed: true }),
    }
    const local = createMemoryPersistence()
    const persistence = createDesktopEnvironmentPersistence(main, bridge, local)
    const ports = {
      persistence,
      credentials: createMemoryCredentialStore(),
      platform: createDesktopEnvironmentTransport(bridge),
      fetch: (url: string, init?: RequestInit) => fetch(url, init),
      webSocket: fixtureWebSocket,
      random: () => 0.01,
    }
    const first = createEnvironmentRegistry(ports)
    cleanups.push(() => first.dispose())
    await first.register({ ...server.seed.entry, credentialRef: id })
    await first.start()
    await until(() => first.get(id).connection.getSnapshot().phase === 'online')
    await first.dispose()
    expect(JSON.parse(values.get('shell')!).cursor.afterSequence).toBe(1)
    const offline = createEnvironmentRegistry({
      ...ports,
      connectivity: { online: () => false, subscribe: () => () => {} },
    })
    cleanups.push(() => offline.dispose())
    await offline.start()
    expect(offline.get(id).shell.getSnapshot().sessions.size).toBe(1)
    expect(offline.get(id).connection.getSnapshot().shellFresh).toBe(false)
    const restored = createEnvironmentRegistry(ports)
    cleanups.push(() => restored.dispose())
    await restored.start()
    await until(
      () => restored.get(id).connection.getSnapshot().phase === 'online',
    )
    server.disconnect(4401)
    await until(() => cleared.length === 1)
    expect(cleared).toEqual([id])
    expect(values.size).toBe(0)
    expect(restored.get(id).shell.getSnapshot().sessions.size).toBe(0)
  })
})
