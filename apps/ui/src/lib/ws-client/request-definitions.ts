import {
  type AgentSessionPurpose,
  type BrowserHostLifecycleResponse,
  type BrowserHostRegistration,
  type BrowserHostSessionStateReport,
  type BrowserViewportSetting,
  type BuilderTimelineChannelView,
  type ChoiceAnswer,
  type CodexElicitationDecision,
  type CodexElicitationPersistScope,
  type ClientCommand,
  type ConversationAttachment,
  type ConversationReplyTargetInput,
  type DeliveryMode,
  type SessionProjectAgentInput,
  type SessionGoalControlAction,
} from '@forge/protocol'

export const RECONNECTING_SOCKET_ERROR = 'WebSocket is disconnected. Reconnecting...'
const DISCONNECTED_SOCKET_ERROR = 'WebSocket is disconnected.'

export function isSocketOpen(socket: WebSocket | null): socket is WebSocket {
  return Boolean(socket && socket.readyState === WebSocket.OPEN)
}

function requireTrimmedValue(value: string, errorMessage: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(errorMessage)
  }

  return trimmed
}

export function assertReconnectableSocket(socket: WebSocket | null): asserts socket is WebSocket {
  if (!isSocketOpen(socket)) {
    throw new Error(RECONNECTING_SOCKET_ERROR)
  }
}

export function assertConnectedSocket(socket: WebSocket | null): asserts socket is WebSocket {
  if (!isSocketOpen(socket)) {
    throw new Error(DISCONNECTED_SOCKET_ERROR)
  }
}

export function buildSubscribeCommand(
  agentId: string | null | undefined,
  conversationView: BuilderTimelineChannelView,
  subscriptionId: string,
): ClientCommand {
  return {
    type: 'subscribe',
    agentId: agentId ?? undefined,
    conversationPaging: true,
    conversationView,
    subscriptionId,
  }
}

export function buildBrowserHostRegisterCommand(requestId: string, registration: BrowserHostRegistration): ClientCommand {
  return { type: 'browser_host_register', requestId, registration }
}

export function buildBrowserHostHydrateCommand(requestId: string, hostId: string, hostGeneration: number): ClientCommand {
  return { type: 'browser_host_hydrate', requestId, hostId, hostGeneration }
}

export function buildBrowserHostFocusCommand(hostId: string, hostGeneration: number, focused: boolean): ClientCommand {
  return { type: 'browser_host_focus', hostId, hostGeneration, focused }
}

export function buildBrowserHostResponseCommand(response: Extract<ClientCommand, { type: 'browser_host_response' }>['response']): ClientCommand {
  return { type: 'browser_host_response', response }
}

export function buildBrowserHostLifecycleResponseCommand(response: BrowserHostLifecycleResponse): ClientCommand {
  return { type: 'browser_host_lifecycle_response', response }
}

export function buildBrowserHostStateReportCommand(
  requestId: string,
  hostId: string,
  hostGeneration: number,
  sessions: BrowserHostSessionStateReport[],
): ClientCommand {
  return { type: 'browser_host_state_report', requestId, hostId, hostGeneration, sessions }
}

export function buildBrowserPanelRevealAcknowledgeCommand(options: {
  requestId: string
  hostId: string
  hostGeneration: number
  sessionAgentId: string
  profileId: string
  tabId: string
  sequence: number
}): ClientCommand {
  return { type: 'browser_panel_reveal_acknowledge', ...options }
}

export function buildBrowserTabOpenCommand(
  sessionAgentId: string,
  profileId: string,
  requestId: string,
  options?: { url?: string; activate?: boolean },
): ClientCommand {
  return { type: 'browser_tab_open', requestId, sessionAgentId, profileId, ...options }
}

export function buildBrowserTabActivateCommand(sessionAgentId: string, tabId: string, requestId: string): ClientCommand {
  return { type: 'browser_tab_activate', requestId, sessionAgentId, tabId }
}

export function buildBrowserTabCloseCommand(sessionAgentId: string, tabId: string, requestId: string): ClientCommand {
  return { type: 'browser_tab_close', requestId, sessionAgentId, tabId }
}

export function buildBrowserTabResizeCommand(
  sessionAgentId: string,
  tabId: string,
  viewport: BrowserViewportSetting,
  requestId: string,
): ClientCommand {
  return { type: 'browser_tab_resize', requestId, sessionAgentId, tabId, viewport }
}

export function buildBrowserRecordingStartCommand(sessionAgentId: string, tabId: string, requestId: string): ClientCommand {
  return { type: 'browser_recording_start', requestId, sessionAgentId, tabId }
}

export function buildBrowserRecordingStopCommand(sessionAgentId: string, tabId: string, recordingId: string, requestId: string): ClientCommand {
  return { type: 'browser_recording_stop', requestId, sessionAgentId, tabId, recordingId }
}

export function buildRestartRecoveryActionCommand(
  type: 'resume_restart_recovery' | 'dismiss_restart_recovery',
): ClientCommand {
  return { type }
}

export function buildSessionGoalControlCommand(
  agentId: string,
  action: SessionGoalControlAction,
): ClientCommand {
  return { type: 'session_goal_control', agentId, ...action }
}

export function buildMarkUnreadCommand(agentId: string): ClientCommand {
  return {
    type: 'mark_unread',
    agentId,
  }
}

export function buildMarkAllReadCommand(profileId: string): ClientCommand {
  return {
    type: 'mark_all_read',
    profileId,
  }
}

export function buildDismissSessionAttentionCommand(
  attentionIds: string[],
  requestId: string,
): ClientCommand {
  return {
    type: 'dismiss_session_attention',
    attentionIds,
    requestId,
  }
}

export function buildUserMessageCommand(input: {
  text: string
  agentId: string
  delivery?: DeliveryMode
  attachments?: ConversationAttachment[]
  replyTo?: ConversationReplyTargetInput
  clientRequestId?: string
  sessionReferenceAgentIds?: string[]
}): ClientCommand {
  return {
    type: 'user_message',
    text: input.text,
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
    replyTo: input.replyTo,
    agentId: input.agentId,
    delivery: input.delivery,
    clientRequestId: input.clientRequestId,
    sessionReferenceAgentIds: input.sessionReferenceAgentIds?.length ? input.sessionReferenceAgentIds : undefined,
  }
}

export function buildChoiceResponseCommand(
  agentId: string,
  choiceId: string,
  answers: ChoiceAnswer[],
): ClientCommand {
  return {
    type: 'choice_response',
    agentId,
    choiceId,
    answers,
  }
}

export function buildChoiceCancelCommand(agentId: string, choiceId: string): ClientCommand {
  return {
    type: 'choice_cancel',
    agentId,
    choiceId,
  }
}

export function buildCodexElicitationResponseCommand(
  agentId: string,
  elicitationId: string,
  decision: CodexElicitationDecision,
  values?: Record<string, unknown>,
  persistScope?: CodexElicitationPersistScope,
): ClientCommand {
  return { type: 'codex_elicitation_response', agentId, elicitationId, decision, values, persistScope }
}

export function buildPinMessageCommand(
  agentId: string,
  messageId: string,
  pinned: boolean,
): ClientCommand {
  return {
    type: 'pin_message',
    agentId,
    messageId,
    pinned,
  }
}

export function buildClearAllPinsCommand(agentId: string): ClientCommand {
  return {
    type: 'clear_all_pins',
    agentId,
  }
}

export function buildKillAgentCommand(agentId: string): ClientCommand {
  return {
    type: 'kill_agent',
    agentId,
  }
}

export function buildStopAllAgentsCommand(managerId: string, requestId: string): ClientCommand {
  return {
    type: 'stop_all_agents',
    managerId,
    requestId,
  }
}

export function buildCreateSessionCommand(
  profileId: string,
  name: string | undefined,
  opts: { sessionPurpose?: AgentSessionPurpose; label?: string } | undefined,
  requestId: string,
): ClientCommand {
  return {
    type: 'create_session',
    profileId: requireTrimmedValue(profileId, 'Profile id is required.'),
    name: name?.trim() || undefined,
    label: opts?.label?.trim() || undefined,
    sessionPurpose: opts?.sessionPurpose,
    requestId,
  }
}

export function buildSessionActionCommand(
  type: 'stop_session' | 'resume_session' | 'archive_session' | 'restore_session' | 'delete_session' | 'clear_session',
  agentId: string,
  requestId: string,
): ClientCommand {
  return {
    type,
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildRenameSessionCommand(
  agentId: string,
  label: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'rename_session',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    label: requireTrimmedValue(label, 'Session label is required.'),
    requestId,
  }
}

export function buildPinSessionCommand(
  agentId: string,
  pinned: boolean,
  requestId: string,
): ClientCommand {
  return {
    type: 'pin_session',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    pinned,
    requestId,
  }
}

export function buildHydrateArchiveLastUsedCommand(requestId: string): ClientCommand {
  return {
    type: 'hydrate_archive_last_used',
    requestId,
  }
}

export function buildForkSessionCommand(
  sourceAgentId: string,
  label: string | undefined,
  fromMessageId: string | undefined,
  requestId: string,
  sessionPurpose?: 'side_chat',
): ClientCommand {
  return {
    type: 'fork_session',
    sourceAgentId: requireTrimmedValue(sourceAgentId, 'Source agent id is required.'),
    label: label?.trim() || undefined,
    fromMessageId: fromMessageId?.trim() || undefined,
    ...(sessionPurpose ? { sessionPurpose } : {}),
    requestId,
  }
}

export function buildSetSessionProjectAgentCommand(
  agentId: string,
  projectAgent: SessionProjectAgentInput | null,
  requestId: string,
): ClientCommand {
  return {
    type: 'set_session_project_agent',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    projectAgent,
    requestId,
  }
}

export function buildGetProjectAgentConfigCommand(agentId: string, requestId: string): ClientCommand {
  return {
    type: 'get_project_agent_config',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildListProjectAgentReferencesCommand(
  agentId: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'list_project_agent_references',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildGetProjectAgentReferenceCommand(
  agentId: string,
  fileName: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'get_project_agent_reference',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    fileName: requireTrimmedValue(fileName, 'File name is required.'),
    requestId,
  }
}

export function buildSetProjectAgentReferenceCommand(
  agentId: string,
  fileName: string,
  content: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'set_project_agent_reference',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    fileName: requireTrimmedValue(fileName, 'File name is required.'),
    content,
    requestId,
  }
}

export function buildDeleteProjectAgentReferenceCommand(
  agentId: string,
  fileName: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'delete_project_agent_reference',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    fileName: requireTrimmedValue(fileName, 'File name is required.'),
    requestId,
  }
}

export function buildRequestProjectAgentRecommendationsCommand(
  agentId: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'request_project_agent_recommendations',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildGetProjectAgentSharingCommand(agentId: string, requestId: string): ClientCommand {
  return {
    type: 'get_project_agent_sharing',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildSetProjectAgentSharingCommand(
  agentId: string,
  targetProfileIds: string[],
  requestId: string,
): ClientCommand {
  return {
    type: 'set_project_agent_sharing',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    targetProfileIds,
    requestId,
  }
}

export function buildGetProjectAgentExternalDirectoryCommand(requestId: string): ClientCommand {
  return {
    type: 'get_project_agent_external_directory',
    requestId,
  }
}

export function buildGetSessionWorkersCommand(
  sessionAgentId: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'get_session_workers',
    sessionAgentId: requireTrimmedValue(sessionAgentId, 'Session agent id is required.'),
    requestId,
  }
}

export function buildGetConversationPageCommand(
  agentId: string,
  cursor: string,
  requestId: string,
  limit?: number,
  view?: BuilderTimelineChannelView,
): ClientCommand {
  return {
    type: 'get_conversation_page',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    cursor: requireTrimmedValue(cursor, 'Conversation cursor is required.'),
    ...(limit === undefined ? {} : { limit }),
    ...(view ? { view } : {}),
    requestId,
  }
}
