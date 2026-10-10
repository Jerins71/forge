import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
  children: [] as ChildProcess[],
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  mocked.spawn.mockImplementation(
    (_command: string, args: string[], options: object) => {
      const bridge = args.includes('-W')
      const script = bridge
        ? `let body='';process.stdin.on('data',b=>{body+=b;if(body.includes('\\r\\n\\r\\n')){process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\n\\r\\nowned');body=''}})`
        : `let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{if(body.includes('# stay'))setInterval(()=>{},1000);else process.exit(0)})`
      const child = actual.spawn(process.execPath, ['-e', script], options)
      mocked.children.push(child)
      return child
    },
  )
  return { ...actual, spawn: mocked.spawn }
})
import { createOpenSshDriver } from '../managed-hosts-ssh.js'
const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  for (const child of mocked.children.splice(0)) child.kill('SIGKILL')
  mocked.spawn.mockClear()
})
it('holds the Desktop loopback listener continuously and bridges only through strict SSH -W', async () => {
  const driver = createOpenSshDriver()
  const tunnel = await driver.tunnel('fixture', 47788)
  cleanup.push(() => tunnel.close())
  const competitor = createServer()
  cleanup.push(() => competitor.close())
  await expect(
    new Promise<void>((resolve, reject) => {
      competitor.once('error', reject)
      competitor.listen(
        Number(new URL(tunnel.baseUrl).port),
        '127.0.0.1',
        resolve,
      )
    }),
  ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  expect(
    await (
      await fetch(tunnel.baseUrl, {
        headers: { Authorization: 'Bearer synthetic-test-bearer' },
      })
    ).text(),
  ).toBe('owned')
  const args = mocked.spawn.mock.calls.map((c) => c[1] as string[])
  expect(
    args.some(
      (a) =>
        a.includes('-W') &&
        a.includes('127.0.0.1:47788') &&
        a.includes('StrictHostKeyChecking=yes'),
    ),
  ).toBe(true)
  expect(args.some((a) => a.includes('-L') || a.includes('-N'))).toBe(false)
})
it('driver disposal terminates command and socket children and prevents late spawn', async () => {
  const driver = createOpenSshDriver()
  const running = driver.run('fixture', '# stay\n').catch(() => undefined)
  const tunnel = await driver.tunnel('fixture', 47788)
  cleanup.push(() => tunnel.close())
  await fetch(tunnel.baseUrl)
  await (driver as typeof driver & { dispose(): Promise<void> }).dispose()
  await running
  expect(
    mocked.children.every((c) => c.exitCode !== null || c.signalCode !== null),
  ).toBe(true)
  const count = mocked.spawn.mock.calls.length
  await expect(driver.tunnel('fixture', 47788)).rejects.toThrow(/closed/i)
  expect(mocked.spawn.mock.calls.length).toBe(count)
})
