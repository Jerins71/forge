import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** The command comes from the owning machine, including when viewed remotely. */
export function BrowserHostSetupCommand({ command }: { command?: string }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  if (!command) return null
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setError(false) }
    catch { setError(true) }
  }
  return <div className="mt-2 flex flex-wrap items-center gap-2">
    <code className="select-all break-all text-[12px]">{command}</code>
    <Button size="sm" variant="secondary" onClick={() => void copy()}><Copy className="size-3.5" />{copied ? 'Copied' : 'Copy command'}</Button>
    {error ? <span role="alert" className="text-[12px]">Select the command to copy it.</span> : null}
  </div>
}
