/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MermaidBlock } from './MermaidBlock'

let root: Root
let container: HTMLDivElement
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  })
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  document.documentElement.classList.remove('dark')
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const [key, descriptor] of [
    ['createObjectURL', originalCreateObjectURL],
    ['revokeObjectURL', originalRevokeObjectURL],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(URL, key, descriptor)
    } else {
      Reflect.deleteProperty(URL, key)
    }
  }
})

function renderMermaid(code: string) {
  flushSync(() => {
    root.render(createElement(MermaidBlock, { code }))
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

function getInlineIframe(): HTMLIFrameElement {
  const iframe = container.querySelector('iframe[title="Mermaid diagram preview"]')
  expect(iframe).toBeTruthy()
  return iframe as HTMLIFrameElement
}

function attachContentWindow(iframe: HTMLIFrameElement) {
  const contentWindow = {
    postMessage: vi.fn(),
  } as unknown as Window

  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: contentWindow,
  })

  return contentWindow
}

function getInstanceId(iframe: HTMLIFrameElement): string {
  const src = iframe.getAttribute('src')
  expect(src).toBeTruthy()
  const url = new URL(src!, 'http://localhost')
  const instanceId = url.searchParams.get('instanceId')
  expect(instanceId).toBeTruthy()
  return instanceId!
}

function dispatchFrameMessage(contentWindow: Window, data: Record<string, unknown>) {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', {
    configurable: true,
    value: contentWindow,
  })

  act(() => {
    window.dispatchEvent(event)
  })
}

function getLatestPostedMessage(contentWindow: Window) {
  const calls = vi.mocked(contentWindow.postMessage).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls.at(-1)?.[0] as Record<string, unknown>
}

describe('MermaidBlock', () => {
  it('ignores bridge messages from the wrong source or instance', async () => {
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    dispatchFrameMessage(
      { postMessage: vi.fn() } as unknown as Window,
      {
        type: 'forge:mermaid-ready',
        instanceId,
      },
    )
    await flush()
    expect(vi.mocked(contentWindow.postMessage).mock.calls.length).toBe(0)

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    const renderMessage = getLatestPostedMessage(contentWindow)
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-rendered',
      instanceId: `${instanceId}-other`,
      requestId: renderMessage.requestId as string,
      height: 300,
    })
    await flush()

    expect(container.querySelector('[aria-label="Download SVG"]')).toBeNull()
  })

})
