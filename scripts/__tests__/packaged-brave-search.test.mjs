import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stageBraveSearchDependencies } from '../../apps/electron/scripts/build-all.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const skillRelative = 'apps/backend/src/swarm/skills/builtins/brave-search'
const sourceSkill = path.join(repoRoot, skillRelative)
const html = '<html><head><title>Packaged article fixture</title></head><body><article>' +
  '<h1>Packaged article fixture</h1>' +
  Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}. This deterministic article checks packaged content extraction without contacting a remote service. The library should preserve meaningful content and readable formatting for this local fixture.</p>`).join('') +
  '<p><a href="https://bücher.example/article">Example reference</a></p>' +
  '<p><del>obsolete text</del></p></article></body></html>'
const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
let root
let stagedSkill

function runScript(script, args = []) {
  // No inherited module search overrides, API keys, preload hooks, or profiles.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP'].includes(key.toUpperCase()),
  ))
  const result = spawnSync(process.execPath, ['--no-global-search-paths', path.join(stagedSkill, script), ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

describe('packaged Brave Search dependency closure', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'forge-brave-stage-')))
    expect(root.startsWith(`${repoRoot}${path.sep}`)).toBe(false)
    // Fail rather than let an ambient ancestor node_modules mask an incomplete stage.
    for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
      await expect(readdir(path.join(ancestor, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (ancestor === path.dirname(ancestor)) break
    }
    stagedSkill = path.join(root, 'forge-resources', skillRelative)
    await cp(sourceSkill, stagedSkill, {
      recursive: true,
      filter: (source) => !path.relative(sourceSkill, source).split(path.sep).includes('node_modules'),
    })
    await stageBraveSearchDependencies(stagedSkill)
  }, 30_000)

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('runs the actual content CLI on fixture HTML, including Unicode links and GFM', () => {
    const result = runScript('content.js', [dataUrl])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('# Packaged article fixture')
    expect(result.stdout).toContain('Paragraph 7')
    expect(result.stdout).toContain('https://xn--bcher-kva.example/article')
    expect(result.stdout).toContain('~obsolete text~')
  })
})
