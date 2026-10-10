import type { ForkOptions } from 'node:child_process'
import { createExposurePolicy } from '../../backend/src/environment/exposure-policy.js'

export interface DesktopEnvironmentExposure {
  mode: 'loopback' | 'lan' | 'tailscale'
  host: string
  publicBaseUrl?: string
  allowedClientOrigins: string[]
  tlsCert?: string
  tlsKey?: string
  trustedProxy?: {peer: string; host: string; proto: 'https'}
}

interface CreateBackendForkOptionsInput {
  exposure?: DesktopEnvironmentExposure
  runtimeRoot: string
  inheritedEnv: NodeJS.ProcessEnv
  isPackaged: boolean
  backendPort: number
  resourcesDir: string
  appVersion: string
  electronVersion: string
  execArgv: string[]
  devBetterSqlite3Binding?: string
}

export function createBackendForkOptions({
  runtimeRoot,
  inheritedEnv,
  isPackaged,
  backendPort,
  resourcesDir,
  appVersion,
  electronVersion,
  execArgv,
  devBetterSqlite3Binding,
  exposure,
}: CreateBackendForkOptionsInput): ForkOptions {
  if (!isPackaged && !devBetterSqlite3Binding) {
    throw new Error('Electron development backend requires a verified better-sqlite3 native binding')
  }
  const configuredDevOrigin = !isPackaged && inheritedEnv.FORGE_ELECTRON_DEV_SERVER_URL
    ? new URL(inheritedEnv.FORGE_ELECTRON_DEV_SERVER_URL).origin
    : null

  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    FORGE_DESKTOP: '1',
    FORGE_ELECTRON_DEV: isPackaged ? '0' : '1',
    FORGE_HOST: inheritedEnv.FORGE_HOST || exposure?.host || '127.0.0.1',
    FORGE_EXPOSURE_MODE: inheritedEnv.FORGE_EXPOSURE_MODE || exposure?.mode,
    FORGE_PUBLIC_URL: inheritedEnv.FORGE_PUBLIC_URL || exposure?.publicBaseUrl,
    FORGE_TLS_CERT: inheritedEnv.FORGE_TLS_CERT || exposure?.tlsCert,
    FORGE_TLS_KEY: inheritedEnv.FORGE_TLS_KEY || exposure?.tlsKey,
    FORGE_TRUSTED_PROXY_PEER: inheritedEnv.FORGE_TRUSTED_PROXY_PEER || exposure?.trustedProxy?.peer,
    FORGE_TRUSTED_PROXY_HOST: inheritedEnv.FORGE_TRUSTED_PROXY_HOST || exposure?.trustedProxy?.host,
    FORGE_TRUSTED_PROXY_PROTO: inheritedEnv.FORGE_TRUSTED_PROXY_PROTO || exposure?.trustedProxy?.proto,
    FORGE_ENVIRONMENT_BOOTSTRAP_PARENT: '1',
    FORGE_ALLOWED_CLIENT_ORIGINS: [...new Set(['app://forge', ...(!isPackaged ? ['http://127.0.0.1:47188', 'http://localhost:47188'] : []), ...(configuredDevOrigin ? [configuredDevOrigin] : []), ...(inheritedEnv.FORGE_ALLOWED_CLIENT_ORIGINS?.split(',').filter(Boolean) ?? exposure?.allowedClientOrigins ?? [])])].join(','),
    FORGE_PORT: inheritedEnv.FORGE_PORT || String(backendPort),
    FORGE_RESOURCES_DIR: resourcesDir,
    FORGE_APP_VERSION: appVersion,
    FORGE_ELECTRON_VERSION: electronVersion,
  }

  resolveBackendExposurePolicy(env)

  delete env.FORGE_SECURE_CONTROL_TOKEN
  delete env.FORGE_BETTER_SQLITE3_NATIVE_BINDING
  if (!isPackaged) {
    env.FORGE_BETTER_SQLITE3_NATIVE_BINDING = devBetterSqlite3Binding
  }

  return {
    cwd: runtimeRoot,
    env,
    // fd 4 is a one-shot parent-to-backend capability pipe. Keeping the
    // value out of argv and env prevents runtime children from inheriting it.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
    execArgv,
    // Intentionally omit execPath. Electron must fork the backend with its
    // embedded Node runtime so provider and desktop behavior stay unchanged.
  }
}

/** Parent and child use the same exposure authority to select the reachable origin. */
export function resolveBackendExposurePolicy(env: NodeJS.ProcessEnv) {
  return createExposurePolicy({
    host: env.FORGE_HOST,
    port: Number(env.FORGE_PORT),
    mode: env.FORGE_EXPOSURE_MODE as DesktopEnvironmentExposure['mode'] | undefined,
    publicBaseUrl: env.FORGE_PUBLIC_URL,
    allowedClientOrigins: env.FORGE_ALLOWED_CLIENT_ORIGINS?.split(',').filter(Boolean),
    tlsCert: env.FORGE_TLS_CERT,
    tlsKey: env.FORGE_TLS_KEY,
    trustedProxy: env.FORGE_TRUSTED_PROXY_PEER ? {
      peer: env.FORGE_TRUSTED_PROXY_PEER,
      host: env.FORGE_TRUSTED_PROXY_HOST ?? new URL(env.FORGE_PUBLIC_URL ?? '').host,
      proto: (env.FORGE_TRUSTED_PROXY_PROTO ?? 'https') as 'https',
    } : undefined,
  })
}
