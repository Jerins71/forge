import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { useEnvironmentConnection } from './use-environment-connection'
/** Compatibility name for existing components; primary comes from bootstrap identity. */
export function useLocalConnection(_wsUrl: string) {
  return useEnvironmentConnection(
    useOptionalEnvironmentContext()?.primaryEnvironmentId ?? null,
  )
}
