import type { EnvironmentRegistry, LogicalProjectGroup } from '@forge/client-runtime'

const RECENT_PROJECTS_KEY = 'forge.newChat.recentProjects'
const MAX_REMEMBERED = 20

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** A chat was started in this project; it becomes where the next new chat starts. */
export function rememberChatProject(groupKey: string): void {
  const next = [groupKey, ...readRecent().filter((key) => key !== groupKey)].slice(0, MAX_REMEMBERED)
  try { window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next)) } catch { /* Preference only. */ }
}

/** Latest session activity across the project's checkouts on every paired machine. */
function lastActivity(group: LogicalProjectGroup, registry: EnvironmentRegistry): string {
  let latest = ''
  for (const member of group.members) {
    if (!registry.catalog.getSnapshot().has(member.environmentId)) continue
    const shell = registry.get(member.environmentId).shell.getSnapshot()
    for (const sessionId of shell.sessionIdsByProject.get(member.projectId) ?? []) {
      const updatedAt = shell.sessions.get(sessionId)?.updatedAt ?? ''
      if (updatedAt > latest) latest = updatedAt
    }
  }
  return latest
}

/**
 * Projects in the order a new chat offers them: the ones you last started chats in, then the rest by
 * their latest activity. The first is where a new chat starts.
 */
export function rankChatProjects(groups: Iterable<LogicalProjectGroup>, registry: EnvironmentRegistry): LogicalProjectGroup[] {
  const recent = readRecent()
  const rank = new Map(recent.map((key, index) => [key, index]))
  const activity = new Map<string, string>()
  const list = [...groups]
  for (const group of list) activity.set(group.key, lastActivity(group, registry))
  return list.sort((a, b) => {
    const ra = rank.get(a.key) ?? Infinity
    const rb = rank.get(b.key) ?? Infinity
    if (ra !== rb) return ra - rb
    const byActivity = activity.get(b.key)!.localeCompare(activity.get(a.key)!)
    return byActivity || a.title.localeCompare(b.title)
  })
}
