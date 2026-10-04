import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { getManagedClaudeRuntimeDir } from "../../storage/data-paths.js";
import { compareVersions, isPlainVersion, parseVersion } from "./versions.js";

/**
 * Forge bundles Claude Code's native binary through the Agent SDK's platform package.
 * The bundled copy lives inside the signed app, so updates install the same official
 * package, verified against npm's integrity hash, into a per-version folder in the
 * data directory. Running sessions keep their binary; new sessions pick the newest
 * copy the bundled SDK can drive (same major.minor).
 */
export interface ClaudeRuntime {
  executable: string;
  version: string;
}
export interface ClaudeRuntimeSelection extends ClaudeRuntime {
  source: "bundled" | "managed";
}

const REGISTRY = "https://registry.npmjs.org";
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MAX_TARBALL_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const STALE_PARTIAL_MS = 60 * 60_000;

const executableName = (platform: NodeJS.Platform) => platform === "win32" ? "claude.exe" : "claude";

function platformPackage(platform: NodeJS.Platform, arch: string): string {
  const musl = platform === "linux" && platform === process.platform
    && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
  return `${SDK_PACKAGE}-${platform}-${arch}${musl ? "-musl" : ""}`;
}

/** The binary shipped with Forge, and the Claude Code version its SDK was built against. */
export async function bundledClaudeRuntime(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Promise<ClaudeRuntime> {
  // The SDK does not export package.json; its entry point sits at the package root.
  const sdkEntry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
  const sdk = JSON.parse(await readFile(join(dirname(sdkEntry), "package.json"), "utf8")) as { claudeCodeVersion?: string };
  const manifest = createRequire(sdkEntry).resolve(`${platformPackage(platform, arch)}/package.json`);
  if (!sdk.claudeCodeVersion || !parseVersion(sdk.claudeCodeVersion)) throw new Error("The bundled Claude Agent SDK does not declare its Claude Code version.");
  return { executable: join(dirname(manifest), executableName(platform)), version: sdk.claudeCodeVersion };
}

/** A managed copy must be newer than, and protocol-compatible with, the bundled SDK. */
export function isCompatibleClaudeVersion(bundledVersion: string, candidate: string): boolean {
  const [bundled, next] = [parseVersion(bundledVersion), parseVersion(candidate)];
  return Boolean(bundled && next && bundled[0] === next[0] && bundled[1] === next[1] && compareVersions(candidate, bundledVersion) > 0);
}

export async function selectClaudeRuntime(
  dataDir: string | undefined,
  bundled: ClaudeRuntime,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeRuntimeSelection> {
  if (!dataDir) return { ...bundled, source: "bundled" };
  const dir = getManagedClaudeRuntimeDir(dataDir);
  const versions = (await readdir(dir).catch(() => [] as string[]))
    .filter(name => isPlainVersion(name) && isCompatibleClaudeVersion(bundled.version, name))
    .sort((a, b) => compareVersions(b, a));
  for (const version of versions) {
    const executable = join(dir, version, executableName(platform));
    if ((await stat(executable).catch(() => null))?.isFile()) return { executable, version, source: "managed" };
  }
  return { ...bundled, source: "bundled" };
}

/** Latest published SDK and the Claude Code version its platform packages carry. */
export async function fetchLatestClaudeRuntime(fetchImpl: typeof fetch = fetch): Promise<{ sdkVersion: string; version: string } | null> {
  try {
    const response = await fetchImpl(`${REGISTRY}/${SDK_PACKAGE.replace("/", "%2f")}/latest`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown; claudeCodeVersion?: unknown };
    return typeof body.version === "string" && typeof body.claudeCodeVersion === "string" && isPlainVersion(body.claudeCodeVersion)
      ? { sdkVersion: body.version, version: body.claudeCodeVersion }
      : null;
  } catch {
    return null;
  }
}

export async function installManagedClaudeRuntime(options: {
  dataDir: string;
  sdkVersion: string;
  /** The Claude Code version the downloaded binary must report. */
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeRuntimeSelection> {
  const platform = options.platform ?? process.platform;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!isPlainVersion(options.version) || !/^[\w.-]+$/.test(options.sdkVersion)) throw new Error("Invalid Claude runtime version.");
  const pkg = platformPackage(platform, options.arch ?? process.arch);

  const metadata = await fetchImpl(`${REGISTRY}/${pkg.replace("/", "%2f")}/${options.sdkVersion}`, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000),
  });
  if (!metadata.ok) throw new Error(`npm has no ${pkg}@${options.sdkVersion} (HTTP ${metadata.status}).`);
  const { dist } = await metadata.json() as { dist?: { tarball?: unknown; integrity?: unknown } };
  const tarball = typeof dist?.tarball === "string" ? dist.tarball : "";
  const integrity = typeof dist?.integrity === "string" ? /^sha512-([A-Za-z0-9+/=]+)$/.exec(dist.integrity)?.[1] : undefined;
  if (!tarball.startsWith(`${REGISTRY}/`) || !integrity) throw new Error(`npm returned unusable package metadata for ${pkg}.`);

  const dir = getManagedClaudeRuntimeDir(options.dataDir);
  const partial = join(dir, `.partial-${options.version}-${randomUUID()}`);
  await mkdir(partial, { recursive: true });
  try {
    const archive = join(partial, "package.tgz");
    const digest = await download(fetchImpl, tarball, archive);
    if (digest !== integrity) throw new Error(`The downloaded ${pkg} did not match npm's integrity hash.`);

    const executable = join(partial, executableName(platform));
    if (!await extractTarEntry(archive, `package/${executableName(platform)}`, executable)) {
      throw new Error(`${pkg}@${options.sdkVersion} does not contain the Claude native binary.`);
    }
    await rm(archive);
    if (platform !== "win32") await chmod(executable, 0o755);
    const reported = await claudeVersion(executable);
    if (reported !== options.version) {
      throw new Error(`The downloaded Claude runtime reports ${reported ?? "no version"}, expected ${options.version}.`);
    }

    const target = join(dir, options.version);
    // A complete folder of the same version (a concurrent install) is equally valid.
    // eslint-disable-next-line no-restricted-syntax -- publishes a verified directory, not a temp+rename content write
    await rename(partial, target).catch(async (error: NodeJS.ErrnoException) => {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code ?? "") || await claudeVersion(join(target, executableName(platform))) !== options.version) throw error;
    });
    return { executable: join(target, executableName(platform)), version: options.version, source: "managed" };
  } finally {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Remove superseded downloads. A copy still running on Windows cannot be deleted;
 * that failure is ignored and retried after the next update.
 */
export async function pruneManagedClaudeRuntimes(dataDir: string, keepVersion: string): Promise<void> {
  const dir = getManagedClaudeRuntimeDir(dataDir);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name === keepVersion) continue;
    // A recent partial may be another Forge process's install in flight.
    const stale = name.startsWith(".partial-")
      && Date.now() - ((await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? Date.now()) > STALE_PARTIAL_MS;
    if (isPlainVersion(name) || stale) {
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function claudeVersion(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(executable, ["--version"], { env, timeout: 15_000, windowsHide: true });
    return /^(\d+\.\d+\.\d+)\b/.exec(stdout.trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

async function download(fetchImpl: typeof fetch, url: string, file: string): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
  const hash = createHash("sha512");
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > MAX_TARBALL_BYTES) throw new Error("The Claude runtime download is unexpectedly large.");
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
  return hash.digest("base64");
}

/** Stream one regular file out of a .tgz without buffering the archive. */
export async function extractTarEntry(archive: string, entryName: string, destination: string): Promise<boolean> {
  let pending = Buffer.alloc(0);
  let skip = 0;
  let out: WriteStream | null = null;
  let remaining = 0;
  let longName: string | null = null;
  let captureLongName: Buffer[] | null = null;
  const file = createReadStream(archive);
  const source = file.pipe(createGunzip());
  // Every stream error must reject this call; an unheard 'error' event would crash the backend.
  let writeError = null as Error | null; // Assigned from stream callbacks.
  file.once("error", error => source.destroy(error));
  const openOutput = () => {
    const stream = createWriteStream(destination, { flags: "wx", mode: 0o700 });
    stream.on("error", error => { writeError ??= error; source.destroy(error); });
    return stream;
  };
  // Wait for "close" so the handle is released before the binary is executed or moved (Windows).
  const closeOutput = async (stream: WriteStream) => {
    stream.end();
    if (!stream.closed) await once(stream, "close");
    if (writeError) throw writeError;
    return true;
  };
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      let data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      pending = Buffer.alloc(0);
      while (data.length) {
        if (remaining > 0) {
          const part = data.subarray(0, remaining);
          remaining -= part.length;
          data = data.subarray(part.length);
          if (out) {
            if (!out.write(part)) await once(out, "drain");
            if (remaining === 0) return await closeOutput(out);
          } else if (captureLongName) {
            captureLongName.push(part);
            if (remaining === 0) { longName = parsePaxPath(Buffer.concat(captureLongName)); captureLongName = null; }
          }
          continue;
        }
        if (skip > 0) {
          const count = Math.min(skip, data.length);
          skip -= count;
          data = data.subarray(count);
          continue;
        }
        if (data.length < 512) { pending = Buffer.from(data); break; }
        const header = data.subarray(0, 512);
        data = data.subarray(512);
        if (header.every(byte => byte === 0)) return false;
        const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
        const size = parseInt(field(124, 12).trim() || "0", 8);
        const type = field(156, 1) || "0";
        const prefix = field(345, 155);
        const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        longName = null;
        const padding = (512 - (size % 512)) % 512;
        if (type === "x") {
          // A pax header may carry the next entry's real path.
          remaining = size;
          captureLongName = [];
          skip = padding;
          if (size === 0) captureLongName = null;
        } else if ((type === "0" || type === "7") && name === entryName) {
          out = openOutput();
          if (size === 0) return await closeOutput(out);
          remaining = size;
        } else {
          skip = size + padding;
        }
      }
    }
    if (writeError) throw writeError;
    return false;
  } catch (error) {
    throw writeError ?? error;
  } finally {
    source.destroy();
    file.destroy();
    if (out && !out.closed) {
      out.destroy();
      await once(out, "close").catch(() => undefined);
    }
  }
}

function parsePaxPath(record: Buffer): string | null {
  return /(?:^|\n)\d+ path=([^\n]*)\n/.exec(record.toString("utf8"))?.[1] ?? null;
}
