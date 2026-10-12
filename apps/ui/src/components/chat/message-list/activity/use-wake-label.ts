import { useEffect, useState } from 'react'
import { formatWakeTime } from './activity-model'

/** The wake-up's time and live countdown; it stops ticking once the time has come. */
export function useWakeLabel(wakeAt: string | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!wakeAt) return
    setNow(Date.now())
    const interval = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= Date.parse(wakeAt)) clearInterval(interval)
    }, 1000)
    return () => clearInterval(interval)
  }, [wakeAt])
  return wakeAt ? formatWakeTime(wakeAt, now) : undefined
}
