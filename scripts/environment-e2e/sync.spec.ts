// Configuration sync across paired environments, driven by the built UI as the hub:
//   - turning sync on for A, B and C settles their first sync without conflicts;
//   - a worker preset changed on A appears on B and C; a shared project's manager memory written on A
//     appears on B, while C (another repository) shows that project as local only;
//   - editing the presets on A and on B while B is offline is one visible conflict with both versions,
//     settled with "Keep A", and B's replaced version is kept in its sync history;
//   - "Ask an agent to resolve" starts a session on this machine, and the merged file written there
//     resolves the conflict on every environment;
//   - nothing outside the allowlist (secrets, auth) is ever copied.
//   VITE_FORGE_E2E_PLATFORM=1 pnpm --filter @forge/ui build
//   pnpm exec playwright test scripts/environment-e2e/sync.spec.ts --config scripts/environment-e2e/playwright.config.ts
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { SessionSummary } from '@forge/protocol/environment-v2'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type BootstrapSession, type FleetManifest } from './launch.js'
import { openUiFleet, type UiFleet } from './fixtures/ui-fleet.js'
import { openFixtureRpc, until } from './fixtures/rpc-client.js'

const evidenceRoot = join(repositoryRoot, '.internal/sync')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let context: BrowserContext
let sharedPage: Page
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'sync', screenshot: 'off', actionTimeout: 10_000 })

const PRESETS = 'shared/config/worker-presets.json'
const dataDir = (index: number) => manifest.environments[index]!.dataDir
const read = (index: number, rel: string) => readFile(join(dataDir(index), rel), 'utf8').catch(() => null)
async function write(index: number, rel: string, content: string) {
  await mkdir(dirname(join(dataDir(index), rel)), { recursive: true })
  await writeFile(join(dataDir(index), rel), content)
}
const presets = (names: string[]) => `${JSON.stringify({ version: 2, presets: names.map((name) => ({ name, provider: 'codex-native', modelId: 'gpt-6-sol', reasoningLevel: 'high' })) }, null, 2)}\n`
async function shot(page: Page, name: string, focus?: Locator) {
  const path = join(evidenceRoot, `${name}.png`)
  if (focus) { await focus.scrollIntoViewIfNeeded(); await focus.screenshot({ path }) }
  else await page.screenshot({ path })
  assertions[`screenshot:${name}`] = path
}
const syncNow = (page: Page) => page.getByRole('button', { name: 'Sync now' }).click()

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  manifest = await readManifest(environmentManifest)
  fleet = await openUiFleet(environmentManifest)
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => renderErrors.push(error.message))
})
test.afterAll(async () => {
  assertions.renderErrors = renderErrors
  await writeFile(join(evidenceRoot, 'assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await context?.close(); await fleet?.dispose()
})
test.afterEach(() => { expect(renderErrors).toEqual([]) })

test('turning sync on settles the first sync without conflicts', async ({ page }) => {
  // A secret on A must never travel.
  await write(0, 'shared/config/secrets.json', '{"FIXTURE_SECRET":"never-synced"}\n')
  // The browser reaches B and C once they are paired.
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=environments`)
  for (const environment of [fleet.b, fleet.c]) {
    const link = await fleet.mintGrant(environment, 'link')
    await page.getByRole('button', { name: 'Add environment' }).click()
    await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(link.pairingUrl!)
    await page.getByRole('button', { name: 'Pair', exact: true }).click()
    await expect(page.getByTestId('pairing-success')).toContainText(environment.label)
    await page.getByRole('button', { name: 'Done' }).click()
  }
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=sync`)
  await expect(page.getByTestId('settings-sync')).toBeVisible()
  await shot(page, '01-sync-off')
  await page.getByRole('switch', { name: 'Sync configuration' }).click()
  for (const environment of [fleet.a, fleet.b, fleet.c]) await page.getByRole('checkbox', { name: `Sync ${environment.label}` }).check()
  await syncNow(page)
  await expect(page.getByTestId('sync-status')).toContainText('Up to date', { timeout: 30_000 })
  await expect(page.getByTestId('sync-conflict')).toHaveCount(0)
  expect(await read(1, 'shared/config/secrets.json')).toBeNull()
  expect(await read(2, 'shared/config/secrets.json')).toBeNull()
  assertions.firstSync = { presetsEqual: (await read(0, PRESETS)) === (await read(1, PRESETS)) }
})

test('a preset changed on A appears on B and C; shared project memory reaches B only', async ({ page }) => {
  await write(0, PRESETS, presets(['fixture-worker', 'reviewer']))
  const memory = `profiles/${fleet.a.sessionId}/sessions/${fleet.a.sessionId}/memory.md`
  await write(0, memory, '# Manager memory\n- Remember: deploys need a changelog entry.\n')
  await syncNow(page)
  await expect.poll(() => read(1, PRESETS), { timeout: 30_000 }).toBe(presets(['fixture-worker', 'reviewer']))
  await expect.poll(() => read(2, PRESETS), { timeout: 30_000 }).toBe(presets(['fixture-worker', 'reviewer']))
  await expect.poll(() => read(1, memory), { timeout: 30_000 }).toContain('changelog entry')
  // C holds another repository, so its project is local only and gets nothing from A's project.
  expect(await read(2, memory)).not.toContain('changelog entry')
  await expect(page.getByRole('list', { name: 'Local-only projects' })).toContainText(fleet.c.projectTitle)
  await expect(page.getByRole('list', { name: 'Recent sync changes' })).toContainText('Worker presets')
  await shot(page, '02-synced')
  // The Worker presets screen on B shows the preset made on A.
  assertions.presetOnB = (await read(1, PRESETS))?.includes('reviewer')
})

test('edits on both sides while B is offline become a conflict that "Keep A" settles', async ({ page }) => {
  await fleet.stop(fleet.b)
  await write(0, PRESETS, presets(['fixture-worker', 'reviewer', 'from-a']))
  await syncNow(page)
  await expect.poll(() => read(2, PRESETS), { timeout: 30_000 }).toContain('from-a')
  await write(1, PRESETS, presets(['fixture-worker', 'reviewer', 'from-b']))
  await fleet.start(fleet.b)
  await expect.poll(async () => { await syncNow(page); return page.getByTestId('sync-conflict').count() }, { timeout: 60_000, intervals: [2_000] }).toBe(1)
  const conflict = page.getByTestId('sync-conflict')
  await expect(conflict).toContainText('Worker presets')
  await conflict.getByRole('button', { name: /Compare/ }).click()
  // One column per distinct version: A and C agree, B differs.
  await expect(conflict.getByTestId('sync-conflict-version')).toHaveCount(2)
  await expect(conflict.getByTestId('sync-conflict-version').first()).toContainText(`${fleet.a.label} · ${fleet.c.label}`)
  await expect(conflict).toContainText('from-a')
  await expect(conflict).toContainText('from-b')
  // Both versions stay untouched while the conflict is open.
  expect(await read(0, PRESETS)).toContain('from-a')
  expect(await read(1, PRESETS)).toContain('from-b')
  await shot(page, '03-conflict')
  await shot(page, '03b-conflict-compare', page.locator('section').filter({ has: conflict }))
  await conflict.getByRole('button', { name: `Keep ${fleet.a.label}` }).click()
  await expect(page.getByTestId('sync-conflict')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => read(1, PRESETS)).toContain('from-a')
  // B's own edit is kept in its sync history.
  const history = join(dataDir(1), 'shared/state/sync/history')
  const kept = await Promise.all((await readdir(history)).map((dir) => readFile(join(history, dir, 'global/worker-presets.json'), 'utf8').catch(() => '')))
  expect(kept.some((text) => text.includes('from-b'))).toBe(true)
  assertions.keepA = { bHistoryKeepsFromB: true }
})

test('"Ask an agent to resolve" starts a session here, and its merge resolves the conflict everywhere', async ({ page }) => {
  await fleet.stop(fleet.b)
  await write(0, PRESETS, presets(['fixture-worker', 'reviewer', 'from-a', 'second-a']))
  await syncNow(page)
  await expect.poll(() => read(2, PRESETS), { timeout: 30_000 }).toContain('second-a')
  await write(1, PRESETS, presets(['fixture-worker', 'reviewer', 'from-a', 'second-b']))
  await fleet.start(fleet.b)
  await expect.poll(async () => { await syncNow(page); return page.getByTestId('sync-conflict').count() }, { timeout: 60_000, intervals: [2_000] }).toBe(1)
  await page.getByTestId('sync-conflict').getByRole('button', { name: 'Ask an agent to resolve' }).click()
  await expect(page.getByTestId('sync-conflict').getByRole('status')).toContainText(`An agent is merging this on ${fleet.a.label}`, { timeout: 30_000 })
  await shot(page, '04-agent-asked', page.locator('section').filter({ has: page.getByTestId('sync-conflict') }))
  const admin = await controlEnvironment<BootstrapSession>(manifest, manifest.environments[0]!.name, 'bootstrap')
  const rpc = await openFixtureRpc(fleet.a.baseUrl, admin)
  try {
    await rpc.call('shell.subscribe', {})
    const snapshot = await until<{ sessions: SessionSummary[] } | undefined>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean)
    expect(snapshot!.sessions.some((s) => s.title.startsWith('Resolve sync conflict: Worker presets'))).toBe(true)
  } finally { rpc.close() }
  // The scripted provider cannot edit files, so the agent's merge is written as it would be.
  const merged = presets(['fixture-worker', 'reviewer', 'from-a', 'second-a', 'second-b'])
  await write(0, PRESETS, merged)
  await syncNow(page)
  await expect(page.getByTestId('sync-conflict')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => read(1, PRESETS), { timeout: 30_000 }).toBe(merged)
  await expect.poll(() => read(2, PRESETS), { timeout: 30_000 }).toBe(merged)
  await shot(page, '05-resolved')
  expect(await read(1, 'shared/config/secrets.json')).toBeNull()
})

test('a file over the size cap is listed as not synced instead of disappearing', async ({ page }) => {
  await write(0, 'skills/big-skill/SKILL.md', '# Big skill\n')
  await write(0, 'skills/big-skill/model.bin', 'x'.repeat(2 * 1024 * 1024 + 1))
  await syncNow(page)
  await expect.poll(() => read(1, 'skills/big-skill/SKILL.md'), { timeout: 30_000 }).toBe('# Big skill\n')
  const skipped = page.getByRole('list', { name: 'Files not synced' })
  await expect(skipped).toContainText('model.bin')
  await expect(skipped).toContainText('Larger than 2 MB')
  await expect(page.getByTestId('sync-status')).toContainText('1 file skipped')
  expect(await read(1, 'skills/big-skill/model.bin')).toBeNull()
  await shot(page, '06-not-synced', page.locator('section').filter({ has: skipped }))
})

test('History restores a replaced version on its machine, and it syncs out like an edit', async ({ page }) => {
  // B's presets were replaced by the agent's merge; its own version before that is in B's history.
  const before = presets(['fixture-worker', 'reviewer', 'from-a', 'second-b'])
  await expect(page.getByRole('list', { name: 'Sync history' })).toBeVisible({ timeout: 30_000 })
  await shot(page, '07-history', page.locator('section').filter({ has: page.getByRole('list', { name: 'Sync history' }) }))
  await page.getByRole('button', { name: new RegExp(`^Restore Worker presets on ${fleet.b.label} `) }).first().click()
  await expect(page.getByRole('list', { name: 'Sync history' }).locator('..').getByRole('status')).toContainText(`Restored Worker presets on ${fleet.b.label}`)
  await expect.poll(() => read(1, PRESETS), { timeout: 30_000 }).toBe(before)
  await expect.poll(() => read(0, PRESETS), { timeout: 30_000 }).toBe(before)
  await expect.poll(() => read(2, PRESETS), { timeout: 30_000 }).toBe(before)
  await expect(page.getByTestId('sync-conflict')).toHaveCount(0)
})

test('with two windows open only one syncs, and Sync now in the other takes over', async ({ page }) => {
  const second = await context.newPage()
  second.on('pageerror', error => renderErrors.push(error.message))
  try {
    await second.goto(`${fleet.uiUrl}/?view=settings&settingsTab=sync`)
    // The first window holds the hub lease, so the second defers on its own passes.
    await expect(second.getByTestId('sync-status')).toContainText('Another open Forge window is syncing', { timeout: 30_000 })
    await shot(second, '08-second-window-defers', second.getByTestId('settings-sync').locator('section').first())
    await second.getByRole('button', { name: 'Sync now' }).click()
    await expect(second.getByTestId('sync-status')).toContainText('Last synced', { timeout: 30_000 })
    // The first window now defers on its next timed pass.
    await expect(page.getByTestId('sync-status')).toContainText('Another open Forge window is syncing', { timeout: 30_000 })
    // Changes still flow through the window that holds the lease.
    await write(0, PRESETS, presets(['fixture-worker', 'after-handover']))
    await second.getByRole('button', { name: 'Sync now' }).click()
    await expect.poll(() => read(1, PRESETS), { timeout: 30_000 }).toBe(presets(['fixture-worker', 'after-handover']))
  } finally {
    await second.close()
  }
})
