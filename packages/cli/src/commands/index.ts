import { resolveCliConfig } from '../config.js'
import { ForgeClient, type ForgeClientLike } from '../forge-client.js'
import { CliError, type CliIo, renderError, writeHuman } from '../output.js'
import { CLI_VERSION, EXIT_CODES } from '../version.js'
import { handleServeCommand } from './serve.js'
import { handlePairCommand, loadCliCredential, loadOsCliCredential, parsePairTarget } from './pair.js'
import { handleEnvironmentCommand } from './environment.js'
import { handleBrowserCommand } from './browser.js'
import { handlePairLinkCommand } from './pair-link.js'
import { handleConfigCommand } from './config.js'
import { commandHelp, mainHelp } from './help.js'
import {
  handleChoicesMutationCommand,
  handleProjectAgentsMutationCommand,
  handleSessionsMutationCommand,
  handleWorkersMutationCommand,
} from './mutations.js'
import { parseArgs } from './parser.js'
import {
  handleAgentsCommand,
  handleChoicesCommand,
  handleDoctorCommand,
  handleProfilesCommand,
  handleProjectAgentsCommand,
  handleSessionsCommand,
  handleStatusCommand,
} from './read.js'
import { handleRunCommand, handleWaitCommand } from './run.js'
import type { CommandContext, ParsedArgs } from './types.js'

export interface RunCliOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  io?: CliIo
  createClient?: (args: ParsedArgs) => Promise<ForgeClientLike>
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr }
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    const rendered = renderError(error, false)
    io.stderr.write(rendered.text)
    return rendered.exitCode
  }

  if (args.options.version) {
    writeHuman(io, args.options, CLI_VERSION)
    return EXIT_CODES.success
  }

  if (args.options.help || args.positionals.length === 0) {
    writeHuman(io, args.options, commandHelp(args.positionals[0]))
    return EXIT_CODES.success
  }

  const context: CommandContext = {
    args,
    io,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    createClient: options.createClient
      ? () => options.createClient!(args)
      : () => createDefaultClient(args, options.cwd ?? process.cwd(), options.env ?? process.env),
  }

  try {
    switch (args.positionals[0]) {
      case 'serve': return await handleServeCommand(context)
      case 'pair': return await handlePairCommand(context)
      case 'pair-link': return await handlePairLinkCommand(context)
      case 'environment': return await handleEnvironmentCommand(context)
      case 'browser': return await handleBrowserCommand(context)
      case 'status':
        return await handleStatusCommand(context)
      case 'doctor':
        return await handleDoctorCommand(context)
      case 'config':
        return await handleConfigCommand(context)
      case 'profiles':
        return await handleProfilesCommand(context)
      case 'sessions':
        return isSessionMutationAction(args.positionals[1])
          ? await handleSessionsMutationCommand(context)
          : await handleSessionsCommand(context)
      case 'agents':
        return await handleAgentsCommand(context)
      case 'workers':
        return await handleWorkersMutationCommand(context)
      case 'project-agents':
        return args.positionals[1] === 'send'
          ? await handleProjectAgentsMutationCommand(context)
          : await handleProjectAgentsCommand(context)
      case 'choices':
        return isChoiceMutationAction(args.positionals[1])
          ? await handleChoicesMutationCommand(context)
          : await handleChoicesCommand(context)
      case 'run':
        return await handleRunCommand(context, 'run')
      case 'launch':
        return await handleRunCommand(context, 'launch')
      case 'wait':
        return await handleWaitCommand(context)
      default:
        throw new CliError(`Unknown command: ${args.positionals[0]}`, { exitCode: EXIT_CODES.usage, code: 'unknown_command' })
    }
  } catch (error) {
    const rendered = renderError(error, Boolean(args.options.json))
    io.stderr.write(rendered.text)
    if (!args.options.json) io.stderr.write(`\nRun 'forge --help' for usage.\n`)
    return rendered.exitCode
  }
}

async function createDefaultClient(args: ParsedArgs, cwd: string, env: NodeJS.ProcessEnv): Promise<ForgeClientLike> {
  const resolved = await resolveCliConfig({
    cwd,
    env,
    flagUrl: args.options.url,
    flagApiKey: args.options.apiKey,
  })
  const environmentId = args.options.environmentId ?? env.FORGE_ENVIRONMENT_ID;
  const credentialFile = args.options.credentialFile ?? env.FORGE_CREDENTIAL_FILE;
  if (credentialFile || environmentId) {
    const credential = credentialFile ? await loadCliCredential(credentialFile) : await loadOsCliCredential(environmentId!, resolved.url);
    if (environmentId && environmentId !== credential.environmentId) throw new CliError('Credential environment identity mismatch.', { exitCode: EXIT_CODES.auth, code: 'identity_mismatch' });
    if (resolved.url && parsePairTarget(resolved.url).baseUrl !== credential.baseUrl)
      throw new CliError('The supplied URL differs from the paired credential URL. Pair the new URL explicitly, or omit the URL override.', { exitCode: EXIT_CODES.usage, code: 'credential_url_mismatch' });
    return new ForgeClient({ credential });
  }
  if (resolved.url && resolved.apiKey) return new ForgeClient({ url: resolved.url, apiKey: resolved.apiKey });
  throw new CliError('Select paired credentials with --credential-file <absolute-file> or --environment-id <UUID>. Run forge pair to pair this environment.', { exitCode: EXIT_CODES.usage, code: 'missing_environment_credential' });

}

function isSessionMutationAction(action: string | undefined): boolean {
  return action === 'create' ||
    action === 'send' ||
    action === 'wait' ||
    action === 'stop' ||
    action === 'resume' ||
    action === 'fork' ||
    action === 'switch' ||
    action === 'merge-back' ||
    action === 'compact' ||
    action === 'rename' ||
    action === 'pin' ||
    action === 'unpin' ||
    action === 'clear' ||
    action === 'delete'
}

function isChoiceMutationAction(action: string | undefined): boolean {
  return action === 'answer' || action === 'cancel'
}

export { mainHelp, parseArgs }
