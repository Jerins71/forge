/** What a person typed in the address bar, as a URL: a scheme is kept, a host gets https, anything else is a search. */
export function normalizeBrowserAddress(input: string): string {
  const value = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^\s:]+:\d+(\/|$)/.test(value)) return value
  if (!/\s/.test(value) && (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(value) || /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(value))) {
    return `${/^(localhost|127\.|\[::1\])/i.test(value) ? 'http' : 'https'}://${value}`
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}
