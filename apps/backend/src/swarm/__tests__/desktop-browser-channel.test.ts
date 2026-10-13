/** Failure modes: Windows backslashes become a URL authority; the pipe path loses
 * slashes; the Unix transport changes. Parse with the same URL rules ws uses. */
import { expect, it } from 'vitest'
import { desktopCdpEndpoint } from '../browser-automation/desktop-browser-channel.js'
it.each([String.raw`\\.\pipe\forge-cdp-fixture`, '/tmp/forge-cdp-fixture/cdp.sock'])('preserves private socket path %s', pipe => {
  const parsed = new URL(desktopCdpEndpoint(pipe))
  expect(parsed.protocol).toBe('ws+unix:')
  expect(parsed.pathname.split(':')).toEqual([pipe, '/cdp'])
})
