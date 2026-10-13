import { BrowserEngine } from '../../../apps/backend/src/swarm/browser-automation/browser-engine.js'
import { DesktopBrowserChannel } from '../../../apps/backend/src/swarm/browser-automation/desktop-browser-channel.js'
import type { BrowserAutomationOperation, BrowserAutomationInputByOperation } from '@forge/protocol'
const engine = new BrowserEngine({ dataDir: process.env.FORGE_DATA_DIR!, resolveSession: id => id === 'session' ? 'project' : undefined, desktop: new DesktopBrowserChannel(true) })
process.on('message', raw => {
  if (!raw || typeof raw !== 'object' || (raw as { type?: string }).type !== 'fixture:browser:call') return
  const input = raw as { requestId: string; method: string; params: { operation: BrowserAutomationOperation; input: BrowserAutomationInputByOperation[BrowserAutomationOperation]; url?: string } }
  const work = input.method === 'cookie-proof' ? engine.withCookieContext('session', async context => { await context.addCookies([{ name: 'native-fixture', value: 'synthetic-native-cookie', domain: 'native.example.test', path: '/', expires: Date.now() / 1000 + 3600 }]); return (await context.cookies()).map(cookie => cookie.name) }) : input.method === 'open' ? engine.open('session', input.params) : input.method === 'snapshot' ? engine.getSnapshot('session') : input.method === 'shutdown' ? engine.shutdown() : engine.invoke('session', 'project', input.params.operation, input.params.input)
  void work.then(value => process.send?.({ type: 'fixture:browser:result', requestId: input.requestId, value }), error => process.send?.({ type: 'fixture:browser:result', requestId: input.requestId, error: error.message }))
})
process.send?.({ type: 'fixture:browser:ready' })
