// Pairing in the built UI against real backends: a running environment issues a link from the CLI with
// no restart; a revoked or lost credential leaves the environment listed as "Needs re-pairing" and
// Re-pair keeps its name; an environment is named after its machine's hostname by default; and the
// "Let another device use this machine" panel warns about a loopback-only address.
//   pnpm exec playwright test scripts/environment-e2e/pairing.spec.ts --config scripts/environment-e2e/playwright.config.ts
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, sanitizedEnvironment, type BootstrapSession, type FleetManifest } from './launch.js'
import { openUiFleet, type UiEnvironment, type UiFleet } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce } from './fixtures/rpc-client.js'

const evidenceRoot = join(repositoryRoot, '.internal/pairing')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let manifestPath: string
let context: BrowserContext
let sharedPage: Page
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'pairing', screenshot: 'off', actionTimeout: 10_000 })

const fixture = (environment: UiEnvironment) => manifest.environments.find(value => value.baseUrl === environment.baseUrl)!
const row = (page: Page, environment: UiEnvironment) => page.locator(`li[data-environment-status][data-environment-id="${environment.environmentId}"]`)
async function shot(page: Page, name: string) {
  const path = join(evidenceRoot, `${name}.png`)
  await page.screenshot({ path, fullPage: true }); assertions[`screenshot:${name}`] = path
}
async function openSettings(page: Page) {
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=environments`)
  await expect(page.getByRole('list', { name: 'Environments' })).toBeVisible()
}
/** `forge pair-link` run on the environment's machine, as the owner of its data directory. */
async function cliPairLink(environment: UiEnvironment, ...args: string[]) {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(repositoryRoot, 'packages/cli/dist/cli.js'), 'pair-link', '--data-dir', fixture(environment).dataDir, ...args], { env: sanitizedEnvironment() })
  return { link: stdout.trim(), stderr }
}
async function pairByLink(page: Page, link: string) {
  await page.getByRole('button', { name: 'Add a machine' }).click()
  await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(link)
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(page.getByTestId('pairing-success')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
}
async function rePair(page: Page, environment: UiEnvironment, link: string) {
  await row(page, environment).getByRole('button', { name: 'Re-pair' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(link)
  await shot(page, `re-pair-dialog-${fixture(environment).name}`)
  await dialog.getByRole('button', { name: 'Re-pair', exact: true }).click()
  await expect(page.getByTestId('pairing-success')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(row(page, environment)).toHaveAttribute('data-environment-status', 'online')
}

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  manifestPath = environmentManifest
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

test('a running environment issues a pairing link from its CLI with no restart, and the link pairs', async ({ page }) => {
  const { b } = fleet
  const pidBefore = fixture(b).pid
  const { link, stderr } = await cliPairLink(b)
  expect(link).toMatch(new RegExp(`^${b.baseUrl.replaceAll('.', '\\.')}/pair#v=1&environmentId=${b.environmentId}&grantId=`))
  expect(stderr).toMatch(/expires in 10 minutes/)
  expect(stderr).toMatch(/only works on this machine/)
  await openSettings(page)
  await pairByLink(page, link)
  await expect(row(page, b)).toHaveAttribute('data-environment-status', 'online')
  // The same backend process served the link and the pairing.
  const after = (await readManifest(manifestPath)).environments.find(value => value.baseUrl === b.baseUrl)!
  expect(after.pid).toBe(pidBefore)
  expect(() => process.kill(pidBefore, 0)).not.toThrow()
  await shot(page, 'cli-link-paired')
  assertions.cliLink = { environmentId: b.environmentId, pid: pidBefore, restarted: false }
})

test('an environment is named after its machine\'s hostname by default, with its address under the name', async ({ page }) => {
  const { c } = fleet
  const expected = hostname().trim().split('.')[0]!
  const { link } = await cliPairLink(c, '--scopes', 'session:read,session:operate,workspace:read,workspace:write,terminal:operate,access:admin')
  await openSettings(page)
  await pairByLink(page, link)
  await expect(row(page, c)).toHaveAttribute('data-environment-status', 'online')
  await expect(row(page, c).getByTestId('environment-name')).toHaveText(expected)
  await expect(row(page, c)).toContainText(new URL(c.baseUrl).host)
  await shot(page, 'default-hostname-name')
  assertions.defaultName = { environmentId: c.environmentId, label: expected }
})

test('a revoked credential leaves the environment listed as Needs re-pairing, and Re-pair keeps its name', async ({ page }) => {
  const { b } = fleet
  await openSettings(page)
  await row(page, b).getByRole('button', { name: `Rename ${b.label}` }).click()
  await page.getByRole('textbox', { name: 'Environment name' }).fill('Build box')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(row(page, b)).toContainText('Build box')
  // The machine's owner revokes every device but its own fixture administrator.
  const admin = await controlEnvironment<BootstrapSession>(manifest, fixture(b).name, 'bootstrap')
  const devices = await fixtureRpcOnce(b.baseUrl, admin, 'access.devices.list', {}) as { deviceSessionId: string; revokedAt: string | null }[]
  for (const device of devices.filter(device => !device.revokedAt && device.deviceSessionId !== admin.deviceSession?.deviceSessionId))
    await fixtureRpcOnce(b.baseUrl, admin, 'access.devices.revoke', { deviceSessionId: device.deviceSessionId })
  await expect(row(page, b)).toHaveAttribute('data-environment-status', 'revoked', { timeout: 15_000 })
  await expect(row(page, b)).toContainText('Needs re-pairing')
  await expect(row(page, b)).toContainText('Build box')
  await shot(page, 'needs-re-pairing-revoked')
  // A link for another environment is refused before it is spent.
  await row(page, b).getByRole('button', { name: 'Re-pair' }).click()
  await page.getByRole('dialog').getByRole('textbox', { name: 'Pairing link', exact: true }).fill((await fleet.mintGrant(fleet.c, 'link')).pairingUrl!)
  await page.getByRole('dialog').getByRole('button', { name: 'Re-pair', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('different environment')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await rePair(page, b, (await cliPairLink(b)).link)
  await expect(row(page, b)).toContainText('Build box')
  await page.reload()
  await expect(row(page, b)).toHaveAttribute('data-environment-status', 'online')
  await expect(row(page, b)).toContainText('Build box')
  assertions.revokedRePair = { environmentId: b.environmentId, keptName: 'Build box' }
})

test('a lost credential keeps the environment listed as Needs re-pairing after a reload, and Re-pair restores it', async ({ page }) => {
  const { b } = fleet
  await openSettings(page)
  // Desktop main forgets the stored credential (for example, an OS keychain reset).
  await page.evaluate(async (environmentId) => {
    await fetch('/__forge_e2e_platform', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'remove', input: { environmentId } }) })
  }, b.environmentId)
  await page.reload()
  await expect(page.getByRole('list', { name: 'Environments' })).toBeVisible()
  await expect(row(page, b)).toHaveAttribute('data-environment-status', 'needs-pairing', { timeout: 15_000 })
  await expect(row(page, b)).toContainText('Needs re-pairing')
  await expect(row(page, b)).toContainText('Build box')
  await shot(page, 'needs-re-pairing-lost')
  await rePair(page, b, (await cliPairLink(b)).link)
  await expect(row(page, b)).toContainText('Build box')
  assertions.lostRePair = { environmentId: b.environmentId, keptName: 'Build box' }
})

test('the pairing panel warns that a loopback address only works on that machine, and names the machine it shares', async ({ page }) => {
  const { a, c } = fleet
  await openSettings(page)
  await expect(page.getByText('Let another device use this machine', { exact: true })).toBeVisible()
  await expect(page.getByTestId('pairing-address')).toHaveText(a.baseUrl)
  await expect(page.getByTestId('pairing-loopback-warning')).toContainText(`${a.baseUrl} only works on this machine itself`)
  await expect(page.getByTestId('pairing-loopback-warning')).toContainText('--tailscale-serve')
  await page.getByTestId('pairing-loopback-warning').scrollIntoViewIfNeeded()
  await shot(page, 'loopback-warning-this-machine')
  await page.getByLabel('Machine to share').click()
  const cLabel = hostname().trim().split('.')[0]!
  await page.getByRole('option', { name: cLabel }).click()
  await expect(page.getByText(`Let another device use ${cLabel}`, { exact: true })).toBeVisible()
  await expect(page.getByText(`pairs a phone, laptop or browser with ${cLabel}, the machine chosen here, not with this app`)).toBeVisible()
  // The address C's links name (from C, or this app's address for it when C does not let this device manage pairing).
  await expect(page.getByTestId('pairing-address')).toHaveText(c.baseUrl)
  await expect(page.getByTestId('pairing-loopback-warning')).toContainText(`only works on ${cLabel} itself`)
  await page.getByTestId('pairing-loopback-warning').scrollIntoViewIfNeeded()
  await shot(page, 'loopback-warning-remote')
  expect(renderErrors).toEqual([])
  assertions.loopbackWarning = { primary: a.baseUrl, remote: c.baseUrl }
})
