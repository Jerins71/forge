import { setupLinuxBrowserSandbox } from '../../../../apps/backend/src/swarm/browser-automation/linux-browser-sandbox.js'
import { CliError, writeHuman, writeJson } from '../output.js'
import { EXIT_CODES } from '../version.js'
import type { CommandContext } from './types.js'

export async function handleBrowserCommand(context: CommandContext): Promise<number> {
  if (context.args.positionals[1] !== 'setup' || context.args.positionals.length !== 2)
    throw new CliError('Usage: forge browser setup', { exitCode: EXIT_CODES.usage, code: 'invalid_browser_command' })
  const result = await setupLinuxBrowserSandbox()
  if (result.state === 'root-required') {
    context.io.stderr.write(`This machine needs a one-time browser sandbox setup. Run exactly:\n${result.command}\n`)
    return EXIT_CODES.unsupported
  }
  if (context.args.options.json) writeJson(context.io, result)
  else writeHuman(context.io, context.args.options, result.state === 'installed' ? 'Forge browser host setup complete. Chromium’s sandbox remains enabled.' : 'No host setup is needed on this machine. Chromium’s sandbox remains enabled.')
  return EXIT_CODES.success
}
