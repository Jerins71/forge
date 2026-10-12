// Cases are the result texts real workers produced in Live QA. The environment wraps a worker's reply
// as `status: …` / `summary:` and the reply often carries its own report or markdown. Ways this fails:
//  - a second "status" line (the worker's own, or markdown such as `**Status:** ok`) replaces the
//    first, the status no longer parses, and the card loses its chip and shows raw `status:` lines;
//  - a nested `- status:` / `- summary:` report is drawn as raw field lines;
//  - bold labels, a blank line or a heading before the fields, or markdown right after them, are lost.
import { expect, it } from 'vitest'
import { parseWorkerReport } from './worker-report'

const RAW_FIELD = /^\s*(?:[-*]\s*)?\**(status|summary|changed|verified|risks|follow[- ]?up)\**\s*:/im

it('keeps the chip when the worker reply carries its own markdown "Status:" line (md-echo)', () => {
  const report = parseWorkerReport('status: done\nsummary:\n**Status:** ok\n\n- **alpha** one\n- **beta** two\n- **gamma** three')
  expect(report).toMatchObject({ status: 'done', details: [] })
  // `ok` is not a report status, so the worker's line stays as its markdown, not as a field.
  expect(report!.summary).toBe('**Status:** ok\n\n- **alpha** one\n- **beta** two\n- **gamma** three')
})

it('reads a nested `- status:` report inside the summary as the report itself (readme-lines-2)', () => {
  const report = parseWorkerReport([
    'status: done', 'summary:', '- status: done',
    '- summary: README.md has 3 lines, according to `wc -l`.',
    '- changed: none',
    '- verified: Ran `wc -l /private/tmp/forge-live-qa/README.md`, which output `3`.',
    "- risks: `wc -l` counts newline characters, so a last line without one isn't counted.",
  ].join('\n'))
  expect(report).toEqual({
    status: 'done', summary: 'README.md has 3 lines, according to `wc -l`.',
    details: [
      { label: 'verified', value: 'Ran `wc -l /private/tmp/forge-live-qa/README.md`, which output `3`.' },
      { label: 'risks', value: "`wc -l` counts newline characters, so a last line without one isn't counted." },
    ],
  })
})

it('keeps markdown before a nested report and nested lists under an unknown label (readme-line-counter-3, math-reviewer-3)', () => {
  const counter = parseWorkerReport('status: done\nsummary:\n**3**\n\n- status: done\n- summary: I counted the lines with `wc -l`. It reported 3 lines.\n- changed: none\n- risks: none')
  expect(counter).toMatchObject({ status: 'done', summary: '**3**\n\nI counted the lines with `wc -l`. It reported 3 lines.', details: [] })
  const reviewer = parseWorkerReport([
    'status: done', 'summary:', '- status: done', '- summary: Reviewed math.js read-only. Two issues found, one minor.',
    '- findings:', '  - Line 2: `mean([])` returns `NaN`.', '  - Line 1: `add` does no type checking.',
    '- changed: none', '- verified: file read only; no edits made', '- risks: no',
  ].join('\n'))
  expect(reviewer!.summary).toBe('Reviewed math.js read-only. Two issues found, one minor.\n- findings:\n  - Line 2: `mean([])` returns `NaN`.\n  - Line 1: `add` does no type checking.')
  expect(reviewer!.details).toEqual([{ label: 'verified', value: 'file read only; no edits made' }, { label: 'risks', value: 'no' }])
})

it('joins a second report the worker appended after its summary (math-reviewer-4)', () => {
  const report = parseWorkerReport('status: done\nsummary:\n- **Bug:** `mean([])` divides by zero.\n\nstatus: done\nsummary: Reviewed src/math.js read-only.')
  expect(report).toMatchObject({ status: 'done', summary: '- **Bug:** `mean([])` divides by zero.\n\nReviewed src/math.js read-only.' })
})

it('reads bold labels, a heading or blank line before the fields, and markdown that follows directly', () => {
  const report = parseWorkerReport('## Result\n\n**Status:** done\n**Summary:** Counted lines.\n- **alpha** one\n**Risks**: none')
  expect(report).toEqual({ status: 'done', summary: '## Result\n\nCounted lines.\n- **alpha** one', details: [] })
  expect(parseWorkerReport('- **status**: **Blocked**\n- summary: Needs a key.')).toMatchObject({ status: 'blocked', summary: 'Needs a key.' })
})

it('reads the plain shape and a failure unchanged (spawn-test, ok-fast-builder)', () => {
  expect(parseWorkerReport('status: done\nsummary: Branch is main.\nchanged: none\nverified: ran git log -1\nrisks: none')).toEqual({
    status: 'done', summary: 'Branch is main.', details: [{ label: 'verified', value: 'ran git log -1' }],
  })
  expect(parseWorkerReport('status: blocked\nsummary:\n⚠️ Worker reply failed: xai/grok-4.6 API error (426).')).toMatchObject({ status: 'blocked', summary: '⚠️ Worker reply failed: xai/grok-4.6 API error (426).' })
})

it('never leaves a raw field line in what it shows, and returns null for free-form results', () => {
  for (const text of [
    'status: done\nsummary:\n- status: done\n- summary: OK\n- changed: none\n- verified: No tools used.\n- risks: none',
    'status: done\nsummary:\n**Status:** done\n\n- item',
  ]) {
    const report = parseWorkerReport(text)!
    expect(report.status).toBe('done')
    expect([report.summary, ...report.details.map(d => d.value)].join('\n')).not.toMatch(RAW_FIELD)
  }
  expect(parseWorkerReport('Just a note.\n- one')).toBeNull()
})
