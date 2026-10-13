import {
  constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { configSyncFilenameIdentity } from '@forge/protocol';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export class SyncBoundaryError extends Error {}
export class SyncAliasError extends SyncBoundaryError {}
export const syncFilenameIdentity = configSyncFilenameIdentity;
interface DirectoryIdentity { path: string; dev: number; ino: number }
interface VerifiedDirectory { path: string; identities: DirectoryIdentity[]; close(): void }
const nofollow = constants.O_NOFOLLOW ?? 0;
const sameFile = (a: Stats | DirectoryIdentity, b: Stats | DirectoryIdentity) => a.dev === b.dev && a.ino === b.ino;

/** A single portable filesystem boundary. Legacy/accidental links and untrusted peer keys are
 * rejected; a local attacker who already owns the account is outside this boundary's threat model.
 * Every operation checks each component and rechecks directory identity before and after mutation. */
export class SyncFilesystem {
  readonly path: string;
  private readonly root: DirectoryIdentity;
  private readonly configuredPath: string;
  constructor(path: string) {
    this.configuredPath = resolve(path);
    if (lstatSync(this.configuredPath).isSymbolicLink()) throw new SyncBoundaryError('Sync root is a symbolic link');
    this.path = realpathSync(this.configuredPath);
    const stat = lstatSync(this.path);
    if (!stat.isDirectory()) throw new SyncBoundaryError('Sync root must be a directory');
    this.root = { path: this.path, dev: stat.dev, ino: stat.ino };
  }
  close() { /* All handles are scoped to individual operations. */ }
  private segments(path: string): string[] {
    if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.includes('\0'))) throw new SyncBoundaryError('Path escapes sync boundary');
    return path.split('/');
  }
  revalidate() {
    const configured = lstatSync(this.configuredPath), actual = lstatSync(this.path);
    if (configured.isSymbolicLink() || actual.isSymbolicLink() || !sameFile(actual, this.root) || realpathSync(this.configuredPath) !== this.path) throw new SyncBoundaryError('Sync root changed');
  }
  private verify(dir: VerifiedDirectory) {
    this.revalidate();
    for (const identity of dir.identities) {
      const stat = lstatSync(identity.path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFile(stat, identity) || realpathSync(identity.path) !== identity.path) throw new SyncBoundaryError('Directory identity changed in sync boundary');
    }
  }
  directory(rel = '', create = false): VerifiedDirectory {
    this.revalidate(); let path = this.path;
    const identities = [this.root];
    for (const name of rel ? this.segments(rel) : []) {
      const parent: VerifiedDirectory = { path, identities: [...identities], close() {} };
      this.assertName(parent, name); this.verify(parent); path = join(path, name);
      let stat: Stats;
      try { stat = lstatSync(path); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(path); this.verify(parent); stat = lstatSync(path);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) throw new SyncBoundaryError('Symbolic link or invalid directory in sync boundary');
      identities.push({ path, dev: stat.dev, ino: stat.ino });
    }
    const dir = { path, identities, close() {} }; this.verify(dir); return dir;
  }
  parent(rel: string, create = false) { this.segments(rel); return this.directory(dirname(rel) === '.' ? '' : dirname(rel).split(sep).join('/'), create); }
  names(rel = '') {
    const dir = this.directory(rel); this.verify(dir); const names = readdirSync(dir.path).sort(); this.verify(dir); return names;
  }
  assertName(dir: VerifiedDirectory, name: string) {
    this.verify(dir); const aliases = readdirSync(dir.path).filter(candidate => syncFilenameIdentity(candidate) === syncFilenameIdentity(name)); this.verify(dir);
    if (aliases.some(candidate => candidate !== name) || aliases.length > 1) throw new SyncAliasError(`Unsupported filename collision: ${name}`);
  }
  private regular(dir: VerifiedDirectory, name: string, allowDirectory = false) {
    this.assertName(dir, name); const path = join(dir.path, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !(stat.isFile() || allowDirectory && stat.isDirectory()) || realpathSync(path) !== path) throw new SyncBoundaryError('Symbolic link or invalid file in sync boundary');
    this.verify(dir); return stat;
  }
  stat(rel: string) { const dir = this.parent(rel); return this.regular(dir, basename(rel), true); }
  read(rel: string): { bytes: Buffer; mode: number; mtimeMs: number } {
    const dir = this.parent(rel); const name = basename(rel); const named = this.regular(dir, name);
    const fd = openSync(join(dir.path, name), constants.O_RDONLY | nofollow);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || !sameFile(before, named)) throw new SyncBoundaryError('File changed while opening in sync boundary');
      this.verify(dir); const bytes = readFileSync(fd); const after = fstatSync(fd);
      if (!sameFile(after, this.regular(dir, name)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new SyncBoundaryError('File changed while reading');
      this.verify(dir); return { bytes, mode: after.mode & 0o777, mtimeMs: after.mtimeMs };
    } finally { closeSync(fd); }
  }
  writeExclusive(rel: string, bytes: Buffer, mode = 0o600) {
    const dir = this.parent(rel, true); const name = basename(rel); this.assertName(dir, name); this.verify(dir);
    const fd = openSync(join(dir.path, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, mode);
    try {
      this.verify(dir); writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd);
      if (!sameFile(fstatSync(fd), this.regular(dir, name))) throw new SyncBoundaryError('Temporary file identity changed');
      this.verify(dir); this.syncDirectory(dir);
    } finally { closeSync(fd); }
  }
  rename(from: string, to: string, replace = false) {
    const src = this.parent(from), dst = this.parent(to, true); this.regular(src, basename(from)); this.assertName(dst, basename(to));
    try { this.regular(dst, basename(to)); if (!replace) throw Object.assign(new Error('Destination exists'), { code: 'EEXIST' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.verify(src); this.verify(dst); renameSync(join(src.path, basename(from)), join(dst.path, basename(to)));
    this.verify(src); this.verify(dst); this.syncDirectory(src); this.syncDirectory(dst);
  }
  link(from: string, to: string) {
    const src = this.parent(from), dst = this.parent(to, true); const source = this.regular(src, basename(from)); this.assertName(dst, basename(to));
    this.verify(src); this.verify(dst); linkSync(join(src.path, basename(from)), join(dst.path, basename(to)));
    this.verify(src); this.verify(dst);
    if (!sameFile(source, this.regular(dst, basename(to)))) throw new SyncBoundaryError('Installed file identity changed');
    this.syncDirectory(dst);
  }
  unlink(rel: string) { const dir = this.parent(rel); this.regular(dir, basename(rel)); this.verify(dir); unlinkSync(join(dir.path, basename(rel))); this.verify(dir); this.syncDirectory(dir); }
  removeEmptyDirectory(rel: string): boolean {
    try {
      const parent = this.parent(rel), dir = this.directory(rel);
      // Non-recursive rmdir checks emptiness atomically, including ignored files and later saves.
      this.verify(parent); this.verify(dir); rmdirSync(dir.path);
      this.verify(parent); this.syncDirectory(parent); return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if (['ENOTEMPTY', 'EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes(code ?? '')) return false;
      throw error;
    }
  }
  syncFile(rel: string) {
    const dir = this.parent(rel); const named = this.regular(dir, basename(rel)); const fd = openSync(join(dir.path, basename(rel)), (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | nofollow);
    try { if (!sameFile(named, fstatSync(fd))) throw new SyncBoundaryError('Preserved file identity changed'); fsyncSync(fd); this.verify(dir); } finally { closeSync(fd); }
  }
  json<T>(rel: string): T | undefined { try { return JSON.parse(this.read(rel).bytes.toString('utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
  saveJson(rel: string, value: unknown) {
    const tmp = `${rel}.${randomUUID()}.tmp`; this.writeExclusive(tmp, Buffer.from(`${JSON.stringify(value)}\n`));
    // eslint-disable-next-line no-restricted-syntax -- Sync state needs this no-follow boundary and checks on both sides of rename.
    try { this.rename(tmp, rel, true); } catch (error) { try { this.unlink(tmp); } catch { /* Original error wins. */ } throw error; }
  }
  private syncDirectory(dir: VerifiedDirectory) {
    if (process.platform === 'win32') return; // Windows does not expose directory fsync through Node.
    this.verify(dir); const fd = openSync(dir.path, constants.O_RDONLY | nofollow | (constants.O_DIRECTORY ?? 0));
    try { if (!sameFile(fstatSync(fd), dir.identities.at(-1)!)) throw new SyncBoundaryError('Directory changed before fsync'); fsyncSync(fd); this.verify(dir); } finally { closeSync(fd); }
  }
}
