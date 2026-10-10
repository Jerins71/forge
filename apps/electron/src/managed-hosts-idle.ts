import { ENVIRONMENT_PROTOCOL_VERSION } from '@forge/protocol/environment-v2'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { ManagedHostRecord } from '@forge/protocol'
import {
  ENVIRONMENT_RPC_PATH,
  ENVIRONMENT_WS_PROTOCOL,
  ShellStreamItemSchema,
  decodeEnvironmentValue,
  rpcSchemas,
  type RpcServerFrame,
  type SessionSummary,
} from '@forge/protocol/environment-v2'
import type { EnvironmentCredentialsBridge } from './environment-credentials-ipc.js'
import type { ManagedHostDriver } from './managed-hosts.js'
import { shellQuote as q } from './managed-hosts-ssh.js'
/** One bounded read through the ordinary authenticated RPC; never a reconnect/connection owner. */
async function readShell(
  credentials: Pick<EnvironmentCredentialsBridge, 'wsTicket'>,
  environmentId: string,
  baseUrl: string,
  origin: string,
): Promise<SessionSummary[]> {
  const ticket = await credentials.wsTicket(environmentId, 'rpc', ENVIRONMENT_PROTOCOL_VERSION)
  if (!ticket.ok) throw new Error('Host authentication is unknown')
  const url = new URL(ENVIRONMENT_RPC_PATH, baseUrl)
  url.protocol = 'ws:'
  const socket = new WebSocket(
    url,
    [ENVIRONMENT_WS_PROTOCOL, 'ticket.' + ticket.value.ticket],
    { origin, maxPayload: 1048576, handshakeTimeout: 10000 },
  )
  try {
    return await new Promise<SessionSummary[]>((resolve, reject) => {
      const timeout = setTimeout(
        () => end(new Error('Host idle state is unknown')),
        15000,
      )
      const sessions: SessionSummary[] = []
      const requests = new Map<string, 'subscribe' | 'page' | 'workers'>()
      let workerSession = 0
      const workerIds = new Set<string>()
      let snapshot = false,
        sequence: number | undefined,
        epoch: string | undefined
      const end = (error?: Error) => {
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve(sessions)
      }
      const request = (
        kind: 'subscribe' | 'page' | 'workers',
        method: string,
        input: unknown,
      ) => {
        const id = randomUUID()
        requests.set(id, kind)
        socket.send(
          JSON.stringify({ type: 'request', requestId: id, method, input }),
        )
      }
      const nextWorkers = () => {
        while (
          workerSession < sessions.length &&
          sessions[workerSession].workerCount === 0
        ) workerSession++
        if (workerSession === sessions.length) return end()
        workerIds.clear()
        request('workers', 'session.workers', {
          sessionId: sessions[workerSession].sessionId,
        })
      }
      const page = (next: string | null) => {
        if (next) request('page', 'shell.page', { page: next })
        else nextWorkers()
      }
      socket.once('open', () => request('subscribe', 'shell.subscribe', {}))
      socket.on('error', () => end(new Error('Host RPC is unavailable')))
      socket.once('close', () =>
        end(new Error('Host RPC closed before state was read')),
      )
      socket.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw.toString()) as RpcServerFrame
          if (frame.type === 'error' || frame.type === 'stream.error')
            throw new Error('Host idle state is unknown')
          if (
            frame.type === 'result' &&
            requests.get(frame.requestId) === 'page'
          ) {
            requests.delete(frame.requestId)
            const output = decodeEnvironmentValue(
              rpcSchemas['shell.page'].output,
              frame.output,
            )
            if (
              !output ||
              output.sequence !== sequence ||
              output.streamEpoch !== epoch
            )
              throw new Error('Host shell changed during pagination')
            sessions.push(...output.snapshot.sessions)
            if (sessions.length > 50000)
              throw new Error('Host shell exceeded its limit')
            page(output.snapshot.nextPage)
          }
          if (
            frame.type === 'result' &&
            requests.get(frame.requestId) === 'workers'
          ) {
            requests.delete(frame.requestId)
            const output = decodeEnvironmentValue(
              rpcSchemas['session.workers'].output,
              frame.output,
            )
            if (!output) throw new Error('Host worker state is unknown')
            for (const worker of output.workers) {
              if (worker.status === 'streaming')
                throw new Error('Host has an active worker')
              if (workerIds.has(worker.agentId))
                throw new Error('Host worker inventory changed')
              workerIds.add(worker.agentId)
            }
            if (workerIds.size > 50000)
              throw new Error('Host worker inventory exceeded its limit')
            if (output.nextPage)
              request('workers', 'session.workers', {
                sessionId: sessions[workerSession].sessionId,
                page: output.nextPage,
              })
            else {
              if (workerIds.size !== sessions[workerSession].workerCount)
                throw new Error('Host worker inventory is incomplete')
              workerSession++
              nextWorkers()
            }
          }
          if (frame.type === 'stream') {
            const item = decodeEnvironmentValue(
              ShellStreamItemSchema,
              frame.item,
            )
            if (!item) throw new Error('Invalid shell state')
            if (item.kind === 'event')
              throw new Error('Host changed while idle state was being read')
            if (item.kind === 'snapshot') {
              if (snapshot) throw new Error('Host shell reset during idle read')
              snapshot = true
              sequence = item.sequence
              epoch = item.streamEpoch
              sessions.push(...item.snapshot.sessions)
              page(item.snapshot.nextPage)
            }
          }
        } catch {
          end(new Error('Host idle state is unknown'))
        }
      })
    })
  } finally {
    socket.removeAllListeners('message')
    socket.close()
    setTimeout(() => socket.terminate(), 1000).unref()
  }
}
export async function assertManagedHostIdle(
  credentials: Pick<EnvironmentCredentialsBridge, 'wsTicket' | 'request'>,
  record: ManagedHostRecord,
  baseUrl: string,
  origin: string,
  driver: Pick<ManagedHostDriver, 'run'>,
): Promise<void> {
  if (!record.environmentId) throw new Error('Host identity is unknown')
  const sessions = await readShell(
    credentials,
    record.environmentId,
    baseUrl,
    origin,
  )
  if (
    sessions.some(
      (s) => ['preparing', 'running', 'waiting', 'stopping'].includes(s.status),
    )
  )
    throw new Error('Host has active sessions or workers')
  for (const session of sessions) {
    const result = await credentials.request({
      environmentId: record.environmentId,
      path:
        '/api/terminals?sessionAgentId=' +
        encodeURIComponent(session.sessionId),
      method: 'GET',
    })
    if (!result.ok || result.value.status !== 200)
      throw new Error('Host terminal state is unknown')
    const value = JSON.parse(result.value.body) as {
      terminals?: unknown[]
    }
    if (!Array.isArray(value.terminals) || value.terminals.length)
      throw new Error('Host has live terminals or terminal state is unknown')
  }
  // Shell has no receipt inventory. Read its authoritative host database, including other clients'
  // commands, with the installed native module and existing data-path owner; never infer from a sidebar.
  const version = posix.join(
    record.installDir,
    'versions',
    `forge-server-${record.installedVersion}-linux-x64`,
  )
  const { getEnvironmentDbPath } = await import(
    '../../backend/src/swarm/storage/data-paths.js'
  )
  const db = getEnvironmentDbPath(posix.join(record.installDir, 'data'))
    .split('\\')
    .join('/')
  const script = `const DB=require(${JSON.stringify(posix.join(version, 'backend/node_modules/better-sqlite3'))});const d=new DB(${JSON.stringify(db)},{readonly:true,fileMustExist:true});try{if(d.prepare("SELECT count(*) AS n FROM command_receipts WHERE state IN ('accepted','running')").get().n!==0)process.exit(1)}finally{d.close()}`
  await driver.run(
    record.hostAlias,
    `set -eu\n# forge:idle-commands\n${q(posix.join(version, 'node/bin/node'))} -e ${q(script)} || { printf 'FORGE_BUSY\\n' >&2; exit 1; }\n`,
  )
}
