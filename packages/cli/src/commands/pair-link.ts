import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Scope } from '../../../protocol/src/environment-v2.js'
import { requestLocalPairingGrant } from '../../../../apps/backend/src/environment/access/local-pairing.js'
import { CliError, writeJson, writeWarning } from '../output.js'
import { EXIT_CODES } from '../version.js'
import type { CommandContext } from './types.js'

/** `10m`, `90s`, `1h` or bare minutes; 1 to 60 minutes. */
export function parseExpiry(value: string | undefined): number {
  if (value === undefined) return 600
  const match = /^(\d+)(s|m|h)?$/.exec(value.trim())
  const seconds = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h' ?? 'm']) : NaN
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600)
    throw new CliError('--expires must be between 1m and 60m (for example 10m)', { exitCode: EXIT_CODES.usage, code: 'invalid_expiry' })
  return seconds
}

/** Issues a pairing link from the Forge running on this machine; the data directory's owner only. */
export async function handlePairLinkCommand(context: CommandContext): Promise<number> {
  const o = context.args.options
  const dataDir = o.dataDir ?? context.env.FORGE_DATA_DIR ?? join(homedir(), '.forge')
  if (!isAbsolute(dataDir)) throw new CliError('--data-dir must be an absolute directory', { exitCode: EXIT_CODES.usage, code: 'invalid_data_dir' })
  const expiresInSeconds = o.expires === undefined ? undefined : parseExpiry(o.expires)
  const scopes = o.scopes?.split(',').map((scope) => scope.trim()).filter(Boolean) as Scope[] | undefined
  const { grant, baseUrl, loopbackOnly } = await requestLocalPairingGrant(dataDir, {
    kind: o.code ? 'code' : 'link',
    ...(scopes ? { scopes } : {}),
    ...(o.label ? { label: o.label } : {}),
    ...(expiresInSeconds ? { expiresInSeconds } : {}),
  })
  if (o.json) writeJson(context.io, { pairingUrl: grant.pairingUrl, code: grant.code, baseUrl, loopbackOnly, expiresAt: grant.expiresAt, scopes: grant.scopes })
  else context.io.stdout.write(`${grant.pairingUrl ?? grant.code}\n`)
  const minutes = Math.round((Date.parse(grant.expiresAt) - Date.now()) / 60_000)
  writeWarning(context.io, `Works once; expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.${grant.code ? ` On the other device, enter ${baseUrl} and this code.` : ''}`)
  if (loopbackOnly)
    writeWarning(context.io, `${baseUrl} only works on this machine. To pair another device, restart Forge with --tailscale-serve, or --public-url <https-origin> with a TLS certificate.`)
  return EXIT_CODES.success
}
