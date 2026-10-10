// Archive E2E: run with the extracted artifact's Node, never the host's Node.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runStagedNativeRuntimeSmoke } from './staged-native-runtime-smoke.mjs'

export async function smokeServerArtifact(install, reportPath, port = 47787) {
  const manifest = JSON.parse(await readFile(path.join(install, 'manifest.json'), 'utf8'))
  assert.equal(process.platform, manifest.platform)
  assert.equal(process.arch, manifest.arch)
  assert.equal(process.versions.node, manifest.node.version)
  assert.equal(process.execPath, path.join(install, 'node', 'bin', 'node'))
  assert.equal(createHash('sha256').update(await readFile(process.execPath)).digest('hex'), manifest.node.sha256)
  assert.ok(process.report.getReport().header.glibcVersionRuntime)
  const native = await runStagedNativeRuntimeSmoke(path.join(install, 'backend', 'node_modules'))
  const require = createRequire(path.join(install, 'backend', 'package.json'))
  // These packages belong to the staged backend's dependency tree, not Electron.
  for (const [packageName, exportName] of [['@anthropic-ai/claude-agent-sdk', 'query'], ['@cursor/sdk', 'Agent']]) {
    const loaded = await import(pathToFileURL(require.resolve(packageName)).href)
    assert.ok(loaded[exportName] ?? loaded.default?.[exportName], `${packageName} runtime export missing`)
  }
  for (const asset of [
    'forge-resources/apps/backend/src/swarm/archetypes/builtins',
    'forge-resources/apps/backend/src/swarm/operational',
    'forge-resources/apps/backend/src/swarm/specialists/builtins',
    'forge-resources/apps/backend/src/swarm/skills/builtins/brave-search/node_modules/jsdom',
    'forge-resources/apps/backend/src/swarm/secure-sessions/execution/Dockerfile.secure-runner',
    'forge-resources/apps/backend/src/swarm/secure-sessions/execution/forge-env-askpass',
    'forge-resources/apps/backend/static',
  ]) await access(path.join(install, asset))
  const scratch = await mkdtemp(path.join(tmpdir(), 'forge-server-smoke-'))
  const home = path.join(scratch, 'home')
  await mkdir(home)
  const env = {
    // Deliberately omit host credentials, Forge overrides, and system Node from PATH.
    HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
  }
  const base = `http://127.0.0.1:${port}`
  let child
  let log = ''
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try {
      const [code] = await exited
      assert.equal(code, 0, 'foreground CLI/backend must stop gracefully on SIGTERM')
    } finally { clearTimeout(timeout) }
    await assert.rejects(fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }))
  }
  const start = async () => {
    child = spawn(path.join(install, 'bin', 'forge'), ['serve', '--port', String(port), '--data-dir', path.join(scratch, 'data')], {
      cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Forge exited before ready (${child.exitCode}): ${log.slice(-6000)}`)
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) return response.json()
      } catch { /* Bounded startup polling. */ }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Forge did not become ready: ${log.slice(-6000)}`)
  }
  try {
    // Refuse to start over an existing listener, even in a scratch-data smoke.
    await assert.rejects(fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }))
    const health = await start()
    const response = await fetch(`${base}/api/v2/environment`)
    assert.equal(response.status, 200)
    const environment = await response.json()
    assert.equal(environment.platform.os, 'linux')
    assert.equal(environment.platform.arch, 'x64')
    assert.equal(environment.forgeVersion, manifest.version)
    assert.ok(environment.environmentId)
    await stop()
    const restartedHealth = await start()
    const restartedEnvironment = await (await fetch(`${base}/api/v2/environment`)).json()
    assert.equal(restartedEnvironment.environmentId, environment.environmentId)
    await stop()
    const report = { manifest, native, port, health, environment, restartedHealth, identityPreserved: true, gracefulStop: true, scratchCleaned: true }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    try { await stop() } finally { await rm(scratch, { recursive: true, force: true }) }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [install, report, port] = process.argv.slice(2)
  assert.ok(install && report, 'Usage: <install>/node/bin/node server-artifact-smoke.mjs <install> <report.json> [port]')
  console.log(JSON.stringify(await smokeServerArtifact(path.resolve(install), path.resolve(report), port ? Number(port) : undefined), null, 2))
}
