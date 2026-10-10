import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { pairEnvironment, canonicalJson, loadCliCredential } from './pair.js';
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
it('pairs over real HTTP with signed canonical transcript, pins environment and writes only an explicit protected fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-pair-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const environmentId = 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9';
  const nonce = randomBytes(32).toString('base64url'); const token = randomBytes(32).toString('base64url');
  let signed = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v2/environment') { res.end(JSON.stringify({ environmentId, protocolVersion: 2 })); return; }
    if (req.url === '/api/v2/access/challenge') { res.end(JSON.stringify({ challengeId: 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd0', nonce })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); const { proof, ...fields } = input;
    signed = verify('sha256', Buffer.from(`forge-pair-v1\n${environmentId}\n${input.challengeId}\n${nonce}\n${createHash('sha256').update(canonicalJson(fields)).digest('hex')}`), { key: createPublicKey({ key: input.proofKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(proof, 'base64url'));
    res.end(JSON.stringify({ environment: { environmentId, label: 'acceptance' }, deviceSession: { deviceSessionId: environmentId }, bearerToken: token }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const credentialFile = join(root, 'credential.json');
  const result = await pairEnvironment({ target: baseUrl, code: 'ABCD-EFGH-JKMN', credentialFile, expectedEnvironmentId: environmentId });
  expect(signed).toBe(true); expect(JSON.stringify(result)).not.toContain(token);
  expect((await loadCliCredential(credentialFile)).bearerToken).toBe(token);
  expect(await readFile(credentialFile, 'utf8')).toContain(token);
  if (process.platform !== 'win32') expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
  await expect(pairEnvironment({ target: baseUrl, code: 'ABCD-EFGH-JKMN', credentialFile: join(root, 'other'), expectedEnvironmentId: 'changed' })).rejects.toThrow(/identity/i);
  await expect(pairEnvironment({ target: baseUrl, code: 'ABCD-EFGH-JKMN', credentialFile: 'relative.json' })).rejects.toThrow(/absolute/);
});
