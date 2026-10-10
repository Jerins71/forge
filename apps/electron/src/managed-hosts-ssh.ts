import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createServer, createConnection } from 'node:net'
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
async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (
    server.address() as {
      port: number
    }
  ).port
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  )
  return port
}
export function createOpenSshDriver(): ManagedHostDriver {
  return {
    run: (alias, script, options = {}) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          'ssh',
          [...sshOptions, '-o', 'ClearAllForwardings=yes', alias, 'sh -s'],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
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
            child.kill()
            reject(error)
          } else resolve(output)
        }
        const timer = setTimeout(
          () => finish(new Error('SSH command timed out')),
          options.timeoutMs ?? 60000,
        )
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > maximum)
            finish(new Error('SSH response exceeded its limit'))
          else output += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 8192) stderr += chunk.toString('utf8')
        })
        child.on('error', () =>
          finish(
            new Error(
              'OpenSSH is unavailable. Install the native OpenSSH client.',
            ),
          ),
        )
        child.on('exit', (code) =>
          finish(code === 0 ? undefined : sshFailure(stderr)),
        )
        child.stdin.on('error', () => {})
        child.stdin.end(script)
      }),
    upload: (alias, localFile, remoteFile) =>
      new Promise<void>((resolve, reject) => {
        const command = 'umask 077; cat > ' + shellQuote(remoteFile)
        const child = spawn(
          'ssh',
          [
            ...sshOptions,
            '-o',
            'ClearAllForwardings=yes',
            alias,
            'sh -c ' + shellQuote(command),
          ],
          { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
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
            child.kill()
            reject(error)
          } else resolve()
        }
        const timer = setTimeout(
          () => finish(new Error('SSH artifact upload timed out')),
          300000,
        )
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 8192) stderr += chunk.toString('utf8')
        })
        child.on('error', () => finish(new Error('OpenSSH is unavailable')))
        child.on('exit', (code) =>
          finish(code === 0 ? undefined : sshFailure(stderr)),
        )
        file.on('error', () =>
          finish(new Error('Server artifact could not be read')),
        )
        child.stdin.on('error', () => {})
        file.pipe(child.stdin)
      }),
    tunnel: async (alias, remotePort) => {
      const localPort = await unusedPort()
      const child = spawn(
        'ssh',
        [
          ...sshOptions,
          '-o',
          'ExitOnForwardFailure=yes',
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=3',
          '-N',
          '-L',
          `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          alias,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      )
      let stderr = '',
        ended = false,
        error: Error | undefined
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8')
      })
      const exited = new Promise<void>((resolve) => {
        child.once('error', () => {
          ended = true
          error = new Error('OpenSSH is unavailable')
          resolve()
        })
        child.once('exit', () => {
          ended = true
          error = sshFailure(stderr)
          resolve()
        })
      })
      const close = async () => {
        if (!ended) child.kill()
        await exited
      }
      try {
        const until = Date.now() + 15000
        while (Date.now() < until) {
          if (ended) throw error ?? new Error('SSH tunnel ended')
          const listening = await new Promise<boolean>((resolve) => {
            const socket = createConnection({
              host: '127.0.0.1',
              port: localPort,
            })
            socket.once('connect', () => {
              socket.destroy()
              resolve(true)
            })
            socket.once('error', () => resolve(false))
            socket.setTimeout(200, () => {
              socket.destroy()
              resolve(false)
            })
          })
          if (listening)
            return {
              baseUrl: `http://127.0.0.1:${localPort}`,
              exited,
              close,
            } satisfies ManagedTunnel
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('SSH tunnel did not open its loopback port')
      } catch (e) {
        await close()
        throw e
      }
    },
  }
}
