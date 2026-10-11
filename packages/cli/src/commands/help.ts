export function mainHelp(): string {
  return `Forge CLI

Usage:
  forge [global options] <command> [args]

Global options:
  --url <url>          Forge backend URL
  --environment-id <UUID>   Select a paired environment in OS credential storage
  --credential-file <file>  Select an explicit paired credential file
  --api-key <key>     API key for retained HTTP read commands
  --json              Emit JSON output
  --quiet             Suppress human stdout
  -h, --help          Show help
  -v, --version       Show version

Commands:
  serve [--backend-entry <absolute-file>] [--host <address>] [--port <n>] [--data-dir <absolute-directory>] [--pair --pair-output <absolute-file>]
  pair <url-or-host> [--credential-file <absolute-file>]
  environment rekey|adopt|restore --data-dir <absolute-directory>
  status
  doctor
  config get|set|unset|list
  profiles list|show <profileId>
  sessions list --profile <profileId>
  sessions show <agentId>
  sessions transcript <agentId> [--include-worker-updates] [--limit <n>] [--offset <n>]
  sessions compact <agentId> [--instructions <text>]
  sessions smart-compact <agentId> [--instructions <text>]
  sessions create|send|wait|stop|resume|fork|rename|pin|unpin|clear|delete ...
  sessions fork <agentId> [--label <label>] [--source latest|run:<runId>|message:<entryId>] [--model <provider>/<modelId> [--reasoning <level>]]
  sessions switch <agentId> --model <provider>/<modelId> [--reasoning <level>]
  sessions merge-back <agentId> [--source latest|run:<runId>|message:<entryId>]
  sessions lineage <agentId>
  workers continue <workerId> [--session <agentId>] [--label <label>]
  agents list [--profile <profileId>]
  agents show <agentId>
  project-agents list --profile <profileId>
  project-agents show --profile <profileId> <handle>
  project-agents send --profile <profileId> <handle> --message <text|@file>
  run (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file>
  launch (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file>
  wait <agentId> [--timeout <duration>] [--stop-on-timeout]
  choices list [--session <agentId>] [--profile <profileId>]
  choices show|answer|cancel ...
`
}

export function commandHelp(command: string | undefined): string {
  switch (command) {
    case 'serve':
      return 'Usage: forge serve [--backend-entry <absolute-file>] [--host <address>] [--port <0..65535>] [--data-dir <absolute-directory>] [--public-url <https-origin>] [--tls-cert <absolute-file> --tls-key <absolute-file>] [--tailscale-serve] [--pair [--pair-output <absolute-file>]]\n\nRuns the ordinary installed Forge backend in the foreground. The standalone CLI does not include backend assets. Remote binding requires a public HTTPS URL and TLS plan. Noninteractive pairing requires a new protected output file.'
    case 'pair':
      return 'Usage: forge pair <url-or-host> [--credential-file <absolute-file>] [--environment-id <uuid>] [--scopes <comma-separated>]\n\nEnter a pairing link or code privately at the terminal. Stores the session in OS credential storage where available; an explicit owner-only fallback file is supported.'
    case 'environment':
      return 'Usage: forge environment rekey|adopt|restore --data-dir <absolute-directory> [--backend-entry <absolute-file>] [--from-data-dir <previous-directory>]\n\nLocal recovery runs under the ordinary backend runtime lock. Re-key assigns a new identity and revokes sessions; adopt retires the old data-path binding; restore rotates the stream epoch and revokes stale tokens.'
    case 'status':
      return 'Usage: forge status [--json]\n\nShows Forge CLI API status and capability summary.'
    case 'doctor':
      return 'Usage: forge doctor [--json]\n\nChecks local config, authentication, server status, and advertised CLI capabilities.'
    case 'config':
      return 'Usage: forge config get|set|unset|list [url|apiKey] [value]\n\nManages local Forge CLI config only.'
    case 'profiles':
      return 'Usage: forge profiles list | forge profiles show <profileId>'
    case 'sessions':
      return 'Usage: forge sessions list --profile <profileId> | show <agentId> | transcript <agentId> [--include-worker-updates] [--limit <n>] [--offset <n>] | create --profile <profileId> [--label <label>] [--name <name>] | send <agentId> --message <text|@file> | wait <agentId> [--timeout <duration>] [--stop-on-timeout] | stop|resume <agentId> | fork <agentId> [--label <label>] [--from-message-id <messageId>] [--source latest|run:<runId>|message:<entryId>] [--model <provider>/<modelId> [--reasoning <level>]] | switch <agentId> --model <provider>/<modelId> [--reasoning <level>] | merge-back <agentId> [--source latest|run:<runId>|message:<entryId>] | lineage <agentId> | compact <agentId> [--instructions <text>] | smart-compact <agentId> [--instructions <text>] | rename <agentId> --label <label> | pin|unpin <agentId> [--pinned true|false] | clear|delete <agentId> --yes\n\nTranscript defaults to user-facing messages only. Add --include-worker-updates for worker results. Compact commands use paired native session controls and wait for the backend compaction receipt to finish or fail. Smart compaction may skip or report not_reduced when the runtime decides compaction is unnecessary. Destructive session commands require --yes. Switch hands the same session off to another provider or model. Merge-back returns a fork to its lineage parent. Fork points, switch, merge-back and lineage need an environment that advertises context transfers.'
    case 'workers':
      return 'Usage: forge workers continue <workerId> [--session <agentId>] [--label <label>]\n\nContinues a finished worker as a normal conversation and reports the new session. The owning session is resolved from the worker unless --session is given.'
    case 'agents':
      return 'Usage: forge agents list [--profile <profileId>] | forge agents show <agentId>'
    case 'project-agents':
      return 'Usage: forge project-agents list --profile <profileId> | show --profile <profileId> <handle> | send --profile <profileId> <handle> --message <text|@file>'
    case 'run':
      return 'Usage: forge run (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file> [--label <label>] [--timeout <duration>] [--stop-on-timeout]\n\nTimeout examples: 5000, 30s, 5m. When --stop-on-timeout is set and the run times out, Forge stops the session through native controls and reports stoppedOnTimeout in the result.'
    case 'launch':
      return 'Usage: forge launch (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file> [--label <label>]'
    case 'wait':
      return 'Usage: forge wait <agentId> [--timeout <duration>] [--stop-on-timeout]\n\nTimeout examples: 5000, 30s, 5m. When --stop-on-timeout is set and the wait times out, Forge stops the session through native controls and reports stoppedOnTimeout in the result.'
    case 'choices':
      return 'Usage: forge choices list [--session <agentId>] [--profile <profileId>] | show <choiceId> [--session <agentId>] | answer <choiceId> --answers <json> [--session <agentId>] | cancel <choiceId> [--session <agentId>]\n\nAnswers must be a JSON array like [{"questionId":"q1","selectedOptionIds":["yes"]}]. Add "text" when the question allows free-text input.'
    default:
      return mainHelp()
  }
}
