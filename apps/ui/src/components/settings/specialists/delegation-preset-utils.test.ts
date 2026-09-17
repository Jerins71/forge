import { describe, expect, it } from 'vitest'
import type { DelegationRoster, DelegationRosterSettings } from '@forge/protocol'
import {
  addPolicy,
  addHandsOnSupportPreset,
  behaviorModeForSpecialist,
  duplicatePolicy,
  isDefaultSpecialistForTask,
  removePolicy,
  selectedPolicyIdForTask,
  setDefaultSpecialistForTask,
  setSpecialistBehaviorMode,
  taskAssignmentLabel,
  tasksUsingPolicy,
} from './delegation-preset-utils'

const PRESET: DelegationRoster = {
  rosterId: 'balanced',
  revision: 1,
  name: 'Balanced',
  defaultRouteId: 'fast-builder',
  modeRoutes: {
    general: 'fast-builder',
    plan: 'balanced',
    research: 'balanced',
    'correctness-review': 'independent',
    'design-review': 'independent',
  },
  routes: [
    {
      routeId: 'fast-builder',
      label: 'Fast',
      behaviorMode: 'general',
      useWhen: 'Bounded work.',
      provider: 'openai-codex',
      modelId: 'gpt-5.6-terra',
      reasoningLevel: 'medium',
      capabilityEscalationRouteId: 'balanced',
    },
    {
      routeId: 'balanced',
      label: 'Balanced',
      behaviorMode: 'research',
      useWhen: 'Ordinary work.',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      reasoningLevel: 'high',
    },
    {
      routeId: 'independent',
      label: 'Independent',
      behaviorMode: 'correctness-review',
      useWhen: 'Independent judgment.',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      reasoningLevel: 'high',
    },
  ],
}

describe('roster utilities', () => {
  it('resolves task defaults and reports every task using a specialist', () => {
    expect(selectedPolicyIdForTask(PRESET, 'general')).toBe('fast-builder')
    expect(tasksUsingPolicy(PRESET, 'balanced')).toEqual(['plan', 'research'])
    expect(tasksUsingPolicy(PRESET, 'independent')).toEqual([
      'correctness-review',
      'design-review',
    ])
    expect(taskAssignmentLabel(PRESET, 'independent')).toBe('Review')
    expect(taskAssignmentLabel(PRESET, 'fast-builder')).toBe('Build & execute')
  })

  it('adds and duplicates specialists without changing task defaults', () => {
    const added = addPolicy(PRESET)
    const duplicated = duplicatePolicy(PRESET, 'independent')

    expect(added.preset.routes).toHaveLength(4)
    expect(added.preset.modeRoutes).toEqual(PRESET.modeRoutes)
    expect(added.preset.routes.at(-1)).toMatchObject({
      routeId: added.policyId,
      capabilityEscalationRouteId: undefined,
    })
    expect(duplicated.preset.routes.at(-1)).toMatchObject({
      routeId: duplicated.policyId,
      label: 'Independent copy',
      capabilityEscalationRouteId: undefined,
    })
  })

  it('uses a specialist task type and can make an alternative the task default', () => {
    const alternative = {
      ...PRESET.routes[0]!,
      routeId: 'general-deep',
      label: 'General deep',
    }
    const preset = { ...PRESET, routes: [...PRESET.routes, alternative] }

    expect(behaviorModeForSpecialist(preset, alternative.routeId)).toBe('general')
    expect(isDefaultSpecialistForTask(preset, alternative.routeId)).toBe(false)

    const updated = setDefaultSpecialistForTask(preset, alternative.routeId)
    expect(updated.defaultRouteId).toBe(alternative.routeId)
    expect(updated.modeRoutes?.general).toBe(alternative.routeId)
    expect(isDefaultSpecialistForTask(updated, alternative.routeId)).toBe(true)
  })

  it('moves a default specialist to a new task without leaving its prior task unmapped', () => {
    const updated = setSpecialistBehaviorMode(PRESET, 'balanced', 'plan')

    expect(behaviorModeForSpecialist(updated, 'balanced')).toBe('plan')
    expect(selectedPolicyIdForTask(updated, 'research')).toBe('fast-builder')
    expect(selectedPolicyIdForTask(updated, 'plan')).toBe('balanced')
  })

  it('removes a policy without leaving dangling task mappings or escalation targets', () => {
    const removedBalanced = removePolicy(PRESET, 'balanced')

    expect(removedBalanced.routes.map((policy) => policy.routeId))
      .toEqual(['fast-builder', 'independent'])
    expect(selectedPolicyIdForTask(removedBalanced, 'plan')).toBe('fast-builder')
    expect(selectedPolicyIdForTask(removedBalanced, 'research')).toBe('fast-builder')
    expect(removedBalanced.routes.find((policy) => policy.routeId === 'fast-builder'))
      .not.toHaveProperty('capabilityEscalationRouteId')
  })
})


describe('hands-on support roster', () => {
  const settings: DelegationRosterSettings = {
    version: 1,
    defaultRosterId: PRESET.rosterId,
    rosters: [PRESET],
  }

  it('keeps the configured task models while creating three consultation specialists', () => {
    const { preset, settings: next } = addHandsOnSupportPreset(settings, PRESET)

    expect(preset.routes.map((route) => [route.routeId, route.behaviorMode, route.provider, route.modelId, route.reasoningLevel]))
      .toEqual([
        ['plan-consultant', 'plan', 'anthropic', 'claude-sonnet-5', 'high'],
        ['independent-reviewer', 'correctness-review', 'anthropic', 'claude-opus-5', 'high'],
        ['researcher', 'research', 'anthropic', 'claude-sonnet-5', 'high'],
      ])
    expect(preset.modeRoutes).toEqual({
      general: 'researcher',
      plan: 'plan-consultant',
      'correctness-review': 'independent-reviewer',
      'design-review': 'independent-reviewer',
      research: 'researcher',
    })
    expect(preset.routes.every((route) => !route.capabilityEscalationRouteId)).toBe(true)
    expect(next.defaultRosterId).toBe(settings.defaultRosterId)
    expect(next.rosters.slice(0, -1)).toEqual(settings.rosters)
    expect(settings.rosters).toHaveLength(1)
  })

  it('preserves availability fallback choices without linking later edits to existing settings', () => {
    const source = structuredClone(PRESET)
    source.routes[1]!.availabilityFallback = {
      provider: 'openai-codex', modelId: 'gpt-5.6-sol', reasoningLevel: 'medium',
    }
    source.routes[1]!.capabilityEscalationRouteId = 'independent'
    const snapshot = structuredClone(source)
    const { preset } = addHandsOnSupportPreset({ ...settings, rosters: [source] }, source)

    expect(preset.routes[0]!.availabilityFallback).toEqual(source.routes[1]!.availabilityFallback)
    preset.routes[0]!.availabilityFallback!.reasoningLevel = 'high'
    preset.routes[0]!.modelId = 'custom-model'
    preset.modeRoutes!.plan = 'researcher'
    expect(source).toEqual(snapshot)
    expect(preset.routes[2]!.availabilityFallback!.reasoningLevel).toBe('medium')
    expect(preset.routes[0]).not.toHaveProperty('capabilityEscalationRouteId')
  })

  it('keeps existing custom support rosters and their default selection', () => {
    const custom = { ...PRESET, rosterId: 'hands-on-support', name: 'My support team', revision: 8 }
    const prior = { ...settings, defaultRosterId: custom.rosterId, rosters: [PRESET, custom] }
    const { preset, settings: next } = addHandsOnSupportPreset(prior, PRESET)

    expect(preset.rosterId).toBe('hands-on-support-2')
    expect(next.defaultRosterId).toBe(custom.rosterId)
    expect(next.rosters[1]).toEqual(custom)
    expect(prior.rosters).toHaveLength(2)
  })

  it('uses the configured default model when a legacy roster has no task mappings', () => {
    const source = { ...PRESET, modeRoutes: undefined }
    const { preset } = addHandsOnSupportPreset(settings, source)
    expect(preset.routes.every((route) => route.modelId === PRESET.routes[0]!.modelId)).toBe(true)
    expect(preset.routes.map((route) => route.behaviorMode)).toEqual(['plan', 'correctness-review', 'research'])
  })
})
