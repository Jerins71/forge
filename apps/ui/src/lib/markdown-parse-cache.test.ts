// Ways the parse cache can fail: a later render reads a tree an earlier render changed (raw HTML,
// URL rewriting and GFM all run after parsing); text it has seen is parsed again; different text
// returns another text's tree.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { remarkCachedParse } from './markdown-parse-cache'

let parses = 0
function countParses(this: { parser?: (document: string, file: unknown) => unknown }) {
  const parse = this.parser!
  this.parser = (document, file) => { parses += 1; return parse(document, file) }
}

const content = [
  '# Title', '', 'A [link](javascript:alert(1)) and <b>raw</b> html.', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '', '- [x] done', '', 'Note[^1]', '', '[^1]: Footnote.', '',
  '```ts', 'const x = 1', '```',
].join('\n')

const render = (text: string, plugins: unknown[]) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: plugins as never }, text))

describe('cached markdown parsing', () => {
  it('renders seen text identically without parsing it again', () => {
    const fresh = render(content, [remarkGfm])
    parses = 0
    const plugins = [remarkGfm, countParses, remarkCachedParse]
    expect(render(content, plugins)).toBe(fresh)
    expect(render(content, plugins)).toBe(fresh)
    expect(render(content, plugins)).toBe(fresh)
    expect(parses).toBe(1)
  })

  it('parses different text separately', () => {
    const plugins = [remarkGfm, remarkCachedParse]
    expect(render('first *one*', plugins)).toBe('<p>first <em>one</em></p>')
    expect(render('second **two**', plugins)).toBe('<p>second <strong>two</strong></p>')
    expect(render('first *one*', plugins)).toBe('<p>first <em>one</em></p>')
  })
})
