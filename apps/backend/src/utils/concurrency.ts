/** Runs `task` for every item with at most `limit` in flight, so many small file operations overlap. */
export async function forEachConcurrently<T>(items: Iterable<T>, limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const pending = [...items].reverse();
  await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, async () => {
    for (let item = pending.pop(); item !== undefined; item = pending.pop()) await task(item);
  }));
}
