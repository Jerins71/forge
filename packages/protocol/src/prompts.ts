export type PromptCategory = 'archetype' | 'operational'

export type PromptSourceLayer = 'profile' | 'repo' | 'builtin'

export interface PromptVariableDeclaration {
  name: string
  description: string
}

export interface PromptListEntry {
  category: PromptCategory
  promptId: string
  displayName: string
  description: string
  activeLayer: PromptSourceLayer
  hasProfileOverride: boolean
  variables: PromptVariableDeclaration[]
}

export interface PromptContentResponse {
  category: PromptCategory
  promptId: string
  content: string
  sourceLayer: PromptSourceLayer
  sourcePath: string
  variables: PromptVariableDeclaration[]
}

export interface PromptPreviewSection {
  label: string
  content: string
  source: string
}

export interface PromptPreviewResponse {
  sections: PromptPreviewSection[]
}

/** JSON-safe request context retained for the first Pi model call in a session. */
export type InitialModelInputJsonValue =
  | null
  | boolean
  | number
  | string
  | InitialModelInputJsonValue[]
  | { [key: string]: InitialModelInputJsonValue }

export interface PiInitialModelInputCaptureV1 {
  version: 1
  runtime: 'pi'
  capturedAt: string
  fidelity: {
    capturePoint: 'pi_stream_fn'
    context: 'exact_provider_independent'
    images: 'byte_summary'
    requestMetadata: 'safe_projection'
  }
  systemPrompt: string
  messages: InitialModelInputJsonValue[]
  tools: InitialModelInputJsonValue[]
  model: {
    provider: string
    id: string
    api?: string
  }
  requestMetadata: { [key: string]: InitialModelInputJsonValue }
}

/** Provider-reported usage associated with the captured first Pi request. */
export interface InitialModelInputTokenUsage {
  source: 'provider_reported'
  inputTokens: number
  uncachedInputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
}

export type AgentInitialModelInputState =
  | {
      status: 'available'
      capture: PiInitialModelInputCaptureV1
      /** Absent while the response is incomplete or when its provider did not report usage. */
      tokenUsage?: InitialModelInputTokenUsage
    }
  | {
      status: 'pending'
      message: string
    }
  | {
      status: 'unsupported'
      message: string
    }

/** Additive response for GET /api/agents/:id/system-prompt. */
export interface AgentSystemPromptResponse {
  agentId: string
  role: 'manager' | 'worker'
  systemPrompt: string | null
  model: string | null
  archetypeId: string | null
  initialModelInput: AgentInitialModelInputState
}
