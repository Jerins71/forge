import type { ManagerReasoningLevel } from './agents.js'

export const WORK_MODE_ID_MAX_LENGTH = 64

/**
 * Extensible, bounded identity used by discovery transports. It intentionally
 * remains wider than ManagerPosture so clients can preserve future server IDs.
 */
export type WorkModeId = string

export interface WorkModeDefinition<Id extends string = string> {
  id: Id
  label: string
  description: string
  selectable: boolean
  productDefault: boolean
}

/** Authoritative server-known Work Mode inventory and presentation metadata. */
export const WORK_MODE_DEFINITIONS = [
  {
    id: 'delegation_first',
    label: 'Delegate first',
    description: 'Workers execute substantive project work; the manager answers, performs bounded read-only orientation, and checks results.',
    selectable: true,
    productDefault: false,
  },
  {
    id: 'adaptive',
    label: 'Adaptive',
    description: 'Starts directly; delegates when the expected time, total cost, or independent assurance benefit outweighs handoff and verification overhead.',
    selectable: true,
    productDefault: false,
  },
  {
    id: 'hands_on',
    label: 'Hands-on',
    description: 'Executes investigation, implementation, and validation directly; delegates for explicit requests, unavailable capabilities, or concrete benefits from separable work.',
    selectable: true,
    productDefault: true,
  },
] as const satisfies readonly WorkModeDefinition[]

export type ManagerPosture = (typeof WORK_MODE_DEFINITIONS)[number]['id']

function workModeDefinitionIds<
  const Definitions extends readonly WorkModeDefinition[],
>(definitions: Definitions): {
  [Index in keyof Definitions]: Definitions[Index] extends WorkModeDefinition<infer Id> ? Id : never
} {
  return definitions.map((definition) => definition.id) as {
    [Index in keyof Definitions]: Definitions[Index] extends WorkModeDefinition<infer Id> ? Id : never
  }
}

/** Closed backend ingress/persistence values, derived from WORK_MODE_DEFINITIONS. */
export const MANAGER_POSTURES = workModeDefinitionIds(WORK_MODE_DEFINITIONS)

function resolveDefaultManagerPosture(): ManagerPosture {
  const defaults = WORK_MODE_DEFINITIONS.filter((definition) => definition.productDefault)
  if (defaults.length !== 1 || !defaults[0]) {
    throw new Error('WORK_MODE_DEFINITIONS must contain exactly one product default')
  }
  return defaults[0].id
}

export const DEFAULT_MANAGER_POSTURE: ManagerPosture = resolveDefaultManagerPosture()

export function isWorkModeId(value: unknown): value is WorkModeId {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= WORK_MODE_ID_MAX_LENGTH
    && /^[a-z][a-z0-9_-]*$/.test(value)
}

export function isManagerPosture(value: unknown): value is ManagerPosture {
  return isWorkModeId(value) && MANAGER_POSTURES.includes(value as ManagerPosture)
}

export const MANAGER_POSTURE_ORIGINS = [
  'product_default',
  'project_default',
  'session_override',
] as const
export type ManagerPostureOrigin = (typeof MANAGER_POSTURE_ORIGINS)[number]

export const DELEGATION_ROSTER_ORIGINS = [
  'global_default',
  'project_default',
  'session_override',
] as const
export type DelegationRosterOrigin = (typeof DELEGATION_ROSTER_ORIGINS)[number]

export const DELEGATION_BEHAVIOR_MODES = [
  'general',
  'plan',
  'correctness-review',
  'design-review',
  'research',
] as const
export type DelegationBehaviorMode = (typeof DELEGATION_BEHAVIOR_MODES)[number]

export interface DelegationAvailabilityFallback {
  provider: string
  modelId: string
  reasoningLevel: ManagerReasoningLevel
}

export interface DelegationRoute {
  routeId: string
  label: string
  /** Task-instruction contract this roster specialist normally uses. */
  behaviorMode?: DelegationBehaviorMode
  useWhen: string
  avoidWhen?: string
  color?: string
  provider: string
  modelId: string
  reasoningLevel: ManagerReasoningLevel
  availabilityFallback?: DelegationAvailabilityFallback
  capabilityEscalationRouteId?: string
}

export interface DelegationRoster {
  rosterId: string
  revision: number
  name: string
  description?: string
  defaultRouteId: string
  modeRoutes?: Partial<Record<DelegationBehaviorMode, string>>
  routes: DelegationRoute[]
}

export interface DelegationRosterSettings {
  version: 1
  defaultRosterId: string
  rosters: DelegationRoster[]
}

export const DEFAULT_DELEGATION_ROSTER_ID = 'default'

/** Forge's shipped roster for the Hands-on manager experience. */
export function createDefaultDelegationRoster(): DelegationRoster {
  return {
    rosterId: DEFAULT_DELEGATION_ROSTER_ID,
    revision: 1,
    name: 'Default',
    description: 'The manager owns implementation and integration. Specialists provide bounded planning advice, independent review, and source-backed research.',
    defaultRouteId: 'researcher',
    modeRoutes: {
      general: 'researcher',
      plan: 'plan-consultant',
      'correctness-review': 'independent-reviewer',
      'design-review': 'independent-reviewer',
      research: 'researcher',
    },
    routes: [
      {
        routeId: 'plan-consultant',
        label: 'Plan consultant',
        behaviorMode: 'plan',
        useWhen: 'Consult on a specific consequential decision or critique a proposed plan. Supply existing findings and the unresolved question; retain implementation and integration with the manager.',
        avoidWhen: 'Avoid routine task decomposition, implementation ownership, and repeated planning once there is a credible path.',
        provider: 'openai-codex',
        modelId: 'gpt-6-astra',
        reasoningLevel: 'xhigh',
      },
      {
        routeId: 'independent-reviewer',
        label: 'Independent reviewer',
        behaviorMode: 'correctness-review',
        useWhen: 'Request one focused review of a major feature or concrete acceptance risk. Return actionable findings and evidence for the manager to resolve.',
        avoidWhen: 'Avoid automatic review of every small edit, courtesy follow-ups, and repeated review without new changes or unresolved findings.',
        provider: 'anthropic',
        modelId: 'claude-fable-5-1',
        reasoningLevel: 'low',
      },
      {
        routeId: 'researcher',
        label: 'Researcher',
        behaviorMode: 'research',
        useWhen: 'Answer a bounded question with source-backed findings that let the manager continue. Use for independent research when briefing and acceptance cost less than doing it directly.',
        avoidWhen: "Avoid duplicating known findings, unbounded exploration, or handing off the manager's implementation work.",
        provider: 'xai',
        modelId: 'grok-4.6',
        reasoningLevel: 'high',
      },
    ],
  }
}
