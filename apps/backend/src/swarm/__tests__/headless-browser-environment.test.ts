/** Failure modes: provider keys reach the page process; loader overrides (LD_*) steer the binary that
 * holds Linux's userns exception; a needed display or locale variable is dropped. */
import { afterEach, expect, it } from 'vitest'
import { browserEnvironment } from '../browser-automation/headless-browser.js'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

it('passes display and locale through, never credentials or dynamic-loader overrides', () => {
  Object.assign(process.env, {
    PATH: '/usr/bin', DISPLAY: ':0', LANG: 'en_US.UTF-8',
    LD_LIBRARY_PATH: '/tmp/evil', LD_PRELOAD: '/tmp/evil.so', OPENAI_API_KEY: 'synthetic', ANTHROPIC_API_KEY: 'synthetic',
  })
  const env = browserEnvironment()
  expect(env).toMatchObject({ PATH: '/usr/bin', DISPLAY: ':0', LANG: 'en_US.UTF-8' })
  for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) expect(env).not.toHaveProperty(key)
})
