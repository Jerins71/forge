import { Type } from '@sinclair/typebox'

const O = <P extends Record<string, import('@sinclair/typebox').TSchema>>(p: P) => Type.Object(p, { additionalProperties: false })
const id = Type.String({ minLength: 1, maxLength: 128 })
const text = Type.String({ maxLength: 4096 })
const prompt = Type.String({ maxLength: 131072 })
const time = Type.String({ maxLength: 32 })
const caps = Type.Array(Type.Literal('create_session'), { maxItems: 1, uniqueItems: true })
const source = Type.Union([
  O({ type: Type.Literal('local') }),
  O({ type: Type.Literal('repo'), workspaceKey: text, forgeDirRealpath: text, definitionId: id, activatedAt: time, signature: Type.Optional(text) }),
])
export const ProjectAgentInfoV2Schema = O({
  handle: id, whenToUse: text, creatorSessionId: Type.Optional(id), capabilities: Type.Optional(caps),
  sourceKind: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('repo')])), source: Type.Optional(source),
})
export const ProjectAgentInputV2Schema = Type.Union([O({ whenToUse: text, systemPrompt: Type.Optional(prompt), handle: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })), capabilities: Type.Optional(caps), placement: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('repo')])) }), Type.Null()])
export const ProjectAgentConfigV2Schema = O({
  sessionId: id,
  config: O({ version: Type.Integer({ minimum: 1 }), agentId: id, handle: id, whenToUse: text, creatorSessionId: Type.Optional(id), capabilities: Type.Optional(caps), promotedAt: time, updatedAt: time }),
  systemPrompt: Type.Union([prompt, Type.Null()]), references: Type.Array(text, { maxItems: 1000 }),
  source: Type.Optional(O({ type: Type.Literal('repo'), status: Type.Union((['local', 'valid', 'missing', 'invalid', 'conflict', 'wrong_workspace', 'unavailable'] as const).map(v => Type.Literal(v))), problems: Type.Array(O({ code: id, message: text, path: Type.Optional(text) }), { maxItems: 1000 }), workspaceKey: text, forgeDirRealpath: text, definitionId: id, activatedAt: time, signature: Type.Optional(text) })),
})
export const ProjectAgentSharingFields = {
  sessionId: id,
  grants: Type.Array(O({ grantId: id, sourceProfileId: id, sourceAgentId: id, sourceHandle: id, sourceProjectName: text, targetProfileId: id, targetProjectName: text, targetNamespace: id, externalHandle: text, blockedReason: Type.Optional(Type.Union([Type.Literal('source_archived'), Type.Literal('target_archived')])), createdAt: time, updatedAt: time }), { maxItems: 1000 }),
  eligibleTargets: Type.Array(O({ profileId: id, displayName: text, alreadyShared: Type.Boolean(), namespacePreview: text }), { maxItems: 1000 }),
}
export const ProjectAgentDirectoryV2Schema = O({ projectId: id, entries: Type.Array(O({ agentId: id, handle: text, displayName: text, whenToUse: text, sourceProjectName: text, origin: Type.Literal('external') }), { maxItems: 1000 }) })
export const ProjectAgentFileNameSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[^/\\\\\\x00-\\x1f]+$' })
export const ProjectAgentRevisionSchema = Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()])
export const ProjectAgentReferenceWriteSchema = O({ sessionId: id, fileName: ProjectAgentFileNameSchema, expectedRevision: ProjectAgentRevisionSchema, content: prompt })
export const ProjectAgentReferenceDeleteSchema = O({ sessionId: id, fileName: ProjectAgentFileNameSchema, expectedRevision: ProjectAgentRevisionSchema })
export const ProjectAgentReferenceMutationResultSchema = O({ sessionId: id, fileName: ProjectAgentFileNameSchema, revision: ProjectAgentRevisionSchema })
export const ProjectAgentOperationReceiptSchema = O({ commandId: Type.String({ pattern: '^[0-9a-f-]{36}$' }), method: Type.Union((['projectAgent.set', 'projectAgent.sharing.set', 'projectAgent.recommend'] as const).map(v => Type.Literal(v))), state: Type.Union((['running', 'succeeded', 'interrupted'] as const).map(v => Type.Literal(v))) })
export type ProjectAgentReferenceWrite = import('@sinclair/typebox').Static<typeof ProjectAgentReferenceWriteSchema>
export type ProjectAgentReferenceDelete = import('@sinclair/typebox').Static<typeof ProjectAgentReferenceDeleteSchema>
export type ProjectAgentReferenceMutationResult = import('@sinclair/typebox').Static<typeof ProjectAgentReferenceMutationResultSchema>

/** Project Agent shell metadata excludes the user-authored prompt document. */
export function projectAgentMetadata(info: import('./agents.js').ProjectAgentInfo): import('./agents.js').ProjectAgentInfo {
  const { systemPrompt: _prompt, ...metadata } = info
  return metadata
}
