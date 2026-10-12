import type { SecureSessionPickerConfig } from '@/components/chat/secure-session/types'

type PickerVisibilityConfig = Pick<
  SecureSessionPickerConfig,
  'availability' | 'snapshot' | 'readOnly' | 'secrets' | 'outputState'
>

/**
 * Secure Sessions stay quiet until the user can actually turn them on here: a
 * usable secret or configured access in an available session. Active secure
 * state stays visible regardless, so its recovery controls remain reachable.
 */
export function shouldShowSecureSessionPicker(
  config: PickerVisibilityConfig,
): boolean {
  const snapshot = config.snapshot
  const active =
    config.outputState === 'quarantined'
    || snapshot?.leases.some((lease) => lease.status === 'active')
    || (
      snapshot?.executionMode === 'secure'
      && snapshot.environmentStatus !== 'stopped'
    )
  if (active) return true
  if (config.availability.state !== 'available') return false

  const configured =
    (snapshot?.projectDefaults?.length ?? 0) > 0
    || snapshot?.accessPolicy?.paused
    || (snapshot?.accessPolicy?.blockedAgentIds.length ?? 0) > 0
    || (snapshot?.accessPolicy?.blockedSecretIds.length ?? 0) > 0
  if (configured) return true
  if (config.readOnly && !snapshot?.accessPolicy) return false

  return config.secrets.some((secret) =>
    secret.available && secret.bindings.length > 0)
}
