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
  | 'subscribe_inventory'
  | 'fork_session'
  | 'stop_all_agents'
  | 'create_session'
  | 'stop_session'
  | 'resume_session'
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
  | 'inventory_snapshot'
  | 'session_forked'
  | 'stop_all_agents_result'
  | 'session_created'
  | 'session_stopped'
  | 'session_resumed'
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
