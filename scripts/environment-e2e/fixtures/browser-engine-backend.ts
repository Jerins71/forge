import { BrowserEngine } from '../../../apps/backend/src/swarm/browser-automation/browser-engine.js'
import { DesktopBrowserChannel } from '../../../apps/backend/src/swarm/browser-automation/desktop-browser-channel.js'
import type { BrowserAutomationOperation, BrowserAutomationInputByOperation } from '@forge/protocol'
const engine = new BrowserEngine({ dataDir: process.env.FORGE_DATA_DIR!, resolveSession: id => id === 'session' ? 'project' : undefined, desktop: new DesktopBrowserChannel(true) })
process.on('message', raw => {
  if (!raw || typeof raw !== 'object' || (raw as { type?: string }).type !== 'fixture:browser:call') return
  const input = raw as { requestId: string; method: string; params: { operation: BrowserAutomationOperation; input: BrowserAutomationInputByOperation[BrowserAutomationOperation]; url?: string; tabId?: string } }
  const castProof = async () => {
    let done!: (value: { width: number; height: number }) => void, failed!: (error: Error) => void
    const frame = new Promise<{ width: number; height: number }>((resolve, reject) => { done = resolve; failed = reject })
    const timer = setTimeout(() => failed(new Error('Unpresented native tab did not emit a screencast frame.')), 5000)
    const cast = await engine.screencast('session', input.params.tabId!, {}, item => { if (item.kind === 'frame') done({ width: item.width, height: item.height }) })
    try { return await frame } finally { clearTimeout(timer); await cast.release() }
  }
  const work = input.method === 'cast-proof' ? castProof() : input.method === 'cookie-proof' ? engine.withCookieContext('session', async context => { await context.addCookies([{ name: 'native-fixture', value: 'synthetic-native-cookie', domain: 'native.example.test', path: '/', expires: Date.now() / 1000 + 3600 }]); return (await context.cookies()).map(cookie => cookie.name) }) : input.method === 'open' ? engine.open('session', input.params) : input.method === 'snapshot' ? engine.getSnapshot('session') : input.method === 'shutdown' ? engine.shutdown() : engine.invoke('session', 'project', input.params.operation, input.params.input)
  void work.then(value => process.send?.({ type: 'fixture:browser:result', requestId: input.requestId, value }), error => process.send?.({ type: 'fixture:browser:result', requestId: input.requestId, error: error.message }))
})
process.send?.({ type: 'fixture:browser:ready' })
