type Parser = (document: string, file: unknown) => unknown

const MAX_CACHED_CHARACTERS = 4_000_000
const trees = new Map<string, unknown>()
let cachedCharacters = 0

/**
 * A remark plugin that reuses the parsed tree for text it has parsed before, so reopening a
 * conversation does not parse every message again. Transforms after parsing build a new tree,
 * so a cached tree is only read. Least recently used text is dropped past the size bound.
 */
export function remarkCachedParse(this: { parser?: Parser }) {
  const parse = this.parser!
  this.parser = (document, file) => {
    const cached = trees.get(document)
    if (cached) {
      trees.delete(document)
      trees.set(document, cached)
      return cached
    }
    const tree = parse(document, file)
    if (document.length > MAX_CACHED_CHARACTERS / 4) return tree
    trees.set(document, tree)
    cachedCharacters += document.length
    for (const [text] of trees) {
      if (cachedCharacters <= MAX_CACHED_CHARACTERS) break
      trees.delete(text)
      cachedCharacters -= text.length
    }
    return tree
  }
}
