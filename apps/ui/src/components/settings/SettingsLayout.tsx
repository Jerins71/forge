import { Activity, ArrowLeft, ChevronLeft, Search, Bell, Settings, KeyRound, Wrench, FileText, Terminal, TerminalSquare, Puzzle, UserCog, Info, Cpu, Palette, GitBranch, Globe2, Grid3X3, Server, ShieldCheck, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { HelpTrigger } from '@/components/help/HelpTrigger'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { SettingsTab } from './settings-target'

// Re-export for callers that previously imported from this module
export type { SettingsTab } from './settings-target'

interface NavItem {
  id: SettingsTab
  label: string
  icon: React.ReactNode
  description: string
}

const ICON_PROPS = { className: 'size-4', strokeWidth: 1.75 } as const

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'App',
    items: [
      { id: 'general', label: 'General', icon: <Settings {...ICON_PROPS} />, description: 'Core behavior for this Forge installation.' },
      { id: 'environments', label: 'Environments', icon: <Server {...ICON_PROPS} />, description: 'Machines this app can run projects on.' },
      { id: 'sync', label: 'Sync', icon: <RefreshCw {...ICON_PROPS} />, description: 'Keep presets, skills, prompts and memory the same across environments.' },
      { id: 'appearance', label: 'Appearance', icon: <Palette {...ICON_PROPS} />, description: 'Theme, accent and fonts. Saved to this device.' },
      { id: 'notifications', label: 'Notifications', icon: <Bell {...ICON_PROPS} />, description: 'Choose when Forge should get your attention.' },
    ],
  },
  {
    label: 'Agents',
    items: [
      { id: 'models', label: 'Models', icon: <Cpu {...ICON_PROPS} />, description: 'Providers, models and runtimes available to agents.' },
      { id: 'auth', label: 'Authentication', icon: <KeyRound {...ICON_PROPS} />, description: 'Sign in to providers and manage credentials.' },
      { id: 'presets', label: 'Worker presets', icon: <UserCog {...ICON_PROPS} />, description: 'Named models a manager can start workers on.' },
      { id: 'prompts', label: 'Prompts', icon: <FileText {...ICON_PROPS} />, description: 'System prompts and instructions.' },
      { id: 'skills', label: 'Skills', icon: <Wrench {...ICON_PROPS} />, description: 'Reusable skills available to agents.' },
      { id: 'slash-commands', label: 'Slash Commands', icon: <Terminal {...ICON_PROPS} />, description: 'Custom commands for the composer.' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { id: 'project-settings', label: 'Project Settings', icon: <Settings {...ICON_PROPS} />, description: 'Settings that apply to this project only.' },
      { id: 'git-monitoring', label: 'Git monitoring', icon: <GitBranch {...ICON_PROPS} />, description: 'Repositories Forge watches for changes.' },
      { id: 'secrets', label: 'Secrets', icon: <ShieldCheck {...ICON_PROPS} />, description: 'Secrets available to agents and tools.' },
      { id: 'extensions', label: 'Extensions', icon: <Puzzle {...ICON_PROPS} />, description: 'Extend Forge with additional capabilities.' },
      { id: 'browser', label: 'Browser', icon: <Globe2 {...ICON_PROPS} />, description: 'Each project’s browser profile, sign-ins and Chrome import.' },
      { id: 'cli-access', label: 'CLI Access', icon: <TerminalSquare {...ICON_PROPS} />, description: 'Use the Forge command line tool.' },
      { id: 'stream-deck', label: 'Stream Deck', icon: <Grid3X3 {...ICON_PROPS} />, description: 'Control Forge from an Elgato Stream Deck.' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'history', label: 'History', icon: <Activity {...ICON_PROPS} />, description: 'Conversation history and retention.' },
      { id: 'observability', label: 'Observability', icon: <Activity {...ICON_PROPS} />, description: 'Tracing and diagnostics.' },
      { id: 'about', label: 'About', icon: <Info {...ICON_PROPS} />, description: 'Version, updates and runtimes.' },
    ],
  },
]

const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

interface SettingsLayoutProps {
  activeTab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onBack?: () => void
  children: React.ReactNode
  /** Class that sets `--content-max` for the content area. Defaults to the settings measure. */
  contentWidthClassName?: string
  /** Filter nav items to only these tabs. When omitted, all tabs are shown. */
  availableTabs?: SettingsTab[]
  /** Non-interactive target badge label (e.g. "Project: Forge"). */
  targetLabel?: string
  /** Header control naming the environment the view edits. */
  headerAccessory?: React.ReactNode
  /** Header label. Defaults to the global Settings surface. */
  title?: string
  /**
   * When true the content area becomes a flex column that fills remaining space
   * without its own scroll. Children are expected to manage their own scrolling.
   * Used by the Skills tab whose explorer panels each scroll independently.
   */
  fillHeight?: boolean
  /** Tabs that show an amber attention dot. */
  attentionTabs?: SettingsTab[]
}

export function SettingsLayout({ activeTab, onTabChange, onBack, children, contentWidthClassName, availableTabs, targetLabel, headerAccessory, title = 'Settings', fillHeight, attentionTabs }: SettingsLayoutProps) {
  const [query, setQuery] = useState('')
  const visibleItems = availableTabs
    ? NAV_ITEMS.filter((item) => availableTabs.includes(item.id))
    : NAV_ITEMS
  const normalizedQuery = query.trim().toLowerCase()
  const filteredIds = new Set(
    visibleItems
      .filter((item) => !normalizedQuery || item.label.toLowerCase().includes(normalizedQuery))
      .map((item) => item.id),
  )
  const visibleGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => filteredIds.has(item.id)) }))
    .filter((group) => group.items.length > 0)
  const activeItem = NAV_ITEMS.find((item) => item.id === activeTab)

  // Esc returns to sessions, unless something else (an open dialog, menu or
  // text field) already claimed the keypress.
  useEffect(() => {
    if (!onBack) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      onBack()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onBack])

  // The narrow tab strip scrolls sideways; keep the active tab in view.
  const tabStripRef = useRef<HTMLElement>(null)
  useEffect(() => {
    tabStripRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [activeTab])

  return (
    <div className="app-canvas @container/settings-shell flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Mobile: compact header + horizontal scrolling tab bar */}
      <header className="flex h-12 shrink-0 items-center gap-1 px-2 @3xl/settings-shell:hidden">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onBack}
            aria-label="Back to chat"
          >
            <ArrowLeft className="size-4" strokeWidth={1.75} />
          </Button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h1>
        {targetLabel ? (
          <span className="shrink-0 font-mono text-[11px] text-subtle-foreground">{targetLabel}</span>
        ) : null}
        {headerAccessory}
        <HelpTrigger contextKey={`settings.${activeTab}`} size="sm" variant="ghost" />
      </header>
      <nav
        ref={tabStripRef}
        aria-label="Settings sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline pb-1.5 pl-2 pr-10 [mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)] [scrollbar-width:none] @3xl/settings-shell:hidden [&::-webkit-scrollbar]:hidden"
      >
        {visibleItems.map((item) => {
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                isActive
                  ? 'bg-foreground/[0.07] font-medium text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                  : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
              )}
            >
              <span className="flex shrink-0">{item.icon}</span>
              <span className="whitespace-nowrap">{item.label}</span>
              {attentionTabs?.includes(item.id) ? <AttentionDot /> : null}
            </button>
          )
        })}
      </nav>

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden @3xl/settings-shell:p-3">
        {/* Desktop: glass nav column */}
        <nav
          aria-label="Settings sections"
          className="glass hidden w-[248px] shrink-0 flex-col gap-0.5 overflow-y-auto rounded-2xl px-2.5 py-3 @3xl/settings-shell:flex"
        >
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to chat"
              className="mb-2 flex w-full shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ChevronLeft className="size-3.5" strokeWidth={1.75} />
              Back to sessions
              <kbd className="ml-auto rounded-[5px] border border-hairline px-1.5 py-px font-mono text-[10.5px] text-subtle-foreground">esc</kbd>
            </button>
          ) : null}
          <div className="mb-2 flex h-[34px] shrink-0 items-center gap-2 rounded-[10px] border border-hairline bg-foreground/[0.04] px-2.5 focus-within:ring-2 focus-within:ring-ring/50">
            <Search className="size-3.5 shrink-0 text-subtle-foreground" strokeWidth={1.75} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
            />
          </div>
          {visibleGroups.map((group, index) => (
            <div key={group.label} className={cn('flex flex-col gap-0.5', index > 0 && 'mt-3')}>
              <span className="eyebrow px-2.5 pb-1 pt-1">{group.label}</span>
              {group.items.map((item) => {
                const isActive = activeTab === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onTabChange(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                      isActive
                        ? 'bg-foreground/[0.07] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                        : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn('h-3.5 w-[3px] shrink-0 rounded-sm', isActive ? 'bg-primary' : 'bg-transparent')}
                    />
                    <span className="truncate">{item.label}</span>
                    {attentionTabs?.includes(item.id) ? <AttentionDot /> : null}
                  </button>
                )
              })}
            </div>
          ))}
          {visibleGroups.length === 0 ? (
            <p className="px-2.5 py-3 text-[13px] text-subtle-foreground">No matching settings.</p>
          ) : null}
        </nav>

        {/* Content area */}
        <div
          className={cn(
            '@container/settings min-h-0 flex-1',
            fillHeight
              ? 'flex flex-col overflow-hidden'
              : cn(
                  'overflow-y-auto',
                  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
                  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
                  '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
                  'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
                ),
          )}
        >
          <div
            className={cn(
              // Left-aligned to the nav, not centred: a wide window shows more settings, not more margin.
              'w-full max-w-[calc(var(--content-max)+2.5rem)] px-4 pb-10 pt-5 @3xl/settings-shell:px-5 @3xl/settings-shell:pt-7',
              fillHeight ? 'flex min-h-0 flex-1 flex-col' : null,
              contentWidthClassName || 'content-settings',
            )}
          >
            <div className="mb-5 flex shrink-0 items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="truncate text-[26px] font-medium leading-tight tracking-[-0.02em] text-foreground">
                  {activeItem?.label ?? title}
                </h2>
                {activeItem?.description ? (
                  <p className="text-[13.5px] text-muted-foreground">{activeItem.description}</p>
                ) : null}
              </div>
              <div className="hidden shrink-0 items-center gap-2 pt-1.5 @3xl/settings-shell:flex">
                {targetLabel ? (
                  <Badge variant="outline" className="font-mono text-[11px] font-normal text-subtle-foreground">
                    {targetLabel}
                  </Badge>
                ) : null}
                {headerAccessory}
                <HelpTrigger contextKey={`settings.${activeTab}`} size="sm" variant="ghost" />
              </div>
            </div>
            {fillHeight ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}
          </div>
        </div>
      </div>
    </div>
  )
}

function AttentionDot() {
  return <span className="ml-auto size-1.5 shrink-0 rounded-full bg-attention" aria-label="Update available" />
}
