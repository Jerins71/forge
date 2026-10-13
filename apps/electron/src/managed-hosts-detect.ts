import type { ExistingForgeInstall } from '@forge/protocol'
import type { ManagedHostDriver } from './managed-hosts.js'
import { shellQuote as q } from './managed-hosts-ssh.js'

// Relative to a data directory; mirrors data-paths getLocalPairingEndpointPath (POSIX hosts).
const ENDPOINT = 'shared/state/environment/local-pairing.json'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Lists Forge data directories on the host: the default one, those in the host's installation
 * registry, and SSH-managed installs. Running means its runtime lock names a live process; pairable
 * means that process publishes a local pairing channel (a Forge new enough for `forge pair-link`).
 */
const detectScript = `set -u
# forge:detect
case "$(uname -s)" in
  Darwin) registry="$HOME/Library/Application Support/Forge/installation/registry.json" ;;
  *) registry="\${XDG_STATE_HOME:-$HOME/.local/state}/forge/installation/registry.json" ;;
esac
{
  printf '%s\\n' "\${FORGE_DATA_DIR:-$HOME/.forge}" "$HOME/.forge"
  if test -f "$registry"; then grep -o '"/[^"]*"[[:space:]]*:' "$registry" | sed 's/^"//; s/"[[:space:]]*:$//'; fi
  for dir in "$HOME"/.local/share/forge/managed/*/data; do test -d "$dir" && printf '%s\\n' "$dir"; done
} | awk '!seen[$0]++' | while IFS= read -r dir; do
  test -f "$dir/shared/state/environment/identity.json" || continue
  running=0; pairable=0; url=''
  pid=$(head -n 1 "$dir/runtime.lock" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) ;; *) kill -0 "$pid" 2>/dev/null && running=1 ;; esac
  if test "$running" = 1 && test -f "$dir/${ENDPOINT}"; then
    pairable=1
    url=$(sed -n 's/^[[:space:]]*"publicBaseUrl":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$dir/${ENDPOINT}" | head -n 1)
  fi
  printf 'FORGE_FOUND\\t%s\\t%s\\t%s\\t%s\\n' "$running" "$pairable" "$url" "$dir"
done
exit 0
`

function origin(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value ? url.origin : null
  } catch {
    return null
  }
}
function reachable(url: string | null): boolean {
  if (!url) return false
  const host = new URL(url).hostname
  return url.startsWith('https://') && host !== 'localhost' && host !== '[::1]' && !/^127\./.test(host)
}

export async function detectExistingForge(driver: Pick<ManagedHostDriver, 'run'>, hostAlias: string): Promise<ExistingForgeInstall[]> {
  const output = await driver.run(hostAlias, detectScript, { timeoutMs: 20_000, maxBytes: 65_536 })
  const found = new Map<string, ExistingForgeInstall>()
  for (const line of output.split('\n')) {
    const [marker, running, pairable, url, dataDir, extra] = line.split('\t')
    if (marker !== 'FORGE_FOUND' || extra !== undefined || !dataDir || !/^[01]$/.test(running ?? '') || !/^[01]$/.test(pairable ?? '')) continue
    if (!dataDir.startsWith('/') || /[\u0000-\u001f\u007f]/.test(dataDir) || dataDir.length > 1024 || found.has(dataDir)) continue
    const publicUrl = url ? origin(url) : null
    if (url && !publicUrl) continue
    found.set(dataDir, { dataDir, running: running === '1', pairable: pairable === '1', publicUrl, reachable: reachable(publicUrl) })
  }
  return [...found.values()]
}

/** One link from the running Forge's local pairing channel, using that Forge's own Node. */
export async function issueExistingForgeLink(
  driver: Pick<ManagedHostDriver, 'run'>,
  hostAlias: string,
  forge: Pick<ExistingForgeInstall, 'dataDir'> & { publicUrl: string },
): Promise<string> {
  const client = `const fs=require('fs'),net=require('net');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const s=net.connect(r.endpoint);let d='';const t=setTimeout(()=>{s.destroy();process.exit(3)},10000);s.on('connect',()=>s.write(JSON.stringify({v:1,token:r.token,request:{kind:'link',label:'Forge Desktop'}})+'\\n'));s.on('data',c=>d+=c);s.on('error',()=>process.exit(3));s.on('close',()=>{clearTimeout(t);let m;try{m=JSON.parse(d)}catch{process.exit(3)}if(!m.ok||!m.result.grant.pairingUrl)process.exit(4);process.stdout.write(m.result.grant.pairingUrl+'\\n')})`
  const script = `set -eu
# forge:pair-link
PATH="$PATH:/usr/sbin:/sbin"
dir=${q(forge.dataDir)}
pid=$(head -n 1 "$dir/runtime.lock")
node=$(readlink "/proc/$pid/exe" 2>/dev/null || lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)
test -x "$node" || node=$(command -v node) || { echo FORGE_PAIRING >&2; exit 1; }
"$node" -e ${q(client)} "$dir/${ENDPOINT}" || { echo FORGE_PAIRING >&2; exit 1; }
`
  let output: string
  try {
    output = await driver.run(hostAlias, script, { timeoutMs: 30_000, maxBytes: 4096 })
  } catch {
    throw new Error('The Forge on this host could not issue a pairing link. Check that it is running, then try again.')
  }
  const link = output.trim()
  let url: URL
  try {
    url = new URL(link)
  } catch {
    throw new Error('The host did not return a valid pairing link.')
  }
  const fields = new URLSearchParams(url.hash.slice(1))
  if (
    url.origin !== forge.publicUrl ||
    url.pathname !== '/pair' ||
    fields.get('v') !== '1' ||
    !UUID.test(fields.get('environmentId') ?? '') ||
    !UUID.test(fields.get('grantId') ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(fields.get('secret') ?? '')
  )
    throw new Error('The host did not return a valid pairing link for its address.')
  return link
}
