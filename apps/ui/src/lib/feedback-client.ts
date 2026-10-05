import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { FeedbackEvent, FeedbackState } from '@/lib/feedback-types'

function feedbackPath(profileId: string, sessionId: string): string {
  return `/api/v1/profiles/${encodeURIComponent(profileId)}/sessions/${encodeURIComponent(sessionId)}/feedback`
}

/** Feedback belongs to a session; `client` is the authenticated client of the session's environment. */
export async function submitFeedback(client: SettingsApiClient, params: {
  profileId: string
  sessionId: string
  scope: 'message' | 'session'
  targetId: string
  value: FeedbackEvent['value']
  reasonCodes?: string[]
  comment?: string
  channel?: FeedbackEvent['channel']
  clearKind?: 'vote' | 'comment'
}): Promise<FeedbackEvent> {
  const { profileId, sessionId, ...body } = params
  const payload = await client.fetchJson<{ feedback: FeedbackEvent }>(feedbackPath(profileId, sessionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: body.scope,
      targetId: body.targetId,
      value: body.value,
      reasonCodes: body.reasonCodes ?? [],
      comment: body.comment ?? '',
      channel: body.channel ?? 'web',
      ...(body.clearKind ? { clearKind: body.clearKind } : {}),
    }),
  })
  return payload.feedback
}

export async function fetchFeedbackStates(
  client: SettingsApiClient,
  profileId: string,
  sessionId: string,
): Promise<FeedbackState[]> {
  const payload = await client.fetchJson<{ states?: FeedbackState[] }>(`${feedbackPath(profileId, sessionId)}/state`)
  return payload.states ?? []
}
