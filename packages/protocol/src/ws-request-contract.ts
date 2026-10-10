import type { ClientCommand } from './client-commands.js'
import type { ServerEvent } from './server-events.js'

export type WsRequestIdPolicy = {
  ui: 'required'
  wire: 'optional' | 'required'
}

export type WsRequestContract<
  CommandType extends Extract<ClientCommand['type'], string> = Extract<ClientCommand['type'], string>,
  SuccessEventType extends Extract<ServerEvent['type'], string> = Extract<ServerEvent['type'], string>,
> = {
  commandType: CommandType
  resultFamily: string
  requestId: WsRequestIdPolicy
  successEvents: readonly SuccessEventType[]
  errorCodeFragments: readonly string[]
}

type ContractCommandType = Extract<
  ClientCommand['type'],
  | 'get_session_workers'
  | 'get_conversation_page'
  | 'dismiss_session_attention'
  | 'subscribe_inventory'
  | 'rename_session'
  | 'pin_session'
  | 'fork_session'
  | 'stop_all_agents'
  | 'create_session'
  | 'stop_session'
  | 'resume_session'
  | 'hydrate_archive_last_used'
  | 'archive_session'
  | 'restore_session'
  | 'delete_session'
  | 'clear_session'
>
type ContractSuccessEventType = Extract<
  ServerEvent['type'],
  | 'session_workers_snapshot'
  | 'conversation_history'
  | 'conversation_page'
  | 'session_attention_update'
  | 'inventory_snapshot'
  | 'session_renamed'
  | 'session_pinned'
  | 'session_forked'
  | 'stop_all_agents_result'
  | 'session_created'
  | 'session_stopped'
  | 'session_resumed'
  | 'archive_last_used_hydrated'
  | 'session_archived'
  | 'session_restored'
  | 'session_deleted'
  | 'session_cleared'
  | 'session_goal_snapshot'
>

export const WS_REQUEST_CONTRACTS = [
{
    commandType: 'subscribe_inventory',
    resultFamily: 'inventory_snapshot',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['inventory_snapshot'],
    errorCodeFragments: ['inventory'],
  },
{
    commandType: 'get_session_workers',
    resultFamily: 'session_workers',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_workers_snapshot'],
    errorCodeFragments: ['get_session_workers'],
  },
{
    commandType: 'get_conversation_page',
    resultFamily: 'conversation_page',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['conversation_page'],
    errorCodeFragments: ['get_conversation_page'],
  },
{
    commandType: 'dismiss_session_attention',
    resultFamily: 'session_attention_update',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['session_attention_update'],
    errorCodeFragments: ['dismiss_session_attention'],
  },
{
    commandType: 'rename_session',
    resultFamily: 'session_rename',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_renamed'],
    errorCodeFragments: ['rename_session'],
  },
{
    commandType: 'pin_session',
    resultFamily: 'session_pin',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_pinned'],
    errorCodeFragments: ['pin_session'],
  },
{
    commandType: 'fork_session',
    resultFamily: 'session_fork',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_forked'],
    errorCodeFragments: ['fork_session'],
  },
  {
    commandType: 'stop_all_agents',
    resultFamily: 'stop_all_agents',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['stop_all_agents_result'],
    errorCodeFragments: ['stop_all_agents'],
  },
{
    commandType: 'create_session',
    resultFamily: 'session_create',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_created'],
    errorCodeFragments: ['create_session'],
  },
{
    commandType: 'stop_session',
    resultFamily: 'session_stop',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_stopped'],
    errorCodeFragments: ['stop_session'],
  },
{
    commandType: 'resume_session',
    resultFamily: 'session_resume',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_resumed'],
    errorCodeFragments: ['resume_session'],
  },
{
    commandType: 'hydrate_archive_last_used',
    resultFamily: 'archive_last_used_hydration',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['archive_last_used_hydrated'],
    errorCodeFragments: ['hydrate_archive_last_used'],
  },
{
    commandType: 'archive_session',
    resultFamily: 'archive_session_result',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_archived'],
    errorCodeFragments: [
      'archive_session',
      'ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED',
    ],
  },
{
    commandType: 'restore_session',
    resultFamily: 'restore_session_result',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_restored'],
    errorCodeFragments: [
      'restore_session',
      'ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED',
    ],
  },
{
    commandType: 'delete_session',
    resultFamily: 'session_delete',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_deleted'],
    errorCodeFragments: ['delete_session'],
  },
{
    commandType: 'clear_session',
    resultFamily: 'session_clear',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_cleared'],
    errorCodeFragments: ['clear_session'],
  },

] as const satisfies readonly WsRequestContract<ContractCommandType, ContractSuccessEventType>[]

export type WsRequestContractType = (typeof WS_REQUEST_CONTRACTS)[number]['commandType']

export const WS_REQUEST_CONTRACT_TYPES = WS_REQUEST_CONTRACTS.map((contract) => contract.commandType)

export function getWsRequestContract(commandType: WsRequestContractType): (typeof WS_REQUEST_CONTRACTS)[number] {
  const contract = WS_REQUEST_CONTRACTS.find((candidate) => candidate.commandType === commandType)
  if (!contract) {
    throw new Error(`Unknown WebSocket request contract: ${commandType}`)
  }
  return contract
}
