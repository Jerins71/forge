import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { serveBackend, resolveBackendEntry, validateServeOptions } from './serve.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'forge-serve-')); roots.push(root); const entry = join(root, 'backend.cjs'); await writeFile(entry, `process.on('message', m => {if(m.type==='forge:environment-bootstrap:request'){for(let i=0;i<2;i++)process.send({type:'forge:environment-bootstrap:result',requestId:m.requestId,grant:{pairingUrl:'http://127.0.0.1/pair#secret=acceptance-only',environmentId:'acceptance'}});setTimeout(()=>process.exit(7),20)}});process.send({type:'ready',port:47187});`); return { root, entry }; }
it('launches an explicit real backend process, private pairing output is exclusive 0600, and exit is preserved', async () => {
  const { root, entry } = await fixture();
  const destination = join(root, 'pair.txt');
  const status = await serveBackend({ backendEntry: entry, pair: true, pairOutput: destination, interactive: false, host: '127.0.0.1', port: 0, env: process.env });
  expect(status).toBe(7);
  const output=await readFile(destination,'utf8');expect(output).toContain('/pair#');expect(output.trim().split('\n')).toHaveLength(1);
  if (process.platform !== 'win32') expect((await stat(destination)).mode & 0o777).toBe(0o600);
  await expect(serveBackend({ backendEntry: entry, pair: true, pairOutput: destination, interactive: false })).rejects.toThrow();
});
it('rejects unsafe exposure, absent packaged backend and noninteractive pairing without explicit protected output', async () => {
  expect(() => validateServeOptions({ host: '0.0.0.0' })).not.toThrow();
  expect(() => validateServeOptions({ host: '0.0.0.0', publicUrl: 'http://dev1.test' })).not.toThrow();
  expect(() => validateServeOptions({ host: '0.0.0.0', publicUrl: 'http://dev1.test/path' })).toThrow();
  expect(() => validateServeOptions({ pair: true, interactive: false })).toThrow();
  await expect(resolveBackendEntry({ env: {}, manifestPath: join(tmpdir(), 'forge-nonexistent-manifest') })).rejects.toThrow(/backend/);
  await expect(resolveBackendEntry({ backendEntry: 'relative.js' })).rejects.toThrow(/absolute/);
});
