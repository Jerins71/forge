import { qualifiedKey, type EnvironmentClient } from '@forge/client-runtime'
import type { SessionRef } from '@forge/protocol/environment-v2'
/** Each mounted panel gets an abort scope and revocable assets for exactly one session/environment. */
export function createEnvironmentPanelContext(
  client: EnvironmentClient,
  session: SessionRef,
) {
  if (client.environmentId !== session.environmentId)
    throw new Error('Panel belongs to another environment')
  const controller = new AbortController(),
    assets = new Set<() => void>()
  return {
    session,
    client,
    features: client.features,
    signal: controller.signal,
    queryKey: (domain: string, ...targetIds: string[]) =>
      qualifiedKey(
        session.environmentId,
        JSON.stringify([session.sessionId, domain, ...targetIds]),
      ),
    artifactUrl: async (artifactId: string) => {
      const lease = await client.artifactUrl(artifactId, controller.signal)
      if (controller.signal.aborted) {
        lease.release()
        throw new Error('Panel was unmounted')
      }
      assets.add(lease.release)
      return lease.url
    },
    dispose: () => {
      controller.abort()
      for (const release of assets) release()
      assets.clear()
    },
  }
}
