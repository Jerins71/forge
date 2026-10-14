import type { EnvironmentClient, LogicalProjectGroup } from './types.js'
import type { ProjectRef, ProjectSummary } from '@forge/protocol/environment-v2'
import type { RuntimePersistence } from './ports.js'
import { qualifiedKey } from './types.js'
import { KeyedSelectorStore } from './stores/selector-store.js'
export class LogicalProjects extends KeyedSelectorStore<
  ReadonlyMap<string, LogicalProjectGroup>
> {
  private readonly projects = new Map<string, ProjectSummary>()
  private readonly membership = new Map<string, string>()
  private overrides: Record<string, { key: string; title?: string }> = {}
  constructor(readonly persistence: RuntimePersistence) {
    super(new Map())
  }
  async hydrate(): Promise<void> {
    this.overrides = await this.persistence.loadGrouping()
  }
  attach(client: EnvironmentClient): () => void {
    let previous: ReadonlyMap<string, ProjectSummary> = new Map()
    const update = () => {
      const projects = client.shell.getSnapshot().projects
      const changed = new Set<string>()
      for (const [id, p] of projects)
        if (previous.get(id) !== p) {
          this.remove(
            { environmentId: client.environmentId, projectId: id },
            changed,
          )
          this.add(
            { environmentId: client.environmentId, projectId: id },
            p,
            changed,
          )
        }
      for (const id of previous.keys())
        if (!projects.has(id))
          this.remove(
            { environmentId: client.environmentId, projectId: id },
            changed,
          )
      previous = projects
      this.publish(changed)
    }
    update()
    const unsubscribe = client.shell.subscribe(
      (s) => s.projects,
      update,
      Object.is,
      ['projects'],
    )
    return () => {
      unsubscribe()
      const changed = new Set<string>()
      for (const id of previous.keys())
        this.remove(
          { environmentId: client.environmentId, projectId: id },
          changed,
        )
      this.publish(changed)
    }
  }
  private readonly mutable = new Map<string, LogicalProjectGroup>()
  private add(ref: ProjectRef, p: ProjectSummary, changed: Set<string>): void {
    const physical = qualifiedKey(ref.environmentId, ref.projectId),
      override = this.overrides[physical]
    // An archived project stays out of its repository's live group: it is no place to start new work.
    const key = override?.key ?? (p.archived ? physical : p.repository?.key) ?? physical
    const existing = this.mutable.get(key)
    this.projects.set(physical, p)
    this.membership.set(physical, key)
    this.mutable.set(key, {
      key,
      title: override?.title ?? existing?.title ?? p.title,
      members: [...(existing?.members ?? []), ref],
    })
    changed.add(key)
  }
  private remove(ref: ProjectRef, changed: Set<string>): void {
    const physical = qualifiedKey(ref.environmentId, ref.projectId),
      key = this.membership.get(physical)
    if (!key) return
    const existing = this.mutable.get(key)!,
      members = existing.members.filter(
        (r) => qualifiedKey(r.environmentId, r.projectId) !== physical,
      )
    if (members.length) this.mutable.set(key, { ...existing, members })
    else this.mutable.delete(key)
    this.membership.delete(physical)
    this.projects.delete(physical)
    changed.add(key)
  }
  private publish(keys: Set<string>): void {
    if (keys.size) this.set(new Map(this.mutable), keys)
  }
  async mergeProjects(
    groupKey: string,
    members: readonly ProjectRef[],
    title?: string,
  ): Promise<void> {
    if (!groupKey || !members.length)
      throw new Error('Group and projects are required')
    for (const r of members)
      if (!this.projects.has(qualifiedKey(r.environmentId, r.projectId)))
        throw new Error('Unknown physical project')
    const changes = new Set<string>()
    for (const r of members) {
      const key = qualifiedKey(r.environmentId, r.projectId),
        p = this.projects.get(key)!
      this.overrides[key] = { key: groupKey, ...(title ? { title } : {}) }
      this.remove(r, changes)
      this.add(r, p, changes)
    }
    await this.persistence.saveGrouping(this.overrides)
    this.publish(changes)
  }
  splitProject(project: ProjectRef): Promise<void> {
    return this.mergeProjects(
      qualifiedKey(project.environmentId, project.projectId),
      [project],
      this.projects.get(qualifiedKey(project.environmentId, project.projectId))
        ?.title,
    )
  }
}
