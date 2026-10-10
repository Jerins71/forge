import { getWsRequestContract, WS_REQUEST_CONTRACTS } from '@forge/protocol'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import type { AgentActivityEntry } from '../ws-state'
import type { WsRequestErrorHint, WsRequestType } from './types'

export const INITIAL_CONNECT_DELAY_MS = 50
export const RECONNECT_MS = 1200
export const REQUEST_TIMEOUT_MS = 300_000
export const SESSION_WORKERS_REFETCH_DEBOUNCE_MS = 250
/**
 * get_session_workers is a small, cheap fetch whose pending promise de-duplicates
 * every other fetch trigger for the same session. If the response is lost, the
 * default 5-minute timeout would strand the sidebar/pill worker lists — time out
 * fast instead and let SessionWorkerCache's failure retry re-dispatch.
 */
export const SESSION_WORKERS_REQUEST_TIMEOUT_MS = 15_000
export const CONVERSATION_PAGE_REQUEST_TIMEOUT_MS = 30_000
/** Base delay for SessionWorkerCache's bounded retry after a failed fetch (grows linearly). */
export const SESSION_WORKERS_RETRY_BASE_MS = 2_000
/** Max consecutive failed fetches per session before the cache stops retrying automatically. */
export const SESSION_WORKERS_MAX_FETCH_RETRIES = 3
// Keep client-side activity retention aligned with backend history retention.
export const MAX_CLIENT_CONVERSATION_HISTORY = 2000

function uniqueRequestTypes(requestTypes: readonly WsRequestType[]): WsRequestType[] {
  return [...new Set(requestTypes)]
}

function uniqueErrorHints(errorHints: readonly WsRequestErrorHint[]): WsRequestErrorHint[] {
  const seen = new Set<string>()
  return errorHints.filter((hint) => {
    const key = `${hint.requestType}:${hint.codeFragment}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}


const FORK_SESSION_CONTRACT = getWsRequestContract('fork_session')

const STOP_ALL_AGENTS_CONTRACT = getWsRequestContract('stop_all_agents')

const CREATE_SESSION_CONTRACT = getWsRequestContract('create_session')
const CLEAR_SESSION_CONTRACT = getWsRequestContract('clear_session')
const STOP_SESSION_CONTRACT = getWsRequestContract('stop_session')
const RESUME_SESSION_CONTRACT = getWsRequestContract('resume_session')
const DELETE_SESSION_CONTRACT = getWsRequestContract('delete_session')
const LEGACY_POSITION_CONTRACT_TYPES = new Set<string>([
  FORK_SESSION_CONTRACT.commandType,
  STOP_ALL_AGENTS_CONTRACT.commandType,
  CREATE_SESSION_CONTRACT.commandType,
  CLEAR_SESSION_CONTRACT.commandType,
  STOP_SESSION_CONTRACT.commandType,
  RESUME_SESSION_CONTRACT.commandType,
  DELETE_SESSION_CONTRACT.commandType,
])
const NON_LEGACY_POSITION_CONTRACTS = WS_REQUEST_CONTRACTS.filter(
  (contract) => !LEGACY_POSITION_CONTRACT_TYPES.has(contract.commandType),
)


const FORK_SESSION_ERROR_HINTS = FORK_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: FORK_SESSION_CONTRACT.commandType,
  codeFragment,
}))

const STOP_ALL_AGENTS_ERROR_HINTS = STOP_ALL_AGENTS_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: STOP_ALL_AGENTS_CONTRACT.commandType,
  codeFragment,
}))

const CREATE_SESSION_ERROR_HINTS = CREATE_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: CREATE_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const CLEAR_SESSION_ERROR_HINTS = CLEAR_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: CLEAR_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const STOP_SESSION_ERROR_HINTS = STOP_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: STOP_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const RESUME_SESSION_ERROR_HINTS = RESUME_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: RESUME_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const DELETE_SESSION_ERROR_HINTS = DELETE_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: DELETE_SESSION_CONTRACT.commandType,
  codeFragment,
}))

export const WS_REQUEST_TYPES: WsRequestType[] = uniqueRequestTypes([
  STOP_ALL_AGENTS_CONTRACT.commandType,
  CREATE_SESSION_CONTRACT.commandType,
  STOP_SESSION_CONTRACT.commandType,
  RESUME_SESSION_CONTRACT.commandType,
  DELETE_SESSION_CONTRACT.commandType,
  CLEAR_SESSION_CONTRACT.commandType,
  FORK_SESSION_CONTRACT.commandType,
  ...NON_LEGACY_POSITION_CONTRACTS.map((contract) => contract.commandType),
])

export const WS_REQUEST_ERROR_HINTS: WsRequestErrorHint[] = uniqueErrorHints([
  ...STOP_ALL_AGENTS_ERROR_HINTS,
  ...CREATE_SESSION_ERROR_HINTS,
  ...STOP_SESSION_ERROR_HINTS,
  ...RESUME_SESSION_ERROR_HINTS,
  ...DELETE_SESSION_ERROR_HINTS,
  ...CLEAR_SESSION_ERROR_HINTS,
  ...FORK_SESSION_ERROR_HINTS,
  ...NON_LEGACY_POSITION_CONTRACTS.flatMap((contract) =>
    contract.errorCodeFragments.map((codeFragment) => ({ requestType: contract.commandType, codeFragment })),
  )
])

export function isManagerAgent(agent: AgentDescriptor): boolean {
  return agent.role === 'manager'
}

export function isWorkerAgent(agent: AgentDescriptor): boolean {
  return agent.role === 'worker'
}

export function isAgentActivityEntry(entry: ConversationEntry): entry is AgentActivityEntry {
  return entry.type === 'agent_message' || entry.type === 'agent_tool_call' || entry.type === 'activity_summary'
}
