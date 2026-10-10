import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnvironmentCredentialService, createEnvironmentCredentialsBridge, installEnvironmentCredentialsIpc, ENVIRONMENT_CREDENTIALS_CHANNEL } from '../environment-credentials-ipc.js';
import { requestEnvironmentBootstrap, ensurePrimaryEnvironmentSession } from '../environment-bootstrap-ipc.js';
import { createBackendForkOptions, resolveBackendExposurePolicy } from '../backend-fork-options.js';
const power = vi.hoisted(()=>({started:false,start:vi.fn(()=>{power.started=true;return 1;}),stop:vi.fn(()=>{power.started=false;})}));
vi.mock('electron',()=>({app:{isPackaged:false},BrowserWindow:class{},dialog:{},Notification:class{},powerSaveBlocker:{start:power.start,stop:power.stop,isStarted:()=>power.started}}));
vi.mock('electron-updater',()=>({autoUpdater:{}}));
vi.mock('../electron-settings.js',()=>({readSettings:()=>({sleepBlockerEnabled:false,sleepBlockerGracePeriodMinutes:30}),writeSettings:()=>{}}));
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
it('safeStorage ciphertext stays on disk; parent IPC pairs via ordinary HTTP and valid primary session is reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-desktop-env-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const token = randomBytes(32).toString('base64url'); const id = 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9';
  let exchanges = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v2/environment') res.end(JSON.stringify({ environmentId: id, protocolVersion: 1, label: 'primary' }));
    else if (req.url === '/api/v2/access/challenge') res.end(JSON.stringify({ challengeId: id, nonce: randomBytes(32).toString('base64url') }));
    else if (req.url === '/api/v2/access/exchange') {
      exchanges++; for await (const chunk of req) expect(chunk).toBeDefined();
      res.end(JSON.stringify({ environment: { environmentId: id, label: 'primary' }, deviceSession: { deviceSessionId: id, deviceName:'test', scopes:['session:read'],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*24*60*60*1000).toISOString() }, bearerToken: token }));
    } else if (req.url === '/api/files/raw?binary=1') {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      expect(req.headers.origin).toBe('app://forge');
      res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from([0, 127, 128, 255]));
    } else if (req.url === '/api/files/raw?chunked=1') {
      res.setHeader('Content-Type', 'application/octet-stream'); res.write(Buffer.from([0, 127])); res.end(Buffer.from([128, 255]));
    } else if (req.url === '/api/files/raw?upload=1') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      expect([...Buffer.concat(chunks)]).toEqual([0, 128, 255]); res.end(Buffer.from([255, 128, 0]));
    } else if (req.url?.startsWith('/api/v2/artifacts?')) {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      expect(req.headers['x-forge-environment-protocol']).toBe('1');
      expect(req.headers['content-length']).toBe('3'); expect(req.headers['x-forge-file-name']).toBe('test%20data.bin');
      const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
      expect([...Buffer.concat(parts)]).toEqual([0,127,255]);
      res.end(JSON.stringify({artifactId:id,fileName:'test data.bin',mimeType:'application/octet-stream',sizeBytes:3}));
    } else if (req.url === `/api/v2/artifacts/${id}`) {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      expect(req.headers['x-forge-environment-protocol']).toBe('1');
      res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition','inline; filename="test data.bin"');
      if(req.headers.range) { expect(req.headers.range).toBe('bytes=0-1');res.statusCode=206;res.setHeader('Content-Range','bytes 0-1/3');res.end(Buffer.from([0,127])); }
      else res.end(Buffer.from([0,127,255]));
    } else {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      res.end(JSON.stringify({ deviceSession: { deviceSessionId: id, deviceName:'test', scopes:['session:read'],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*24*60*60*1000).toISOString() } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const storePath = join(root, 'encrypted.json');
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (text: string) => Buffer.from(text).map(v => v ^ 0x55), decryptString: (data: Buffer) => data.map(v => v ^ 0x55).toString() };
  const credentials = createEnvironmentCredentialService({ storePath, safeStorage });
  const entry = join(root, 'child.cjs'); await writeFile(entry, `process.on('message',m=>{if(m.type==='forge:environment-bootstrap:request')process.send({type:'forge:environment-bootstrap:result',requestId:m.requestId,grant:{environmentId:'${id}',pairingUrl:'${baseUrl}/pair#v=1&environmentId=${id}&grantId=${id}&secret=${randomBytes(32).toString('base64url')}'}})});`);
  const child = fork(entry, [], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); cleanup.push(() => { child.kill(); });
  const paired = await ensurePrimaryEnvironmentSession({ child, baseUrl, credentials });
  expect(JSON.stringify(paired)).not.toContain(token);
  expect(await readFile(storePath, 'utf8')).not.toContain(token);
  await ensurePrimaryEnvironmentSession({ child, baseUrl, credentials }); expect(exchanges).toBe(1);
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
  cleanup.push(installEnvironmentCredentialsIpc({ ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } }, service: credentials, isTrustedSender: event => event === 'trusted' }));
  const bridge = createEnvironmentCredentialsBridge({ invoke: async (channel, input) => handlers.get(channel)!('trusted', input) });
  const binary = { environmentId: id, method: 'GET' as const, path: '/api/files/raw?binary=1', maxBytes: 4 };
  expect(await bridge.requestBinary(binary)).toEqual({ ok: true, value: { status: 200, headers: { 'content-type': 'image/png' }, bytes: new Uint8Array([0,127,128,255]) } });
  expect(await bridge.requestBinary({ ...binary, path: '/api/files/raw?chunked=1', maxBytes: 3 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await bridge.requestBinary({ ...binary, maxBytes: 3 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await bridge.requestBinary({ ...binary, path: '/api/files/raw?upload=1', method: 'POST', body: new Uint8Array([0,128,255]) })).toMatchObject({ ok: true, value: { bytes: new Uint8Array([255,128,0]) } });
  for (const maxBytes of [0, -1, 1.5, 26214401, NaN]) expect(await bridge.requestBinary({ ...binary, maxBytes })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  for (const path of ['/api/../outside', '/api/v2/access/session', '//evil.test/api/', '/api/files/raw#fragment', '/api/%2e%2e/outside']) expect(await bridge.requestBinary({ ...binary, path })).toMatchObject({ ok: false });
  for (const name of ['Authorization', 'Origin', 'Cookie', 'Host', 'x-forge-csrf']) expect(await bridge.requestBinary({ ...binary, headers: { [name]: 'forbidden' } })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(await bridge.requestBinary({ ...binary, body: new Uint8Array(26214401) })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await handlers.get(ENVIRONMENT_CREDENTIALS_CHANNEL)!('untrusted', { operation: 'requestBinary', input: binary })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(await credentials.uploadArtifact({environmentId:id,projectId:'project',uploadId:id,fileName:'test data.bin',mimeType:'application/octet-stream',bytes:new Uint8Array([0,127,255])})).toMatchObject({ok:true,value:{artifactId:id}});
  expect(await credentials.uploadArtifact({environmentId:id,projectId:'project',uploadId:id+':0',fileName:'test data.bin',mimeType:'application/octet-stream',bytes:new Uint8Array([0,127,255])})).toMatchObject({ok:true,value:{artifactId:id}});
  expect(await credentials.artifact({environmentId:id,artifactId:id})).toMatchObject({ok:true,value:{bytes:new Uint8Array([0,127,255]),fileName:'test data.bin'}});
  const preview=await credentials.artifactProtocolResponse(`forge-artifact://artifact/${id}/${id}`,'bytes=0-1');
  expect(preview.status).toBe(206);expect([...new Uint8Array(await preview.arrayBuffer())]).toEqual([0,127]);
  expect(await credentials.uploadArtifact({environmentId:id,projectId:'project',uploadId:id,fileName:'too-big',mimeType:'application/octet-stream',bytes:new Uint8Array(25*1024*1024+1)})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  const reopened = createEnvironmentCredentialService({ storePath, safeStorage });
  expect((await reopened.list()).value).toHaveLength(1);
  expect((await reopened.list()).value?.[0]).toMatchObject({deviceSessionId:id,deviceName:'test',scopes:['session:read'],pairedAt:expect.any(String),expiresAt:expect.any(String)});
  expect(JSON.stringify(await reopened.session(id))).not.toContain(token);
  server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));
  expect(await reopened.primary()).toMatchObject({ok:true,value:{environmentId:id,deviceSessionId:id}});
  expect(await reopened.list()).toMatchObject({ok:true,value:[{environmentId:id,deviceName:'test'}]});
  expect(await reopened.persistence.save({environmentId:id,deviceSessionId:id,key:'shell',value:JSON.stringify({items:['retained']})})).toEqual({ok:true,value:undefined});
  const restored = createEnvironmentCredentialService({ storePath, safeStorage });
  expect(await restored.persistence.load({environmentId:id,key:'shell'})).toEqual({ok:true,value:JSON.stringify({items:['retained']})});
  expect(await restored.persistence.load({environmentId:id,deviceSessionId:'e6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9',key:'shell'})).toMatchObject({ok:false,error:{code:'UNAUTHENTICATED'}});
  expect(await readFile(storePath+'.runtime','utf8')).not.toContain('retained');
  expect(await restored.persistence.save({environmentId:id,deviceSessionId:id,key:'pending',value:JSON.stringify({bearerToken:token})})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  await restored.remove(id);
  expect(await restored.persistence.load({environmentId:id,key:'shell'})).toMatchObject({ok:false,error:{code:'UNAUTHENTICATED'}});
  const runtime = await readFile(storePath+'.runtime','utf8'); expect(runtime).not.toContain(token);
  await expect(requestEnvironmentBootstrap({ send() {}, on() {}, off() {} } as never, 5)).rejects.toThrow(/timed out/);
});
it('Desktop defaults to loopback and refuses plaintext safeStorage fallback', async () => {
  expect(createBackendForkOptions({ runtimeRoot: '/tmp', inheritedEnv: {}, isPackaged: true, backendPort: 47187, resourcesDir: '/tmp', appVersion: '1', electronVersion: '1', execArgv: [] }).env?.FORGE_HOST).toBe('127.0.0.1');
  const root=await mkdtemp(join(tmpdir(),'forge-exposure-child-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const entry=join(root,'exposure.cjs');await writeFile(entry,`process.send({host:process.env.FORGE_HOST,mode:process.env.FORGE_EXPOSURE_MODE,publicUrl:process.env.FORGE_PUBLIC_URL,origins:process.env.FORGE_ALLOWED_CLIENT_ORIGINS});`);
  const options=createBackendForkOptions({runtimeRoot:root,inheritedEnv:{},isPackaged:true,backendPort:47187,resourcesDir:root,appVersion:'1',electronVersion:'1',execArgv:[],exposure:{mode:'lan',host:'0.0.0.0',publicBaseUrl:'https://dev1.test',allowedClientOrigins:['https://client.test'],trustedProxy:{peer:'127.0.0.1',host:'dev1.test',proto:'https'}}});
  const child=fork(entry,[],options);cleanup.push(()=>child.kill());
  const [observed]=await once(child,'message');expect(observed).toMatchObject({host:'0.0.0.0',mode:'lan',publicUrl:'https://dev1.test',origins:'app://forge,https://client.test'});
  expect(resolveBackendExposurePolicy(options.env!).publicBaseUrl).toBe('https://dev1.test');
  expect(()=>createBackendForkOptions({runtimeRoot:root,inheritedEnv:{},isPackaged:true,backendPort:47187,resourcesDir:root,appVersion:'1',electronVersion:'1',execArgv:[],exposure:{mode:'lan',host:'0.0.0.0',allowedClientOrigins:[]}})).toThrow(/TLS/);
  const service = createEnvironmentCredentialService({ storePath: join(tmpdir(), 'unused-test-file'), safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' } });
  expect(await service.list()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
});

it('the explicitly configured development renderer origin participates in V2 pairing, without changing packaged origins', () => {
  const input = { runtimeRoot: '/tmp', inheritedEnv: { FORGE_ELECTRON_DEV_SERVER_URL: 'http://127.0.0.1:47588' }, isPackaged: false, backendPort: 49991, resourcesDir: '/tmp', appVersion: '1', electronVersion: '1', execArgv: [], devBetterSqlite3Binding: '/tmp/synthetic-binding.node' };
  expect(createBackendForkOptions(input).env?.FORGE_ALLOWED_CLIENT_ORIGINS?.split(',')).toContain('http://127.0.0.1:47588');
  expect(createBackendForkOptions({ ...input, isPackaged: true }).env?.FORGE_ALLOWED_CLIENT_ORIGINS?.split(',')).not.toContain('http://127.0.0.1:47588');
});

it('authenticated activity drives sleep prevention and updater treats revoked or malformed activity as active', async () => {
  const {readPrimaryEnvironmentActivity} = await import('../environment-credentials-ipc.js');
  const {hasActiveSessions} = await import('../auto-updater.js');
  const {SleepBlockerService} = await import('../sleep-blocker.js');
  const root = await mkdtemp(join(tmpdir(),'forge-activity-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const token = randomBytes(32).toString('base64url'); const id='a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9'; let activityStatus=200; let activityReads=0;
  const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/v2/environment')res.end(JSON.stringify({environmentId:id,protocolVersion:1,label:'primary'}));else if(req.url==='/api/v2/access/challenge')res.end(JSON.stringify({challengeId:id,nonce:randomBytes(32).toString('base64url')}));else if(req.url==='/api/v2/access/exchange'){for await(const chunk of req)expect(chunk).toBeDefined();res.end(JSON.stringify({environment:{environmentId:id,label:'primary'},deviceSession:{deviceSessionId:id,deviceName:'test',scopes:['session:read'],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*24*60*60*1000).toISOString()},bearerToken:token}));}else if(req.url==='/api/activity'){expect(req.headers.authorization).toBe(`Bearer ${token}`);activityReads++;res.statusCode=activityStatus;res.end(JSON.stringify({activeSessions:1,activeWorkers:0,hasActiveSessions:true,hasActiveWorkers:false}));}else{res.statusCode=404;res.end('{}');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
  const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const credentials=createEnvironmentCredentialService({storePath:join(root,'credentials.json'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text).map(v=>v^0x55),decryptString:data=>data.map(v=>v^0x55).toString()}});
  expect(await credentials.pairPrimary({baseUrl,environmentId:id,credential:{kind:'code',code:'ABCD-EFGH-JKMN'},deviceName:'activity test',requestedScopes:['session:read']})).toMatchObject({ok:true});
  const readActivity=()=>readPrimaryEnvironmentActivity(credentials);
  expect(await hasActiveSessions(readActivity)).toBe(true);
  const sleep=new SleepBlockerService({readActivity,onStatusChange:()=>{}});cleanup.push(()=>sleep.dispose());sleep.initialize();sleep.updateSettings({enabled:true});
  await vi.waitFor(()=>expect(sleep.getStatus().blocking).toBe(true));const stops=power.stop.mock.calls.length;
  activityStatus=401;expect(await hasActiveSessions(readActivity)).toBe(true);
  sleep.updateSettings({enabled:true});const previous=activityReads;await vi.waitFor(()=>expect(activityReads).toBeGreaterThan(previous));
  expect(sleep.getStatus().blocking).toBe(true);expect(power.stop).toHaveBeenCalledTimes(stops);
  expect(await hasActiveSessions(async()=>null)).toBe(true);
});

it('secure IPC sends the capability only to the loopback backend when the primary is exposed publicly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-secure-exposed-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const primaryId = 'c6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9';
  const publicUrl = 'https://mac.tailnet.ts.net';
  const loopbackUrl = 'http://127.0.0.1:49993';
  const controlToken = 'synthetic-secure-control-capability'.padEnd(43, 'y');
  const calls: Array<{ origin: string; path: string; control: string | null; requestOrigin: string | null }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    calls.push({ origin: url.origin, path: url.pathname, control: headers.get('x-forge-secure-control'), requestOrigin: headers.get('origin') });
    let payload: unknown = {};
    if (url.pathname === '/api/v2/environment') payload = { environmentId: primaryId, protocolVersion: 1, label: 'fixture' };
    if (url.pathname === '/api/v2/access/challenge') payload = { challengeId: primaryId, nonce: 'synthetic-nonce' };
    if (url.pathname === '/api/v2/access/exchange') payload = { environment: { environmentId: primaryId, label: 'fixture' }, deviceSession: { deviceSessionId: primaryId, deviceName: 'fixture', scopes: ['session:read'], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 100000).toISOString() }, bearerToken: 't'.repeat(43) };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  const service = createEnvironmentCredentialService({ storePath: join(root, 'credentials.json'), clientOrigin: 'app://forge', fetch: fetcher as typeof fetch,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(b => b ^ 0x55), decryptString: value => value.map(b => b ^ 0x55).toString() },
    desktopSecureControl: () => ({ baseUrl: publicUrl, loopbackUrl, token: controlToken }),
  });
  expect(await service.pairPrimary({ environmentId: primaryId, baseUrl: publicUrl, credential: { kind: 'code', code: 'ABCD-EFGH-JKMN' }, deviceName: 'test', requestedScopes: ['session:read'] })).toMatchObject({ ok: true });
  const secure = { environmentId: primaryId, path: '/api/secure-sessions/manager/start', method: 'POST' as const, headers: { 'Content-Type': 'application/json' }, body: '{}' };
  expect(await service.request(secure)).toMatchObject({ ok: true });
  expect(calls.at(-1)).toEqual({ origin: loopbackUrl, path: secure.path, control: controlToken, requestOrigin: 'app://forge' })
  expect(calls.filter(call => call.origin !== loopbackUrl).every(call => call.control === null)).toBe(true)
  expect(await service.request({ ...secure, path: '/api/activity', method: 'GET', body: undefined })).toMatchObject({ ok: true });
  expect(calls.at(-1)).toMatchObject({ origin: publicUrl, control: null });
});

it('secure IPC confines its main-owned capability to the pinned primary loopback target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-secure-ipc-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const primaryId = 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9';
  const remoteId = 'b6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9';
  const baseUrl = 'http://127.0.0.1:49991';
  const controlToken = 'synthetic-secure-control-capability'.padEnd(43, 'x');
  let ownedUrl = baseUrl;
  let available = true;
  let mismatch = false;
  const calls: Array<{ path: string; control: string | null; origin: string | null }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, control: headers.get('x-forge-secure-control'), origin: headers.get('origin') });
    const id = url.origin === baseUrl ? primaryId : remoteId;
    let payload: unknown = {};
    if (url.pathname === '/api/v2/environment') payload = { environmentId: mismatch ? remoteId : id, protocolVersion: 1, label: 'fixture' };
    if (url.pathname === '/api/v2/access/challenge') payload = { challengeId: id, nonce: 'synthetic-nonce' };
    if (url.pathname === '/api/v2/access/exchange') payload = { environment: { environmentId: id, label: 'fixture' }, deviceSession: { deviceSessionId: id, deviceName: 'fixture', scopes: ['session:read'], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 100000).toISOString() }, bearerToken: 't'.repeat(43) };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  const service = createEnvironmentCredentialService({ storePath: join(root, 'credentials.json'), clientOrigin: 'http://127.0.0.1:47588', fetch: fetcher as typeof fetch,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(b => b ^ 0x55), decryptString: value => value.map(b => b ^ 0x55).toString() },
    desktopSecureControl: () => available ? { baseUrl: ownedUrl, loopbackUrl: ownedUrl, token: controlToken } : null,
  });
  const pair = (environmentId: string, url: string) => ({ environmentId, baseUrl: url, credential: { kind: 'code' as const, code: 'ABCD-EFGH-JKMN' }, deviceName: 'test', requestedScopes: ['session:read' as const] });
  expect(await service.pairPrimary(pair(primaryId, baseUrl))).toMatchObject({ ok: true });
  expect(await service.pair(pair(remoteId, 'https://remote.test'))).toMatchObject({ ok: true });
  const input = { environmentId: primaryId, path: '/api/secure-sessions/manager/start', method: 'POST' as const, headers: { 'Content-Type': 'application/json' }, body: '{}' };
  expect(await service.request(input)).toMatchObject({ ok: true });
  expect(calls.at(-1)).toEqual({ path: input.path, control: controlToken, origin: 'app://forge' });
  expect(await service.requestBinary({ ...input, body: undefined, maxBytes: 100 })).toMatchObject({ ok: true });
  expect(calls.at(-1)?.control).toBe(controlToken);
  const sent = calls.length;
  for (const path of ['/api/secure-sessions/manager', '/api/secure-secrets/providers', '/api/settings/secure-secrets', '/api/secure-browser-control/status', '/api/settings/secure-browsers/devices']) {
    expect(await service.request({ ...input, environmentId: remoteId, path })).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE', message: 'Secure Sessions are not available on remote machines. Open a session on This machine to use them.' } });
  }
  expect(calls).toHaveLength(sent);
  for (const name of ['X-Forge-Secure-Control', 'Origin', 'Authorization']) {
    expect(await service.request({ ...input, headers: { [name]: controlToken } })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  }
  ownedUrl = 'http://127.0.0.1:49992';
  expect(await service.request(input)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  ownedUrl = baseUrl; available = false;
  expect(await service.request(input)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  available = true; mismatch = true;
  expect(await service.request(input)).toMatchObject({ ok: false, error: { code: 'IDENTITY_MISMATCH' } });
  expect(calls.at(-1)?.control).toBeNull();
  mismatch = false;
  expect(await service.request({ ...input, path: '/api/activity', method: 'GET', body: undefined })).toMatchObject({ ok: true });
  expect(calls.at(-1)).toEqual({ path: '/api/activity', control: null, origin: 'http://127.0.0.1:47588' });
  expect(await service.wsTicket(primaryId, 'rpc', 1)).toMatchObject({ ok: true });
  expect(calls.at(-1)?.origin).toBe('http://127.0.0.1:47588');
  expect(calls.at(-1)?.control).toBe(controlToken);
  expect(await service.wsTicket(remoteId, 'rpc', 1)).toMatchObject({ ok: true });
  expect(calls.at(-1)?.control).toBeNull();
  expect(JSON.stringify(await service.list())).not.toContain(controlToken);
  expect(await readFile(join(root, 'credentials.json'), 'utf8')).not.toContain(controlToken);
});
