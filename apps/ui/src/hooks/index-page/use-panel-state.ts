import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DiffViewerInitialState,
  DiffViewerNavigationRequest,
} from '@/components/diff-viewer/DiffViewerDialog'
import { useFileBrowserWorkspaceState } from '@/components/file-browser/use-file-browser-workspace-state'
import { invalidateFileBrowserCaches } from '@/components/file-browser/use-file-browser-queries'
import type { ArtifactReference } from '@/lib/artifacts'

export type ArtifactsPanelTab = 'artifacts' | 'schedules'

function shouldIgnoreKeyboardShortcutTarget(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.closest('.cm-editor') || target.closest('.cm-content')) {
    return true
  }

  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

export interface FileBrowserWorktreeSelection {
  worktreeId: string
  worktreePath: string
  branch: string | null
  repoRoot: string
}

interface UsePanelStateOptions {
  activeEnvironmentId: string | null
  activeAgentId: string | null
  /** Distinguishes agent/session contexts that may reuse the same agent id across origins or projects. */
  activeContextKey?: string
  enableKeyboardShortcuts?: boolean
}

export function usePanelState({
  activeEnvironmentId,
  activeAgentId,
  activeContextKey = activeAgentId ?? 'none',
  enableKeyboardShortcuts = true,
}: UsePanelStateOptions) {
  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false)
  const [artifactsPanelTab, setArtifactsPanelTab] = useState<ArtifactsPanelTab>('artifacts')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isDiffViewerOpen, setIsDiffViewerOpen] = useState(false)
  // Diff viewer targets are scoped to the context that opened them.
  const [diffViewerTarget, setDiffViewerTarget] = useState<{
    contextKey: string
    initialState: DiffViewerInitialState | null
    navigationRequest: DiffViewerNavigationRequest | null
  } | null>(null)
  const diffViewerNavigationRequestIdRef = useRef(0)
  const scopedDiffViewerTarget = diffViewerTarget?.contextKey === activeContextKey ? diffViewerTarget : null
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false)
  const [fileBrowserWorktreeContext, setFileBrowserWorktreeContext] =
    useState<FileBrowserWorktreeSelection | null>(null)
  const fileBrowserWorkspace = useFileBrowserWorkspaceState({
    activeEnvironmentId,
    activeAgentId,
    worktreeContext: fileBrowserWorktreeContext,
  })
  const selectedFileBrowserFile = fileBrowserWorkspace.activeFilePath

  useEffect(() => {
    setActiveArtifact(null)
    setIsArtifactsPanelOpen(false)
    setArtifactsPanelTab('artifacts')
    setIsFileBrowserOpen(false)
    setIsMobileSidebarOpen(false)
  }, [activeAgentId, activeEnvironmentId])

  useEffect(() => {
    setDiffViewerTarget((current) => (current && current.contextKey !== activeContextKey ? null : current))
  }, [activeContextKey])

  const closeFileBrowserForWorkspacePanel = useCallback(() => {
    setIsFileBrowserOpen(false)
  }, [])

  const closeWorkspacePanels = useCallback(() => {
    setIsArtifactsPanelOpen(false)
    closeFileBrowserForWorkspacePanel()
  }, [closeFileBrowserForWorkspacePanel])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyboardShortcutTarget(e)) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setIsDiffViewerOpen((previous) => !previous)
      }
    }

    if (!enableKeyboardShortcuts) {
      return undefined
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enableKeyboardShortcuts])

  const openArtifactsPanel = useCallback(
    (tab: ArtifactsPanelTab = 'artifacts') => {
      closeFileBrowserForWorkspacePanel()
        setArtifactsPanelTab(tab)
      setIsArtifactsPanelOpen(true)
    },
    [closeFileBrowserForWorkspacePanel],
  )

  const toggleArtifactsPanel = useCallback(
    (tab?: ArtifactsPanelTab) => {
      if (isArtifactsPanelOpen) {
        if (tab === undefined || artifactsPanelTab === tab) {
          setIsArtifactsPanelOpen(false)
          return
        }
      }
      openArtifactsPanel(tab ?? 'artifacts')
    },
    [artifactsPanelTab, isArtifactsPanelOpen, openArtifactsPanel],
  )

  const openFileBrowser = useCallback(() => {
    setIsArtifactsPanelOpen(false)
    setFileBrowserWorktreeContext(null)
    setIsFileBrowserOpen(true)
  }, [])

  const toggleFileBrowser = useCallback(() => {
    setIsFileBrowserOpen((previous) => {
      if (!previous) {
        setIsArtifactsPanelOpen(false)
        setFileBrowserWorktreeContext(null)
      }
      return !previous
    })
  }, [])

  const browseWorktreeFiles = useCallback((context: FileBrowserWorktreeSelection) => {
    setFileBrowserWorktreeContext(context)
    setIsArtifactsPanelOpen(false)
    setIsFileBrowserOpen(true)
  }, [])

  const clearFileBrowserWorktreeContext = useCallback(() => {
    setFileBrowserWorktreeContext(null)
    invalidateFileBrowserCaches()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyboardShortcutTarget(e)) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault()
        toggleFileBrowser()
      }
    }

    if (!enableKeyboardShortcuts) {
      return undefined
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enableKeyboardShortcuts, toggleFileBrowser])

  const openDiffViewer = useCallback((initialState: DiffViewerInitialState | null = null) => {
    setDiffViewerTarget({ contextKey: activeContextKey, initialState, navigationRequest: null })
    setIsDiffViewerOpen(true)
  }, [activeContextKey])

  const openDiffViewerDeepLink = useCallback((initialState: DiffViewerInitialState) => {
    const requestId = diffViewerNavigationRequestIdRef.current + 1
    diffViewerNavigationRequestIdRef.current = requestId
    setDiffViewerTarget({
      contextKey: activeContextKey,
      initialState,
      navigationRequest: { requestId, ...initialState },
    })
    setIsDiffViewerOpen(true)
  }, [activeContextKey])

  const selectFileBrowserFile = useCallback((path: string) => {
    fileBrowserWorkspace.openPreviewFile(path)
  }, [fileBrowserWorkspace])

  const openStickyFileBrowserFile = useCallback((path: string) => {
    fileBrowserWorkspace.openStickyFile(path)
  }, [fileBrowserWorkspace])

  const closeFileBrowserPanel = useCallback(() => {
    fileBrowserWorkspace.closeActiveTab()
  }, [fileBrowserWorkspace])

  const navigateFileBrowserToDirectory = useCallback((_dirPath: string) => {
    fileBrowserWorkspace.closeActiveTab()
  }, [fileBrowserWorkspace])

  const openArtifact = useCallback((artifact: ArtifactReference) => {
    setActiveArtifact(artifact)
  }, [])

  const closeArtifact = useCallback(() => {
    setActiveArtifact(null)
  }, [])

  return {
    activeArtifact,
    openArtifact,
    closeArtifact,
    isArtifactsPanelOpen,
    setIsArtifactsPanelOpen,
    artifactsPanelTab,
    setArtifactsPanelTab,
    openArtifactsPanel,
    toggleArtifactsPanel,
    closeWorkspacePanels,
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
    isDiffViewerOpen,
    setIsDiffViewerOpen,
    diffViewerInitialState: scopedDiffViewerTarget?.initialState ?? null,
    diffViewerNavigationRequest: scopedDiffViewerTarget?.navigationRequest ?? null,
    openDiffViewer,
    openDiffViewerDeepLink,
    isFileBrowserOpen,
    openFileBrowser,
    toggleFileBrowser,
    selectedFileBrowserFile,
    selectFileBrowserFile,
    openStickyFileBrowserFile,
    fileBrowserTabs: fileBrowserWorkspace.tabs,
    allFileBrowserTabs: fileBrowserWorkspace.allTabs,
    activeFileBrowserTabId: fileBrowserWorkspace.activeTabId,
    previewFileBrowserTabId: fileBrowserWorkspace.previewTabId,
    activateFileBrowserTab: fileBrowserWorkspace.activateTab,
    stickifyFileBrowserTab: fileBrowserWorkspace.stickifyTab,
    closeFileBrowserTab: fileBrowserWorkspace.closeTab,
    fileBrowserTreeSnapshot: fileBrowserWorkspace.treeSnapshot,
    activeFileBrowserContentScrollSnapshot: fileBrowserWorkspace.activeContentScrollSnapshot,
    updateFileBrowserTreeSnapshot: fileBrowserWorkspace.updateTreeSnapshot,
    updateActiveFileBrowserContentScrollSnapshot: fileBrowserWorkspace.updateActiveContentScrollSnapshot,
    removeFileBrowserTabsAffectedByDelete: fileBrowserWorkspace.removeTabsAffectedByDelete,
    renameFileBrowserTabsAffectedByRename: fileBrowserWorkspace.renameTabsAffectedByRename,
    closeFileBrowserPanel,
    navigateFileBrowserToDirectory,
    fileBrowserWorktreeContext,
    browseWorktreeFiles,
    clearFileBrowserWorktreeContext,
  }
}
