import { describe, expect, it } from 'vitest'
import { BROWSER_AUTOMATION_OPERATIONS, EXTERNAL_CHROME_EXTENSION_ID, EXTERNAL_CHROME_MAX_MESSAGE_BYTES, EXTERNAL_CHROME_METHODS, ExternalChromeContractError, parseExternalChromeJsonRpcFrame, type ExternalChromeRequestMethod } from '../index.js'

const operations = BROWSER_AUTOMATION_OPERATIONS.map((operation) => ({
  operation,
  supported: !['resize', 'recordingStart', 'recordingStop'].includes(operation),
  ...(['resize', 'recordingStart', 'recordingStop'].includes(operation) ? { reason: 'unsupported' } : {}),
}))
const hello = {
  jsonrpc: '2.0' as const,
  id: 'hello-1',
  method: 'forge.runtime.hello' as const,
  params: {
    protocol: { min: 1, max: 1 },
    shellAbi: 1,
    payloadVersion: 'runtime-1',
    payloadSha256: 'a'.repeat(64),
    extensionId: EXTERNAL_CHROME_EXTENSION_ID,
    extensionInstanceId: 'instance-1',
    chromeVersion: '125.0.0.0',
    methods: [...EXTERNAL_CHROME_METHODS],
    maxMessageBytes: EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
    operations,
    features: {
      resize: false,
      recording: false,
      downloadEvents: false,
      downloadArtifacts: false,
      downloadOpen: false,
      oopif: true,
      humanInterruption: true,
    },
  },
}
const lease = { protocolVersion: 1 as const, leaseId: 'lease-1', leaseEpoch: 2 }

function parse(value: unknown, expectedResponseMethod?: ExternalChromeRequestMethod) {
  return parseExternalChromeJsonRpcFrame(JSON.stringify(value), {
    protocolVersion: 1,
    ...(expectedResponseMethod ? { expectedResponseMethod } : {}),
  })
}

function expectContractFailure(value: unknown): void {
  expect(() => parse(value)).toThrow(ExternalChromeContractError)
}

describe('External Chrome automatic transport contract', () => {

  it('round-trips strict hello without profile display metadata', () => {
    expect(parse(hello)).toEqual(hello)
    expectContractFailure({ ...hello, params: { ...hello.params, unexpectedMetadata: 'obsolete' } })
    expectContractFailure({ ...hello, params: { ...hello.params, extensionId: 'wrong' } })
    expectContractFailure({ ...hello, params: { ...hello.params, extensionInstanceId: 'not.canonical' } })
    expectContractFailure({ ...hello, params: { ...hello.params, methods: EXTERNAL_CHROME_METHODS.slice(1) } })
  })

  it('rejects unknown methods, IDs on notifications, oversized frames, and non-JSON', () => {
    expectContractFailure({ jsonrpc: '2.0', id: 'x', method: 'forge.browser.enumerate', params: { protocolVersion: 1 } })
    expectContractFailure({ jsonrpc: '2.0', id: 'x', method: 'browser.leaseChanged', params: { ...lease, state: 'released', tabIds: [] } })
    expect(() => parseExternalChromeJsonRpcFrame('{', {})).toThrow(ExternalChromeContractError)
    expect(() => parseExternalChromeJsonRpcFrame(JSON.stringify({ value: 'x'.repeat(EXTERNAL_CHROME_MAX_MESSAGE_BYTES) }), {})).toThrow(ExternalChromeContractError)
  })
})
