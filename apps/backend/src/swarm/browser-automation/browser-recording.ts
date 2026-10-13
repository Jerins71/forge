import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdir, readdir, stat, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { getBrowserRuntimeDir } from '../storage/data-paths.js'
let installation: Promise<string> | undefined
/** The pinned Playwright package pins its small FFmpeg distribution too. Keep it
 * beside Forge's own browser runtime rather than a user's Playwright cache. */
async function ffmpeg(dataDir: string): Promise<string> {
  const root = join(getBrowserRuntimeDir(dataDir), 'media')
  const find = async () => {
    const directories = await readdir(root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error })
    const directory = directories.find(value => /^ffmpeg-\d+$/.test(value)); if (!directory) return undefined
    const files = await readdir(join(root, directory)); const name = files.find(value => /^ffmpeg-(mac|linux|win)/.test(value) && !value.endsWith('.zip')); return name ? join(root, directory, name) : undefined
  }
  const installed = await find(); if (installed) return installed
  if (installation) return installation
  installation = (async () => {
    const cli = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js')
    const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA)$/i
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)))
    const child = spawn(process.execPath, [cli, 'install', 'ffmpeg'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: root }, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Browser recording encoder could not be installed. Retry recording.'))) })
    const path = await find(); if (!path) throw new Error('Browser recording encoder is missing.'); return path
  })().finally(() => { installation = undefined })
  return installation
}
export class BrowserRecording {
  private frames = 0
  private failure?: Error
  private readonly finished: Promise<void>
  private constructor(readonly path: string, private readonly encoder: ChildProcessWithoutNullStreams) {
    encoder.stderr.resume(); encoder.stdout.resume()
    this.finished = new Promise((resolve, reject) => { encoder.once('error', reject); encoder.once('exit', code => code === 0 ? resolve() : reject(new Error('Browser recording encoder failed.'))) }); this.finished.catch(error => { this.failure = error })
    encoder.stdin.on('error', error => { this.failure = error })
  }
  static async start(dataDir: string, path: string, width: number, height: number) {
    const executable = await ffmpeg(dataDir); await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const encoder = spawn(executable, ['-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', '10', '-i', 'pipe:0', '-vf', `scale=${width}:${height}`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '5', '-b:v', '1M', '-f', 'webm', '-y', path], { stdio: 'pipe', windowsHide: true })
    return new BrowserRecording(path, encoder)
  }
  async frame(jpeg: string) { if (this.failure) throw this.failure; if (++this.frames > 18000) throw new Error('Browser recording reached its 30-minute frame budget.'); if (!this.encoder.stdin.write(Buffer.from(jpeg, 'base64'))) await once(this.encoder.stdin, 'drain') }
  async stop() { this.encoder.stdin.end(); await this.finished; const metadata = await stat(this.path); if (!metadata.size || !this.frames) { await rm(this.path, { force: true }); throw new Error('Browser recording did not contain any frames.') } return metadata.size }
}
