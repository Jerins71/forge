import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repositoryRoot, sanitizedEnvironment, type EnvironmentFixture } from '../launch.js';
import type { EnvironmentDescriptor } from '@forge/protocol/environment-v2';

/** Owned standalone process for local clone/fencing and real Electron tests. No PID lookup or production debug route. */
export function spawnStandaloneBackend(environment: EnvironmentFixture, dataDir = environment.dataDir, nativeNode = process.execPath) {
  const require = createRequire(join(repositoryRoot, 'apps/backend/package.json'));
  const child: ChildProcess = spawn(nativeNode, ['--expose-gc', '--import', require.resolve('tsx'), join(repositoryRoot, 'scripts/environment-e2e/fixtures/backend-process.ts')], {
    cwd: environment.checkout,
    env: { ...sanitizedEnvironment(), FORGE_DATA_DIR: dataDir, FORGE_HOST: '127.0.0.1', FORGE_PORT: '0', FORGE_E2E_CHECKOUT: environment.checkout,
      FORGE_INSTALLATION_STATE_DIR: environment.installationStateDir, FORGE_ENVIRONMENT_BOOTSTRAP_PARENT: '1', FORGE_ALLOWED_CLIENT_ORIGINS: 'app://forge', CODEX_BIN: join(repositoryRoot, 'scripts/environment-e2e/fake-codex.mjs') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let mismatch = false; let writerLocked = false;
  const classify = (chunk: Buffer) => { const text = String(chunk); mismatch ||= text.includes('IDENTITY_MISMATCH') || text.includes('installation binding changed'); writerLocked ||= text.includes('already running') || text.includes('runtime lock') || text.includes('Another Forge instance'); };
  child.stdout!.on('data', classify); child.stderr!.on('data', classify);
  const ready = new Promise<{ baseUrl: string; environment: EnvironmentDescriptor }>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Standalone backend readiness timed out')), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(mismatch ? 'IDENTITY_MISMATCH' : writerLocked ? 'WRITER_LOCKED' : 'Standalone backend exited before ready')); });
    child.on('message', message => { const value = message as { type?: string; port?: number; environment?: EnvironmentDescriptor }; if (value.type !== 'ready' || !value.port || !value.environment) return; clearTimeout(timer); resolveReady({ baseUrl: `http://127.0.0.1:${value.port}`, environment: value.environment }); });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolveStop => { const timer = setTimeout(() => child.kill('SIGKILL'), 10000); child.once('exit', () => { clearTimeout(timer); resolveStop(); }); child.send({ type: 'shutdown' }); });
  };
  return { child, ready, stop };
}
