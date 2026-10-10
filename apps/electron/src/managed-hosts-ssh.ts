import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:net'
import type { ManagedHostDriver, ManagedTunnel } from './managed-hosts.js'
export const shellQuote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'"
const sshOptions = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'PasswordAuthentication=no',
  '-o',
  'KbdInteractiveAuthentication=no',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
]
export function sshFailure(stderr: string): Error {
  const marker = stderr.match(
    /FORGE_(LINGER|PLATFORM|GLIBC|TOOLS|USER_MANAGER|UNMANAGED|BUSY|ARTIFACT|PORT)/,
  )?.[0]
  if (marker) return new Error(marker)
  if (
    /HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(
      stderr,
    )
  )
    return new Error(
      'Host key verification failed. Verify this alias in OpenSSH known_hosts before connecting.',
    )
  if (/Address already in use|cannot listen to port/i.test(stderr))
    return new Error('Local forwarding port conflict: Address already in use')
  return new Error(
    'SSH connection failed. Check the host alias, existing SSH keys/agent, and host prerequisites.',
  )
}
export function createOpenSshDriver(): ManagedHostDriver {
  let disposed = false
  const children = new Map<
    import('node:child_process').ChildProcess,
    Promise<void>
  >()
  const listeners = new Set<ManagedTunnel>()
  function start(args: string[], stdio: ['pipe', 'pipe' | 'ignore', 'pipe']) {
    if (disposed) throw new Error('Desktop SSH transport is closed')
    const child = spawn('ssh', [...sshOptions, ...args], {
      stdio,
      windowsHide: true,
    })
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => {
        children.delete(child)
        resolve()
      }),
    )
    children.set(child, closed)
    return child
  }
  async function stop(child: import('node:child_process').ChildProcess) {
    const closed = children.get(child)
    if (!closed) return
    child.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (children.has(child)) child.kill('SIGKILL')
    await closed
  }
  const run: ManagedHostDriver['run'] = (alias, script, options = {}) =>
    new Promise<string>((resolve, reject) => {
      const child = start(
        ['-o', 'ClearAllForwardings=yes', alias, 'sh -s'],
        ['pipe', 'pipe', 'pipe'],
      )
      const maximum = options.maxBytes ?? 65536
      let bytes = 0,
        stderr = '',
        output = '',
        settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          void stop(child)
          reject(error)
        } else resolve(output)
      }
      const timer = setTimeout(
        () => finish(new Error('SSH command timed out')),
        options.timeoutMs ?? 60000,
      )
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maximum)
          finish(new Error('SSH response exceeded its limit'))
        else output += chunk.toString('utf8')
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8')
      })
      child.on('error', () =>
        finish(
          new Error(
            'OpenSSH is unavailable. Install the native OpenSSH client.',
          ),
        ),
      )
      child.on('close', (code) =>
        finish(code === 0 ? undefined : sshFailure(stderr)),
      )
      child.stdin!.on('error', () => {})
      child.stdin!.end(script)
    })
  return {
    run,
    upload: (alias, localFile, remoteFile) =>
      new Promise<void>((resolve, reject) => {
        const command = 'umask 077; cat > ' + shellQuote(remoteFile)
        const child = start(
          [
            '-o',
            'ClearAllForwardings=yes',
            alias,
            'sh -c ' + shellQuote(command),
          ],
          ['pipe', 'ignore', 'pipe'],
        )
        let stderr = '',
          settled = false
        const file = createReadStream(localFile)
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          file.destroy()
          if (error) {
            void stop(child)
            reject(error)
          } else resolve()
        }
        const timer = setTimeout(
          () => finish(new Error('SSH artifact upload timed out')),
          300000,
        )
        child.stderr!.on('data', (chunk: Buffer) => {
          if (stderr.length < 8192) stderr += chunk.toString('utf8')
        })
        child.on('error', () => finish(new Error('OpenSSH is unavailable')))
        child.on('close', (code) =>
          finish(code === 0 ? undefined : sshFailure(stderr)),
        )
        file.on('error', () =>
          finish(new Error('Server artifact could not be read')),
        )
        child.stdin!.on('error', () => {})
        file.pipe(child.stdin!)
      }),
    tunnel: async (alias, remotePort) => {
      // Authenticate the SSH host before publishing an endpoint. Keep the actual TCP listener
      // continuously owned by Desktop; no port is released for ssh (or another user) to bind.
      await run(alias, 'true\n', { timeoutMs: 15000 })
      if (disposed) throw new Error('Desktop SSH transport is closed')
      const connections = new Map<
        import('node:net').Socket,
        import('node:child_process').ChildProcess
      >()
      let closing: Promise<void> | undefined
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        if (disposed || closing || connections.size >= 128) {
          socket.destroy()
          return
        }
        let child: import('node:child_process').ChildProcess
        try {
          child = start(
            [
              '-o',
              'ClearAllForwardings=yes',
              '-o',
              'ServerAliveInterval=15',
              '-o',
              'ServerAliveCountMax=3',
              '-W',
              `127.0.0.1:${remotePort}`,
              alias,
            ],
            ['pipe', 'pipe', 'pipe'],
          )
        } catch {
          socket.destroy()
          return
        }
        connections.set(socket, child)
        // stdout is only the SSH direct-tcpip stream. SSH diagnostics never enter HTTP/IPC/logs.
        child.stderr!.resume()
        socket.on('error', () => {})
        child.stdin!.on('error', () => socket.destroy())
        child.stdout!.on('error', () => socket.destroy())
        child.on('error', () => socket.destroy())
        child.once('close', () => {
          connections.delete(socket)
          socket.destroy()
        })
        socket.once('close', () => {
          connections.delete(socket)
          void stop(child)
        })
        socket.pipe(child.stdin!)
        child.stdout!.pipe(socket)
      })
      const exited = new Promise<void>((resolve) =>
        server.once('close', resolve),
      )
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address() as { port: number }
      const tunnel: ManagedTunnel = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        exited,
        close: () =>
          (closing ??= (async () => {
            listeners.delete(tunnel)
            const transports = [...connections]
            for (const [socket] of transports) socket.destroy()
            const closed = new Promise<void>((resolve) =>
              server.close(() => resolve()),
            )
            await Promise.all(transports.map(([, child]) => stop(child)))
            await closed
          })()),
      }
      server.on('error', () => {
        void tunnel.close()
      })
      listeners.add(tunnel)
      if (disposed) {
        await tunnel.close()
        throw new Error('Desktop SSH transport is closed')
      }
      return tunnel
    },
    dispose: async () => {
      disposed = true
      await Promise.all([...listeners].map((t) => t.close()))
      await Promise.all([...children.keys()].map(stop))
    },
  }
}
