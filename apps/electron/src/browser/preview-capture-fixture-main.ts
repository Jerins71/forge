import { app, BrowserWindow, WebContentsView } from 'electron'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const root = process.env.FORGE_BROWSER_PREVIEW_FIXTURE_ROOT
if (!root) throw new Error('FORGE_BROWSER_PREVIEW_FIXTURE_ROOT is required')
mkdirSync(root, { recursive: true })
app.setPath('userData', path.join(root, 'electron-user-data'))
app.on('window-all-closed', () => { /* fixture owns explicit teardown */ })

const html = `<!doctype html><html><head><title>Preview capture fixture</title><style>html,body{margin:0;width:100%;height:100%;background:#123}#pulse{width:50%;height:50%;background:#4af}</style></head><body><div id="pulse"></div><script>window.__step=0;window.__advance=()=>{window.__step+=1;document.querySelector('#pulse').style.background=window.__step%2?'#fa4':'#4af';document.body.dataset.step=String(window.__step);return window.__step}</script></body></html>`
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('Preview fixture server did not bind'))
      else resolve(address.port)
    })
  })
}

void app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end(html)
  })
  const port = await listen(server)
  const main = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const popout = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const cover = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const guest = view.webContents
  const guestId = guest.id
  const bounds = { x: 20, y: 30, width: 800, height: 600 }
  let owner: 'main' | 'popout' | 'detached' = 'main'
  let expectedVisible = true
  const results: Array<Record<string, unknown>> = []

  const capture = async (label: string): Promise<Buffer> => {
    const before = {
      owner,
      focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      bounds: view.getBounds(),
      minimized: owner === 'main' ? main.isMinimized() : owner === 'popout' ? popout.isMinimized() : false,
      documentVisibility: await guest.executeJavaScript('document.visibilityState'),
    }
    const started = performance.now()
    const image = await guest.capturePage(undefined, { stayHidden: true })
    const durationMs = performance.now() - started
    const after = {
      owner,
      focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      bounds: view.getBounds(),
      minimized: owner === 'main' ? main.isMinimized() : owner === 'popout' ? popout.isMinimized() : false,
      documentVisibility: await guest.executeJavaScript('document.visibilityState'),
    }
    const size = image.getSize()
    const bytes = image.isEmpty() ? Buffer.alloc(0) : image.toPNG()
    const stable = guest.id === guestId && owner === before.owner
      && JSON.stringify(before.bounds) === JSON.stringify(after.bounds)
      && before.focusedWindowId === after.focusedWindowId
      && before.minimized === after.minimized
      && (!expectedVisible ? after.documentVisibility !== 'visible' : true)
    results.push({ label, owner, expectedVisible, empty: image.isEmpty(), width: size.width, height: size.height, pngBytes: bytes.byteLength, durationMs, before, after, stable })
    if (!stable) throw new Error(`${label} capture changed source presentation: ${JSON.stringify(results.at(-1))}`)
    return bytes
  }

  let report: Record<string, unknown> = { passed: false }
  try {
    await Promise.all([
      main.loadURL('data:text/html,<title>Preview fixture main</title>'),
      popout.loadURL('data:text/html,<title>Preview fixture popout</title>'),
      cover.loadURL('data:text/html,<body style="background:#000"></body>'),
    ])
    main.contentView.addChildView(view)
    view.setBounds(bounds)
    view.setVisible(true)
    main.show()
    await guest.loadURL(`http://127.0.0.1:${port}/fixture`)
    const attachedBefore = await capture('attached-presented-before')
    await guest.executeJavaScript('window.__advance()')
    await delay(80)
    const attachedAfter = await capture('attached-presented-after')

    main.contentView.removeChildView(view)
    owner = 'detached'
    expectedVisible = false
    await delay(100)
    await capture('detached')

    main.contentView.addChildView(view)
    owner = 'main'
    view.setBounds(bounds)
    view.setVisible(false)
    await delay(100)
    await capture('attached-hidden')
    view.setVisible(true)
    expectedVisible = true

    main.minimize()
    await delay(100)
    const remainedMinimized = main.isMinimized()
    await capture('owner-minimized')
    if (remainedMinimized) main.restore()
    await delay(100)

    cover.setBounds(main.getBounds())
    cover.show()
    await capture('owner-occluded')
    cover.hide()

    main.contentView.removeChildView(view)
    popout.contentView.addChildView(view)
    owner = 'popout'
    view.setBounds(bounds)
    view.setVisible(true)
    popout.show()
    const popoutBytes = await capture('popout-presented')

    const allStable = results.every((result) => result.stable === true)
    const presentedNonempty = attachedBefore.byteLength > 0 && attachedAfter.byteLength > 0 && popoutBytes.byteLength > 0
    const animatedPixelsChanged = !attachedBefore.equals(attachedAfter)
    const passed = allStable && presentedNonempty && animatedPixelsChanged && guest.id === guestId
    report = {
      passed,
      platform: process.platform,
      electron: process.versions.electron,
      guestId,
      allStable,
      presentedNonempty,
      animatedPixelsChanged,
      cases: results,
    }
    if (!passed) throw new Error(`Preview fixture assertions failed: ${JSON.stringify(report)}`)
  } catch (error) {
    report = { ...report, passed: false, error: error instanceof Error ? error.stack : String(error), cases: results }
  } finally {
    if (owner === 'main') main.contentView.removeChildView(view)
    if (owner === 'popout') popout.contentView.removeChildView(view)
    if (!guest.isDestroyed()) guest.close()
    for (const window of [cover, popout, main]) if (!window.isDestroyed()) window.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    process.stdout.write(`FORGE_BROWSER_PREVIEW_FIXTURE_RESULT=${JSON.stringify(report)}\n`)
    app.exit(report.passed === true ? 0 : 1)
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
