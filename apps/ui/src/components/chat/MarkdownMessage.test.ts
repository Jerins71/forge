import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MarkdownMessage } from './MarkdownMessage'

function renderMarkdownMessage(props: Parameters<typeof MarkdownMessage>[0]) {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(MarkdownMessage, props)),
  )
}

let mountedRoot: Root | null = null
let previousWindow: typeof globalThis.window | undefined
let previousDocument: typeof globalThis.document | undefined
let previousNavigator: typeof globalThis.navigator | undefined

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount())
    mountedRoot = null
  }

  if (previousWindow) {
    globalThis.window = previousWindow
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }

  if (previousDocument) {
    globalThis.document = previousDocument
  } else {
    Reflect.deleteProperty(globalThis, 'document')
  }

  if (previousNavigator) {
    globalThis.navigator = previousNavigator
  } else {
    Reflect.deleteProperty(globalThis, 'navigator')
  }

  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

describe('MarkdownMessage', () => {
  it('renders common markdown formatting for speak_to_user content', () => {
    const content = [
      'Visit [example](https://example.com).',
      '',
      'Use `pnpm test`.',
      '',
      '```ts',
      'console.log("hello")',
      '```',
      '',
      '- alpha',
      '- beta',
      '',
      'This is **bold** and *italic*.',
    ].join('\n')

    const html = renderMarkdownMessage({ content })

    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('>pnpm test</code>')
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('<ul class="mb-2 list-disc space-y-0.5 pl-5')
    expect(html).toContain('<strong class="font-semibold')
    expect(html).toContain('<em class="italic">italic</em>')
  })

  it('keeps raw HTML escaped and sanitizes javascript links', () => {
    const content = ['[xss](javascript:alert(1))', '', '<script>alert("x")</script>'].join('\n')

    const html = renderMarkdownMessage({ content })

    expect(html).not.toContain('href="javascript:alert(1)"')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

})
