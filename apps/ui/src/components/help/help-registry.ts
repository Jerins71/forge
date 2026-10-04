import type {
  HelpArticle,
  HelpCategory,
  ShortcutDef,
} from './help-types'
import { getShortcutDefinitions } from './content/shortcuts'
import { gettingStartedArticles } from './content/getting-started'
import { chatArticles } from './content/chat-articles'
import { settingsArticles } from './content/settings-articles'
import { modelsArticles } from './content/models-articles'
import { conceptsArticles } from './content/concepts-articles'
import { terminalArticles } from './content/terminal-articles'

const articleRegistry = new Map<string, HelpArticle>()
const shortcutRegistry = new Map<string, ShortcutDef>()

let isInitialized = false

function registerArticle(article: HelpArticle): void {
  articleRegistry.set(article.id, article)
}


function registerShortcut(shortcut: ShortcutDef): void {
  shortcutRegistry.set(shortcut.id, shortcut)
}

export function getArticle(id: string): HelpArticle | undefined {
  return articleRegistry.get(id)
}

export function getArticlesForContext(contextKey: string): HelpArticle[] {
  return [...articleRegistry.values()].filter((article) => article.contextKeys.includes(contextKey))
}

export function getArticlesByCategory(category: HelpCategory): HelpArticle[] {
  return [...articleRegistry.values()].filter((article) => article.category === category)
}

export function searchArticles(query: string): HelpArticle[] {
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) {
    return getAllArticles()
  }

  return [...articleRegistry.values()].filter((article) => {
    const haystacks = [
      article.title,
      article.summary,
      ...article.keywords,
    ]

    return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery))
  })
}


export function getShortcuts(scope?: string): ShortcutDef[] {
  const shortcuts = [...shortcutRegistry.values()]

  if (!scope) {
    return shortcuts
  }

  return shortcuts.filter((shortcut) => shortcut.scope === scope)
}

export function getAllArticles(): HelpArticle[] {
  return [...articleRegistry.values()]
}

export function initializeHelpContent(): void {
  if (isInitialized) {
    return
  }

  for (const shortcut of getShortcutDefinitions()) {
    registerShortcut(shortcut)
  }

  const allArticles = [
    ...gettingStartedArticles,
    ...chatArticles,
    ...settingsArticles,
    ...modelsArticles,
    ...conceptsArticles,
    ...terminalArticles,
  ]

  for (const article of allArticles) {
    registerArticle(article)
  }

  isInitialized = true
}
