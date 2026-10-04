/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ArtifactReference } from '@/lib/artifacts'
import { ArtifactPanel } from './ArtifactPanel'

const pdfPreviewProps: Array<Record<string, unknown>> = []

vi.mock('@/components/file-browser/PdfPreview', () => ({
  PdfPreview: (props: Record<string, unknown>) => {
    pdfPreviewProps.push(props)
    return createElement('div', { 'data-testid': 'pdf-preview' })
  },
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  pdfPreviewProps.length = 0
  Reflect.deleteProperty(window, 'electronBridge')
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

function renderPanel(artifact: ArtifactReference) {
  act(() => {
    root.render(createElement(
      TooltipProvider,
      null,
      createElement(ArtifactPanel, {
        artifact,
        wsUrl: 'wss://forge.example.test/socket?origin=remote',
        activeAgentId: 'fallback-manager',
        onClose: vi.fn(),
      }),
    ))
  })
}

function imageArtifact(overrides: Partial<ArtifactReference> = {}): ArtifactReference {
  return {
    path: '/tmp/result.png',
    fileName: 'result.png',
    href: 'swarm-file:///tmp/result.png',
    sourceAgentId: 'actor-worker',
    transcriptAgentId: 'viewed-manager',
    messageId: 'message-7',
    ...overrides,
  }
}

describe('ArtifactPanel transcript-authorized reads', () => {
  it('rejects an uninspected cross-origin image ticket URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: '/tmp/result.png', binary: true, transport: 'http_ticket', contentType: 'image/png', totalBytes: 4,
      ticket: { url: 'https://attacker.example/image', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    }), { status: 200 })))
    renderPanel(imageArtifact())
    await waitFor(() => expect(document.body.textContent).toContain('Invalid image ticket response.'))
    expect(document.querySelector('img[alt="result.png"]')).toBeNull()
  })

})

function htmlArtifact(overrides: Partial<ArtifactReference> = {}): ArtifactReference {
  return {
    path: '/Users/adam/reports/dashboard.html',
    fileName: 'dashboard.html',
    href: 'swarm-file:///Users/adam/reports/dashboard.html',
    sourceAgentId: 'actor-worker',
    transcriptAgentId: 'viewed-manager',
    messageId: 'message-7',
    ...overrides,
  }
}

describe('ArtifactPanel HTML artifacts', () => {
  const html = '<!doctype html><html><body><h1>Quarterly dashboard</h1><script>document.title = "x"</script></body></html>'

  function stubHtmlRead() {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      path: '/Users/adam/reports/dashboard.html', contentType: 'text/html; charset=utf-8', content: html, truncated: false, totalBytes: html.length,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('renders the page in an opaque-origin sandboxed frame instead of raw source', async () => {
    const fetchMock = stubHtmlRead()
    renderPanel(htmlArtifact())

    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="dashboard.html"]')
      expect(element).not.toBeNull()
      return element!
    })
    expect(frame.getAttribute('srcdoc')).toBe(html)
    const sandbox = frame.getAttribute('sandbox')?.split(/\s+/) ?? []
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(document.querySelector('pre code')).toBeNull()
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ previewBytes: 2 * 1024 * 1024 })
  })

})
