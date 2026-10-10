// macOS/Linux build driver. Only tracked HEAD is sent to the Linux builder.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile, copyFile, constants } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// Official Node distribution and Debian 12 (glibc 2.36) builder. Extend this map
// with an independently pinned distribution and qualification for future targets.
export const SERVER_TARGETS = Object.freeze({
  'linux-x64': {
    platform: 'linux', arch: 'x64', libc: 'glibc', minimumGlibc: '2.36', nodeVersion: '26.5.0',
    nodeArchiveSha256: '9f619528f1db5ddc41dccf54211066fb42228d69a156733c69cb9d6cc92e358c',
    builderImage: 'node:26.5.0-bookworm@sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271',
    dockerPlatform: 'linux/amd64',
  },
})

export async function run(command, args, { cwd = repoRoot, capture = false, stdout } = {}) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', stdout ?? (capture ? 'pipe' : 'inherit'), 'inherit'] })
  let output = ''
  if (capture) child.stdout.on('data', chunk => { output += chunk })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)))
  })
  return output.trim()
}

export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  const args = process.argv.slice(2)
  let targetName = 'linux-x64'
  let outputDir = path.join(repoRoot, 'apps', 'electron', 'release', 'server')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) targetName = args[++i]
    else if (args[i] === '--output-dir' && args[i + 1]) outputDir = path.resolve(repoRoot, args[++i])
    else throw new Error('Usage: node apps/electron/scripts/build-server.mjs [--target linux-x64] [--output-dir <directory>]')
  }
  const target = SERVER_TARGETS[targetName]
  if (!target) throw new Error(`Unsupported server target: ${targetName}`)
  if (await run('git', ['status', '--porcelain'], { capture: true })) throw new Error('Server artifacts require a clean, committed worktree')
  const gitCommit = await run('git', ['rev-parse', 'HEAD'], { capture: true })
  const gitTimestamp = await run('git', ['show', '-s', '--format=%ct', 'HEAD'], { capture: true })
  const desktop = JSON.parse(await run('git', ['show', `${gitCommit}:apps/electron/package.json`], { capture: true }))
  const version = JSON.parse(await run('git', ['show', `${gitCommit}:version.json`], { capture: true })).version
  if (version !== desktop.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Desktop/app versions must agree and be valid archive versions')
  const pinnedNode = (await run('git', ['show', `${gitCommit}:.nvmrc`], { capture: true })).trim()
  if (pinnedNode !== target.nodeVersion) throw new Error('Server Node pin must match repository .nvmrc; update the target hash and requalify it')
  const name = `forge-server-${version}-${targetName}`
  await mkdir(outputDir, { recursive: true })
  for (const suffix of ['.tar.gz', '.tar.gz.sha256', '.smoke.json']) {
    if (await access(path.join(outputDir, name + suffix)).then(() => true, () => false)) throw new Error(`Refusing to overwrite immutable output: ${name + suffix}`)
  }
  // Repository-local scratch is inside the directories shared by macOS Docker
  // runtimes; it is ignored and never includes live application state.
  await mkdir(path.join(repoRoot, '.internal'), { recursive: true })
  const scratch = await mkdtemp(path.join(repoRoot, '.internal', 'server-build-'))
  try {
    await mkdir(path.join(scratch, 'output'))
    const archive = path.join(scratch, 'source.tar')
    await run('git', ['archive', '--format=tar', `--output=${archive}`, gitCommit])
    const nodeArchive = `node-v${target.nodeVersion}-${targetName}.tar.xz`
    await run('curl', ['--fail', '--location', '--silent', '--show-error', '--output', path.join(scratch, nodeArchive), `https://nodejs.org/dist/v${target.nodeVersion}/${nodeArchive}`])
    if (await sha256(path.join(scratch, nodeArchive)) !== target.nodeArchiveSha256) throw new Error('Official Node download checksum mismatch')
    await writeFile(path.join(scratch, 'build.json'), JSON.stringify({ ...target, version, gitCommit, gitTimestamp: Number(gitTimestamp), name, nodeArchive }))
    // Source snapshot is read-only; dependencies/build outputs use the private
    // filesystem. No host node_modules, .env, auth, session data, or SSH is mounted.
    await run('docker', ['run', '--rm', '--platform', target.dockerPlatform,
      '--mount', `type=bind,source=${scratch},target=/input,readonly`,
      '--mount', `type=bind,source=${path.join(scratch, 'output')},target=/output`,
      target.builderImage, 'bash', '-c', 'mkdir /source && tar -xf /input/source.tar -C /source && exec bash /source/apps/electron/scripts/build-server-linux.sh'])
    // COPYFILE_EXCL protects the versioned output from competing builds too.
    for (const suffix of ['.tar.gz', '.tar.gz.sha256', '.smoke.json']) {
      await copyFile(path.join(scratch, 'output', name + suffix), path.join(outputDir, name + suffix), constants.COPYFILE_EXCL)
    }
    console.log(`[server/build] ${path.join(outputDir, name + '.tar.gz')}`)
    console.log(`[server/build] sha256 ${await sha256(path.join(outputDir, name + '.tar.gz'))}`)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
