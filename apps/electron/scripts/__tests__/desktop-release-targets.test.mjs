import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('exact-SHA Windows release dispatch', () => {
  const workflowPath = path.join(repoRoot, '.github/workflows/electron-build.yml')
  const bashStep = (workflow, name) => {
    const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0]
    const script = step?.split('        run: |\n')[1]
    if (!script) throw new Error(`Missing executable workflow step: ${name}`)
    return script.split('\n').map((line) => line.replace(/^          /, '')).join('\n')
  }

  it('rejects missing, malformed, uppercase or drifted dispatch SHA before checkout/install/build', async () => {
    const workflow = await readFile(workflowPath, 'utf8')
    const script = bashStep(workflow, 'Validate release event SHA')
    const sha = 'a'.repeat(40)
    for (const expected of ['', 'bad', 'A'.repeat(40), 'b'.repeat(40)]) {
      const result = spawnSync('bash', ['-c', script], {
        cwd: repoRoot,
        env: { ...process.env, EVENT_NAME: 'workflow_dispatch', EVENT_SHA: sha, EXPECTED_SHA: expected },
      })
      expect(result.status, expected).not.toBe(0)
    }
    for (const event of ['workflow_dispatch', 'push']) {
      const result = spawnSync('bash', ['-c', script], {
        cwd: repoRoot,
        env: { ...process.env, EVENT_NAME: event, EVENT_SHA: sha, EXPECTED_SHA: event === 'push' ? '' : sha },
      })
      expect(result.status).toBe(0)
    }
    expect(workflow).toContain('expected_sha:')
    expect(workflow).toContain('ref: ${{ github.sha }}')
    expect(workflow.indexOf('Validate release event SHA')).toBeLessThan(workflow.indexOf('Checkout exact event SHA'))
    expect(workflow.indexOf('Assert checked-out SHA')).toBeLessThan(workflow.indexOf('Install dependencies'))
    expect(workflow).not.toContain('name: Build workspace')
    expect(workflow).toContain('pnpm package:electron')
  })

  it('asserts the actual checkout instead of merely trusting the input', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forge-workflow-sha-'))
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
        return result.stdout.trim()
      }
      git('init')
      git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
      const sha = git('rev-parse', 'HEAD')
      const script = bashStep(await readFile(workflowPath, 'utf8'), 'Assert checked-out SHA')
      for (const expected of [sha, 'b'.repeat(40)]) {
        const result = spawnSync('bash', ['-c', script], { cwd: root, env: { ...process.env, EVENT_SHA: expected } })
        expect(result.status === 0).toBe(expected === sha)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
