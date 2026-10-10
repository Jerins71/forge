import type { SubscribeInventoryCommand } from './builder-inventory.js'
import type { ConversationAttachment } from './attachments.js'
import type { ConversationReplyTargetInput } from './conversation-events.js'
import type { BuilderTimelineChannelView } from './builder-timeline-visibility.js'
import type {
  AgentSessionPurpose,
  ChoiceAnswer,
  DeliveryMode,
} from './shared-types.js'

export interface ApiProxyCommand {
  type: 'api_proxy'
  requestId: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: string
}

export type ClientCommand =
  SubscribeInventoryCommand
  | {
      type: 'subscribe'
      agentId?: string
      messageCount?: number
      /** Correlates this request with its conversation bootstrap snapshots. */
      subscriptionId?: string
      /** New clients advertise this so older clients retain the legacy bootstrap contract. */
      conversationPaging?: true
      /** Paging view is cursor-bound; switching views starts a fresh replace bootstrap. */
      conversationView?: BuilderTimelineChannelView
      /** Advertises support for request-correlated session goal control results. */
      goalControlRequestId?: true
    }
  | {
      type: 'user_message'
      text: string
      attachments?: ConversationAttachment[]
      agentId?: string
      delivery?: DeliveryMode
      replyTo?: ConversationReplyTargetInput
      /**
       * Client-generated id echoed back on the resulting broadcast
       * `conversation_message` so the sender can replace its optimistic
       * entry instead of appending a duplicate (multi-writer dedup).
       */
      clientRequestId?: string
      /** Manager sessions referenced in the text (dragged in as [@name]); linked as peers. */
      sessionReferenceAgentIds?: string[]
    }
  | ApiProxyCommand
  | { type: 'kill_agent'; agentId: string }
  | { type: 'stop_all_agents'; managerId: string; requestId?: string }
  | { type: 'create_session'; profileId: string; label?: string; name?: string; sessionPurpose?: AgentSessionPurpose; requestId?: string }
  | { type: 'stop_session'; agentId: string; requestId?: string }
  | { type: 'resume_session'; agentId: string; requestId?: string }
  | { type: 'archive_session'; agentId: string; requestId?: string }
  | { type: 'restore_session'; agentId: string; requestId?: string }
  | { type: 'delete_session'; agentId: string; requestId?: string }
  | {
      type: 'fork_session'
      sourceAgentId: string
      label?: string
      fromMessageId?: string
      /** `side_chat` forks from the latest message and replaces the source's previous side chat. */
      sessionPurpose?: 'side_chat'
      requestId?: string
    }
  | { type: 'clear_session'; agentId: string; requestId?: string }
  | { type: 'get_session_workers'; sessionAgentId: string; requestId?: string }
  | {
      type: 'get_conversation_page'
      agentId: string
      cursor: string
      limit?: number
      view?: BuilderTimelineChannelView
      requestId: string
    }
  | { type: 'choice_response'; agentId: string; choiceId: string; answers: ChoiceAnswer[] }
  | { type: 'choice_cancel'; agentId: string; choiceId: string }
  | { type: 'ping' }
