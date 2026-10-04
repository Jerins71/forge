import { useEffect, useState, type ReactNode } from 'react'
import { initializeEnvironmentApplication } from './environment-bootstrap'
import {
  EnvironmentProvider,
  type EnvironmentContextValue,
} from './environment-provider'
/** Bootstrap happens before transport consumers receive the paired primary UUID. */
export function ApplicationEnvironmentProvider({
  children,
}: {
  children: ReactNode
}) {
  const [value, setValue] = useState<EnvironmentContextValue | null>(null)
  useEffect(() => {
    let mounted = true
    void initializeEnvironmentApplication()
      .then((next) => {
        if (mounted) setValue(next)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])
  return value ? (
    <EnvironmentProvider {...value}>{children}</EnvironmentProvider>
  ) : (
    children
  )
}
