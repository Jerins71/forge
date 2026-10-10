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
  | 'browser_host_register'
  | 'browser_host_hydrate'
  | 'browser_host_state_report'
  | 'browser_panel_reveal_acknowledge'
  | 'browser_tab_open'
  | 'browser_tab_activate'
  | 'browser_tab_close'
  | 'browser_tab_resize'
  | 'browser_recording_start'
  | 'browser_recording_stop'
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
  | 'browser_host_connected'
  | 'browser_host_hydration_chunk'
  | 'browser_host_state_report_result'
  | 'browser_panel_reveal_acknowledged'
  | 'browser_tab_command_succeeded'
  | 'browser_recording_command_succeeded'
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
    commandType: 'browser_host_register',
    resultFamily: 'browser_host_register',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_host_connected'],
    errorCodeFragments: ['browser_host_register'],
  },
{
    commandType: 'browser_host_hydrate',
    resultFamily: 'browser_host_hydrate',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_host_hydration_chunk'],
    errorCodeFragments: ['browser_host_hydrate', 'stale_host_generation'],
  },
{
    commandType: 'browser_panel_reveal_acknowledge',
    resultFamily: 'browser_panel_reveal_acknowledge',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_panel_reveal_acknowledged'],
    errorCodeFragments: ['browser_panel_reveal_acknowledge', 'stale_host_generation', 'intent_mismatch'],
  },
{
    commandType: 'browser_host_state_report',
    resultFamily: 'browser_host_state_report',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_host_state_report_result'],
    errorCodeFragments: ['browser_host_state_report'],
  },
{
    commandType: 'browser_recording_start',
    resultFamily: 'browser_recording_start',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_recording_command_succeeded'],
    errorCodeFragments: ['browser_recording_start', 'browser_unavailable', 'browser_tab_not_found'],
  },
{
    commandType: 'browser_recording_stop',
    resultFamily: 'browser_recording_stop',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_recording_command_succeeded'],
    errorCodeFragments: ['browser_recording_stop', 'browser_unavailable', 'browser_tab_not_found'],
  },
{
    commandType: 'browser_tab_open',
    resultFamily: 'browser_tab_mutation',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_tab_command_succeeded'],
    errorCodeFragments: ['browser_tab_open', 'browser_unavailable', 'browser_invalid_url'],
  },
{
    commandType: 'browser_tab_activate',
    resultFamily: 'browser_tab_mutation',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_tab_command_succeeded'],
    errorCodeFragments: ['browser_tab_activate', 'browser_tab_not_found'],
  },
{
    commandType: 'browser_tab_close',
    resultFamily: 'browser_tab_mutation',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_tab_command_succeeded'],
    errorCodeFragments: ['browser_tab_close', 'browser_tab_not_found'],
  },
{
    commandType: 'browser_tab_resize',
    resultFamily: 'browser_tab_mutation',
    requestId: { ui: 'required', wire: 'required' },
    successEvents: ['browser_tab_command_succeeded'],
    errorCodeFragments: ['browser_tab_resize', 'browser_tab_not_found', 'browser_invalid_viewport'],
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
