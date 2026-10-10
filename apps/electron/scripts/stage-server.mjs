// Internal Linux builder: called only after a fresh target-platform install.
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stageBundledBackend, stageBackendResources, stageCliArtifact } from './build-all.mjs'
import { run, sha256 } from './build-server.mjs'

const config = JSON.parse(await readFile('/input/build.json', 'utf8'))
assert.equal(process.platform, config.platform)
assert.equal(process.arch, config.arch)
assert.equal(process.versions.node, config.nodeVersion)
assert.ok(process.report.getReport().header.glibcVersionRuntime)
const stage = path.join('/tmp/forge-server-stage', config.name)
await mkdir(stage, { recursive: true })
await stageBundledBackend({ outputDir: path.join(stage, 'backend'), nativeRuntime: 'node' })
await stageBackendResources(path.join(stage, 'forge-resources'))
await stageCliArtifact(path.join(stage, 'cli'))
await mkdir(path.join(stage, 'node', 'bin'), { recursive: true })
await cp('/runtime/bin/node', path.join(stage, 'node', 'bin', 'node'))
await cp('/runtime/LICENSE', path.join(stage, 'node', 'LICENSE'))
await cp('/build/LICENSE', path.join(stage, 'LICENSE'))
await cp('/build/THIRD_PARTY_NOTICES.md', path.join(stage, 'THIRD_PARTY_NOTICES.md'))
await rm(path.join(stage, 'backend', 'dist', 'index.meta.json'))
const manifest = {
  version: config.version, gitCommit: config.gitCommit,
  platform: config.platform, arch: config.arch, libc: config.libc, minimumGlibc: config.minimumGlibc,
  node: { version: config.nodeVersion, sha256: await sha256(path.join(stage, 'node', 'bin', 'node')), archiveSha256: config.nodeArchiveSha256 },
}
await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await mkdir(path.join(stage, 'bin'))
await writeFile(path.join(stage, 'bin', 'forge'), `#!/bin/sh
set -eu
install_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PATH="$install_dir/node/bin:$PATH"
export FORGE_RESOURCES_DIR="$install_dir/forge-resources"
export FORGE_APP_VERSION=${config.version}
export NODE_ENV=production
if [ "\${1:-}" = serve ]; then
  shift
  cd "$install_dir/forge-resources"
  exec "$install_dir/node/bin/node" "$install_dir/cli/cli.js" serve --backend-entry "$install_dir/backend/dist/index.mjs" "$@"
fi
exec "$install_dir/node/bin/node" "$install_dir/cli/cli.js" "$@"
`, { mode: 0o755 })
// GNU tar + gzip normalize archive metadata; installation never runs a package manager.
const archive = path.join('/output', config.name + '.tar.gz')
await run('tar', ['--sort=name', `--mtime=@${config.gitTimestamp}`, '--owner=0', '--group=0', '--numeric-owner', '-cf', '/tmp/forge-server.tar', '-C', path.dirname(stage), config.name])
await run('bash', ['-c', 'gzip -n -9 < /tmp/forge-server.tar > "$1"', 'server-gzip', archive])
await writeFile(archive + '.sha256', `${await sha256(archive)}  ${path.basename(archive)}\n`)
// Verify the actual archive after extraction at another path, with bundled Node.
await mkdir('/tmp/forge-server-extracted')
await run('tar', ['-xzf', archive, '-C', '/tmp/forge-server-extracted'])
const install = path.join('/tmp/forge-server-extracted', config.name)
await run(path.join(install, 'node', 'bin', 'node'), [
  '/build/apps/electron/scripts/server-artifact-smoke.mjs', install,
  path.join('/output', config.name + '.smoke.json'),
])
console.log(`[server/stage] manifest ${JSON.stringify(manifest)}`)
