import type { SelectorStore, Unsubscribe } from '../types.js'
type Slice<S> = {
  selector: (s: S) => unknown
  last: unknown
  equal: (a: unknown, b: unknown) => boolean
  listener: () => void
  keys: readonly string[]
}
/** Record-indexed selector notifications: unchanged keys do not execute selectors. */
export class KeyedSelectorStore<S> implements SelectorStore<S> {
  private readonly all = new Set<Slice<S>>()
  private readonly byKey = new Map<string, Set<Slice<S>>>()
  private readonly broad = new Set<Slice<S>>()
  constructor(private state: S) {}
  getSnapshot(): S {
    return this.state
  }
  subscribe<T>(
    selector: (s: S) => T,
    listener: () => void,
    equal: (a: T, b: T) => boolean = Object.is,
    dependencies: readonly string[] = [],
  ): Unsubscribe {
    const slice: Slice<S> = {
      selector,
      listener,
      last: selector(this.state),
      equal: equal as Slice<S>['equal'],
      keys: dependencies,
    }
    this.all.add(slice)
    if (!dependencies.length) this.broad.add(slice)
    for (const key of dependencies) {
      let entries = this.byKey.get(key)
      if (!entries) this.byKey.set(key, (entries = new Set()))
      entries.add(slice)
    }
    return () => {
      this.all.delete(slice)
      this.broad.delete(slice)
      for (const key of dependencies) {
        const entries = this.byKey.get(key)
        entries?.delete(slice)
        if (!entries?.size) this.byKey.delete(key)
      }
    }
  }
  set(next: S, changedKeys?: Iterable<string>): void {
    if (Object.is(next, this.state)) return
    this.state = next
    const pending = changedKeys ? new Set(this.broad) : this.all
    if (changedKeys)
      for (const key of changedKeys)
        for (const slice of this.byKey.get(key) ?? []) pending.add(slice)
    for (const slice of pending) {
      const value = slice.selector(next)
      if (!slice.equal(slice.last, value)) {
        slice.last = value
        slice.listener()
      }
    }
  }
}
