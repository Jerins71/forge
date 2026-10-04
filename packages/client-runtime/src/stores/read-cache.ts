/** Old history/tool payloads stay out of shell/detail and share a separate 16 MiB LRU. */
export class ReadCache {
  private readonly entries = new Map<
    string,
    { value: unknown; bytes: number }
  >()
  private bytes = 0
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value as T
  }
  set(key: string, value: unknown): void {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (bytes > 16777216) return
    const old = this.entries.get(key)
    if (old) this.bytes -= old.bytes
    this.entries.delete(key)
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    while (this.bytes > 16777216) {
      const first = this.entries.keys().next().value!
      this.bytes -= this.entries.get(first)!.bytes
      this.entries.delete(first)
    }
  }
  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }
}
