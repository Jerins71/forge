import type { ComposerDraft } from './types.js'
import type { ProjectRef } from '@forge/protocol/environment-v2'
import { qualifiedKey } from './types.js'
/** Unsent text policy is owned by the composer; this helper qualifies and retargets its values. */
export function draftKey(project: ProjectRef, draftId: string): string {
  return qualifiedKey(
    project.environmentId,
    JSON.stringify([project.projectId, draftId]),
  )
}
export function retargetDraft(
  draft: ComposerDraft,
  project: ProjectRef,
): ComposerDraft {
  return {
    ...draft,
    project,
    artifactIds:
      project.environmentId === draft.project.environmentId &&
      project.projectId === draft.project.projectId
        ? draft.artifactIds
        : [],
  }
}
export function createCommandId(crypto: Pick<Crypto, 'randomUUID'>): string {
  return crypto.randomUUID()
}
