import { expect, it } from 'vitest'
import { normalizeBaseUrl } from '../connection/authenticated-http.js'

it('accepts plain HTTP environments on LAN and Tailscale addresses, as Forge 1 did', () => {
  expect(normalizeBaseUrl('http://192.168.1.58:47287')).toBe('http://192.168.1.58:47287')
  expect(normalizeBaseUrl('http://dev1.tailnet.ts.net:47287/')).toBe('http://dev1.tailnet.ts.net:47287')
  expect(() => normalizeBaseUrl('http://user:pw@dev1.test')).toThrow()
})
