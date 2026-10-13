import { useEffect, useState } from 'react'
import { formatWakeTime } from './activity-model'

/** The wake-up's time and live countdown; it stops ticking once the time has come. */
export function useWakeLabel(wakeAt: string | undefined, countingDown = true): string | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!wakeAt || !countingDown) return
    setNow(Date.now())
    const interval = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= Date.parse(wakeAt)) clearInterval(interval)
    }, 1000)
    return () => clearInterval(interval)
  }, [wakeAt, countingDown])
  return wakeAt ? formatWakeTime(wakeAt, now, countingDown) : undefined
}
