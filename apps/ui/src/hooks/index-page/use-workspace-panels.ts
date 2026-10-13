/**
 * Workspace-panels controller (WP-U3 BuilderSurface split).
 *
 * Owns the workspace-rail domain that used to live inline in BuilderSurface:
 * panel state (`usePanelState`), the file-editor sessions + coordinator, diff
 * viewer presentation, source-control/file-browser refresh nonces, every
 * guarded panel-transition handler, and the derived `activityRailItems`.
 *
 * It also owns `handleSelectAgent` because it routes
 * an agent switch *through* the file-editor coordinator this hook creates —
 * keeping them here avoids a hook-ordering cycle with `useSessionActions`
 * (panels run before session actions; session actions and the sidebar receive
 * `handleSelectAgent` as an input).  The shell threads `fileEditorCoordinatorRef`
 * (a shell-level ref) in and this hook keeps it current, so the active-agent
 * route-sync effect can read the coordinator lazily.
 *
 * Threaded-state controller (see the WP-U3 plan review): inputs like
 * `activeAgentId` / `activeAgent` come from `useActiveAgent`, not a re-derived
 * `useOriginSlice` here.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from 'react'
import type { EnvironmentClient } from '@forge/client-runtime'
import { createEnvironmentPanelContext, type EnvironmentPanels } from '@/lib/environment-panel-context'
import { Clock3, FolderOpen, GitBranch, MessageSquare, Package, SquareTerminal } from 'lucide-react'
import type { AgentDescriptor, GitWorktreeSummary } from '@forge/protocol'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { MessageInputHandle } from '@/components/chat/MessageInput'
import {
  isActivityRailWorkspaceAvailable,
  resolveChatRailTargetAgentId,
  resolveSourceControlDeepLinkPresentation,
} from '@/components/index-page/activity-rail-workspace'
import { requestGuardedArtifactsPanelToggle } from '@/components/index-page/builder-file-editor-guard-actions'
import { FILE_BROWSER_INLINE_EDITING_ENABLED } from '@/components/file-browser/file-editor-feature-gates'
import { useFileEditSessions } from '@/components/file-browser/use-file-edit-sessions'
import { fileEditorKeyId, useFileEditorCoordinator, type FileEditorSessionKey } from '@/components/file-browser/use-file-editor-coordinator'
import {
  applySuccessfulFileCreateToCaches,
  applySuccessfulFileDeleteToCaches,
  applySuccessfulFileRenameToCaches,
  createFilePath,
  deleteFilePath,
  renameFilePath,
  type FileContentResult,
} from '@/components/file-browser/use-file-browser-queries'
import { getSidebarPerfRegistry } from '@/lib/perf/sidebar-perf-debug'
import { usePanelState } from '@/hooks/index-page/use-panel-state'
import { shouldIgnoreGlobalShortcutTarget } from '@/hooks/index-page/global-shortcut-target'
import type { useTerminalPanel } from '@/hooks/useTerminalPanel'

type TerminalPanel = ReturnType<typeof useTerminalPanel>

interface BuilderNavigationState {
  view: 'chat'
  agentId: string
  environmentId?: string
}

export interface UseWorkspacePanelsOptions {
  /** The addressed environment; every panel request goes through it and never falls back to another host. */
  environmentClient: EnvironmentClient | null
  activeAgentId: string | null
  activeAgent: AgentDescriptor | null
  activeManagerAgent: AgentDescriptor | null
  terminalSessionAgentId: string | null
  terminalPanel: TerminalPanel
  terminalCount: number
  clientRef: MutableRefObject<ManagerWsClient | null>
  messageInputRef: MutableRefObject<MessageInputHandle | null>
  navigateToRoute: (nextRouteState: BuilderNavigationState, replace?: boolean) => void
}

export function useWorkspacePanels({
  environmentClient,
  activeAgentId,
  activeAgent,
  activeManagerAgent,
  terminalSessionAgentId,
  terminalPanel,
  terminalCount,
  clientRef,
  messageInputRef,
  navigateToRoute,
}: UseWorkspacePanelsOptions) {
  const environmentId = environmentClient?.environmentId ?? null
  // The panel scope is created and disposed by one effect so StrictMode's mount/unmount/mount
  // never leaves consumers holding an already-aborted signal.
  const [panelScope, setPanelScope] = useState<EnvironmentPanels | null>(null)
  useEffect(() => {
    if (!environmentClient || !activeAgentId) {
      setPanelScope(null)
      return
    }
    const scope = createEnvironmentPanelContext(environmentClient, {
      environmentId: environmentClient.environmentId,
      sessionId: activeAgentId,
    })
    setPanelScope(scope)
    return () => scope.dispose()
  }, [environmentClient, activeAgentId])
  const environmentPanels =
    panelScope?.client === environmentClient && panelScope?.session.sessionId === activeAgentId
      ? panelScope
      : null
  const [diffViewerPresentation, setDiffViewerPresentation] = useState<'modal' | 'inline'>('modal')

  const {
    activeArtifact,
    openArtifact: handleOpenArtifact,
    closeArtifact: handleCloseArtifact,
    isArtifactsPanelOpen,
    setIsArtifactsPanelOpen,
    artifactsPanelTab,
    setArtifactsPanelTab,
    openArtifactsPanel: handleOpenArtifactsPanel,
    toggleArtifactsPanel: handleToggleArtifactsPanel,
    closeWorkspacePanels: handleCloseWorkspacePanels,
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
    isDiffViewerOpen,
    setIsDiffViewerOpen,
    diffViewerInitialState,
    diffViewerNavigationRequest,
    openDiffViewer,
    openDiffViewerDeepLink,
    isFileBrowserOpen,
    openFileBrowser: handleOpenFileBrowser,
    toggleFileBrowser: handleToggleFileBrowser,
    selectedFileBrowserFile,
    selectFileBrowserFile: handleFileBrowserSelectFile,
    openStickyFileBrowserFile: handleOpenStickyFileBrowserFile,
    fileBrowserTabs,
    allFileBrowserTabs,
    activeFileBrowserTabId,
    previewFileBrowserTabId,
    activateFileBrowserTab,
    stickifyFileBrowserTab,
    closeFileBrowserTab,
    fileBrowserTreeSnapshot,
    activeFileBrowserContentScrollSnapshot,
    updateFileBrowserTreeSnapshot,
    updateActiveFileBrowserContentScrollSnapshot,
    removeFileBrowserTabsAffectedByDelete,
    renameFileBrowserTabsAffectedByRename,
    navigateFileBrowserToDirectory: handleFileBrowserNavigateToDirectory,
    fileBrowserWorktreeContext,
    browseWorktreeFiles: handleBrowseWorktreeFiles,
    clearFileBrowserWorktreeContext: handleClearFileBrowserWorktreeContext,
  } = usePanelState({
    activeEnvironmentId: environmentId,
    activeAgentId,
    activeContextKey: environmentPanels?.queryKey('panels') ?? 'none',
    enableKeyboardShortcuts: false,
  })

  const [fileBrowserRefreshNonce, setFileBrowserRefreshNonce] = useState(0)
  const [sourceControlRefreshNonce, setSourceControlRefreshNonce] = useState(0)
  const activeFileEditorKey = useMemo<FileEditorSessionKey | null>(() => {
    if (!environmentId || !activeAgentId || !selectedFileBrowserFile) return null
    return {
      environmentId,
      agentId: activeAgentId,
      worktreeId: fileBrowserWorktreeContext?.worktreeId ?? null,
      filePath: selectedFileBrowserFile,
    }
  }, [environmentId, activeAgentId, fileBrowserWorktreeContext?.worktreeId, selectedFileBrowserFile])
  const fileEditSessions = useFileEditSessions({
    panel: environmentPanels,
    activeKey: activeFileEditorKey,
    editingEnabled: FILE_BROWSER_INLINE_EDITING_ENABLED,
    onDirtyChange: (key) => {
      const tab = fileBrowserTabs.find((candidate) => fileEditorKeyId(candidate.key) === fileEditorKeyId(key))
      if (tab) stickifyFileBrowserTab(tab.id)
    },
    onSavedContent: () => {
      setFileBrowserRefreshNonce((previous) => previous + 1)
      setSourceControlRefreshNonce((previous) => previous + 1)
    },
  })
  const fileEditSession = fileEditSessions.active
  const fileEditorCoordinatorOptions = useMemo(() => ({
    getDirtySnapshots: fileEditSessions.getDirtySnapshots,
    getGuardForKey: fileEditSessions.getControllerForKey,
  }), [fileEditSessions.getControllerForKey, fileEditSessions.getDirtySnapshots])
  const fileEditorCoordinator = useFileEditorCoordinator(null, fileEditorCoordinatorOptions)

  useEffect(() => {
    const unregister = fileBrowserTabs.map((tab) =>
      fileEditorCoordinator.registerWritableEditor(tab.key, fileEditSessions.getControllerForKey(tab.key)),
    )
    return () => {
      unregister.forEach((dispose) => dispose())
    }
  }, [fileBrowserTabs, fileEditSessions, fileEditorCoordinator])

  useEffect(() => {
    const retainedTabKeys = new Set(allFileBrowserTabs.map((tab) => tab.id))
    for (const key of fileEditSessions.getSessionKeys()) {
      if (!retainedTabKeys.has(fileEditorKeyId(key))) {
        fileEditSessions.removeSession(key)
      }
    }
  }, [allFileBrowserTabs, fileEditSessions])

  const dirtyFileBrowserTabIds = useMemo(() => new Set(
    fileBrowserTabs
      .filter((tab) => fileEditSessions.getDirtySnapshotForKey(tab.key)?.isDirty)
      .map((tab) => tab.id),
  ), [fileBrowserTabs, fileEditSessions])

  const handleFileEditorContentLoaded = useCallback((key: FileEditorSessionKey, content: FileContentResult | null) => {
    fileEditSessions.handleContentLoaded(key, content)
  }, [fileEditSessions])

  const isInlineDiffViewerOpen = isDiffViewerOpen && diffViewerPresentation === 'inline'

  /** Selects a session on `targetEnvironmentId` (default: the addressed environment). */
  const handleSelectAgent = useCallback((agentId: string, targetEnvironmentId = environmentId ?? undefined) => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'select-agent', nextAgentId: agentId }, () => {
      getSidebarPerfRegistry().startSessionSwitch(agentId)
      navigateToRoute({ view: 'chat', agentId, ...(targetEnvironmentId ? { environmentId: targetEnvironmentId } : {}) })
      if (targetEnvironmentId === environmentId) clientRef.current?.subscribeToAgent(agentId)
    })
  }, [clientRef, environmentId, fileEditorCoordinator, navigateToRoute])

  const handleGuardedFileBrowserSelectFile = useCallback((path: string) => {
    handleFileBrowserSelectFile(path)
  }, [handleFileBrowserSelectFile])

  const handleFileBrowserOpenStickyFile = useCallback((path: string) => {
    handleOpenStickyFileBrowserFile(path)
  }, [handleOpenStickyFileBrowserFile])

  const handleFileBrowserCreateFile = useCallback(async (directoryPath: string, name: string): Promise<string | null> => {
    if (!environmentPanels || !activeAgentId) return null
    const result = await createFilePath(environmentPanels, {
      agentId: activeAgentId,
      worktreeId: fileBrowserWorktreeContext?.worktreeId ?? null,
      directoryPath,
      name,
      type: 'file',
    })
    applySuccessfulFileCreateToCaches({
      environmentId: environmentPanels.session.environmentId,
      agentId: activeAgentId,
      worktreeId: fileBrowserWorktreeContext?.worktreeId ?? null,
    })
    setFileBrowserRefreshNonce((previous) => previous + 1)
    setSourceControlRefreshNonce((previous) => previous + 1)
    handleOpenStickyFileBrowserFile(result.path)
    return result.path
  }, [activeAgentId, environmentPanels, fileBrowserWorktreeContext?.worktreeId, handleOpenStickyFileBrowserFile])

  const handleFileBrowserRenameEntry = useCallback((path: string, entryType: 'file' | 'directory', newName: string): Promise<boolean> => {
    if (!environmentPanels || !activeAgentId) return Promise.resolve(false)
    const scope = {
      environmentId: environmentPanels.session.environmentId,
      agentId: activeAgentId,
      worktreeId: fileBrowserWorktreeContext?.worktreeId ?? null,
    }

    const runRename = async (): Promise<boolean> => {
      const result = await renameFilePath(environmentPanels, {
        agentId: activeAgentId,
        worktreeId: fileBrowserWorktreeContext?.worktreeId ?? null,
        path,
        newName,
      })
      applySuccessfulFileRenameToCaches({
        ...scope,
        path,
        newPath: result.newPath,
        entryType,
      })
      renameFileBrowserTabsAffectedByRename(path, result.newPath, entryType)
      fileEditSessions.removeSessionsAffectedByDelete({ ...scope, path, entryType })
      setFileBrowserRefreshNonce((previous) => previous + 1)
      setSourceControlRefreshNonce((previous) => previous + 1)
      return true
    }

    return new Promise<boolean>((resolve, reject) => {
      fileEditorCoordinator.requestFileEditorTransition(
        {
          type: 'rename-entry',
          path,
          entryType,
          ...scope,
        },
        () => {
          void runRename().then(resolve, reject)
        },
        () => resolve(false),
      )
    })
  }, [
    activeAgentId,
    environmentPanels,
    fileBrowserWorktreeContext?.worktreeId,
    fileEditorCoordinator,
    fileEditSessions,
    renameFileBrowserTabsAffectedByRename,
  ])

  const handleFileBrowserDeleteEntry = useCallback((path: string, entryType: 'file' | 'directory'): Promise<boolean> => {
    if (!environmentPanels || !activeAgentId) return Promise.resolve(false)
    const scope = {
      environmentId: environmentPanels.session.environmentId,
      agentId: activeAgentId,
      worktreeId: fileBrowserWorktreeContext?.worktreeId ?? null,
    }

    const runDelete = async (): Promise<boolean> => {
      await deleteFilePath(environmentPanels, {
        agentId: activeAgentId,
        path,
        worktreeId: scope.worktreeId,
      })
      applySuccessfulFileDeleteToCaches({
        ...scope,
        path,
        entryType,
      })
      removeFileBrowserTabsAffectedByDelete(path, entryType)
      fileEditSessions.removeSessionsAffectedByDelete({ ...scope, path, entryType })
      setFileBrowserRefreshNonce((previous) => previous + 1)
      setSourceControlRefreshNonce((previous) => previous + 1)
      return true
    }

    return new Promise<boolean>((resolve, reject) => {
      fileEditorCoordinator.requestFileEditorTransition(
        {
          type: 'delete-entry',
          path,
          entryType,
          ...scope,
        },
        () => {
          void runDelete().then(resolve, reject)
        },
        () => resolve(false),
      )
    })
  }, [
    activeAgentId,
    environmentPanels,
    fileBrowserWorktreeContext?.worktreeId,
    fileEditorCoordinator,
    fileEditSessions,
    removeFileBrowserTabsAffectedByDelete,
  ])

  const handleRequestCloseFileBrowserTab = useCallback((tabId: string) => {
    const tab = fileBrowserTabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    fileEditorCoordinator.requestFileEditorTransition({ type: 'close-tab', key: tab.key }, () => {
      closeFileBrowserTab(tab.id)
      fileEditSessions.removeSession(tab.key)
    })
  }, [closeFileBrowserTab, fileBrowserTabs, fileEditSessions, fileEditorCoordinator])

  const handleGuardedFileBrowserClosePanel = useCallback(() => {
    if (activeFileBrowserTabId) {
      handleRequestCloseFileBrowserTab(activeFileBrowserTabId)
    }
  }, [activeFileBrowserTabId, handleRequestCloseFileBrowserTab])

  const handleGuardedFileBrowserNavigateToDirectory = useCallback((dirPath: string) => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'select-file', nextPath: dirPath }, () => {
      handleFileBrowserNavigateToDirectory(dirPath)
    })
  }, [fileEditorCoordinator, handleFileBrowserNavigateToDirectory])

  const handleGuardedClearFileBrowserWorktreeContext = useCallback(() => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'select-file', nextPath: selectedFileBrowserFile ?? '' }, () => {
      handleClearFileBrowserWorktreeContext()
    })
  }, [fileEditorCoordinator, handleClearFileBrowserWorktreeContext, selectedFileBrowserFile])

  const handleGuardedArtifactsClose = useCallback(() => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-workspace-panel', panel: 'chat' }, () => {
      setIsArtifactsPanelOpen(false)
    })
  }, [fileEditorCoordinator, setIsArtifactsPanelOpen])

  const handleGuardedArtifactDialogClose = useCallback(() => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-workspace-panel', panel: 'chat' }, () => {
      handleCloseArtifact()
    })
  }, [fileEditorCoordinator, handleCloseArtifact])

  const handleGuardedDiffViewerOpenChange = useCallback((open: boolean) => {
    fileEditorCoordinator.requestFileEditorTransition(
      open ? { type: 'open-source-control-inline' } : { type: 'open-workspace-panel', panel: 'chat' },
      () => {
        setIsDiffViewerOpen(open)
      },
    )
  }, [fileEditorCoordinator, setIsDiffViewerOpen])

  const handleGuardedToggleFileBrowser = useCallback(() => {
    const actionType = isFileBrowserOpen ? 'close-file-browser' : 'open-workspace-panel'
    fileEditorCoordinator.requestFileEditorTransition(
      actionType === 'close-file-browser'
        ? { type: 'close-file-browser' }
        : { type: 'open-workspace-panel', panel: 'chat' },
      () => {
        handleToggleFileBrowser()
      },
    )
  }, [fileEditorCoordinator, handleToggleFileBrowser, isFileBrowserOpen])

  const handleOpenDiffViewerModal = useCallback((initialState: DiffViewerInitialState | null = null) => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-source-control-inline' }, () => {
      setDiffViewerPresentation('modal')
      openDiffViewer(initialState)
    })
  }, [fileEditorCoordinator, openDiffViewer])

  const handleOpenDiffViewerDeepLink = useCallback((initialState: DiffViewerInitialState) => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-source-control-inline' }, () => {
      const presentation = resolveSourceControlDeepLinkPresentation(
        activeAgentId,
        activeManagerAgent,
      )

      if (presentation === 'inline') {
        handleCloseWorkspacePanels()
        setDiffViewerPresentation('inline')
      } else {
        setDiffViewerPresentation('modal')
      }
      openDiffViewerDeepLink(initialState)
    })
  }, [
    activeAgentId,
    activeManagerAgent,
    fileEditorCoordinator,
    handleCloseWorkspacePanels,
    openDiffViewerDeepLink,
  ])

  const handleReturnToChatWorkspace = useCallback(() => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-workspace-panel', panel: 'chat' }, () => {
      const chatTargetAgentId = resolveChatRailTargetAgentId(
        activeAgentId,
        activeAgent,
        activeManagerAgent,
      )

      if (chatTargetAgentId && chatTargetAgentId !== activeAgentId) {
        handleSelectAgent(chatTargetAgentId)
      }

      setIsDiffViewerOpen(false)
      setDiffViewerPresentation('modal')
      handleCloseWorkspacePanels()
      messageInputRef.current?.focus()
    })
  }, [activeAgent, activeAgentId, activeManagerAgent, fileEditorCoordinator, handleCloseWorkspacePanels, handleSelectAgent, messageInputRef, setIsDiffViewerOpen])

  const handleToggleFileBrowserFromRail = useCallback(() => {
    if (isFileBrowserOpen && !isInlineDiffViewerOpen) {
      handleGuardedToggleFileBrowser()
      return
    }

    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-workspace-panel', panel: 'chat' }, () => {
      setIsDiffViewerOpen(false)
      setDiffViewerPresentation('modal')
      handleOpenFileBrowser()
    })
  }, [fileEditorCoordinator, handleGuardedToggleFileBrowser, handleOpenFileBrowser, isFileBrowserOpen, isInlineDiffViewerOpen, setIsDiffViewerOpen])

  const handleOpenDiffViewerInline = useCallback(() => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-source-control-inline' }, () => {
      if (isInlineDiffViewerOpen) {
        setIsDiffViewerOpen(false)
        setDiffViewerPresentation('modal')
        return
      }

      handleCloseWorkspacePanels()
      setDiffViewerPresentation('inline')
      openDiffViewer()
    })
  }, [fileEditorCoordinator, handleCloseWorkspacePanels, isInlineDiffViewerOpen, openDiffViewer, setIsDiffViewerOpen])

  const handleGuardedToggleArtifactsPanel = useCallback(() => {
    requestGuardedArtifactsPanelToggle(fileEditorCoordinator, () => {
      handleToggleArtifactsPanel()
    })
  }, [fileEditorCoordinator, handleToggleArtifactsPanel])

  const handleOpenArtifactsFromRail = useCallback((tab: 'artifacts' | 'schedules') => {
    fileEditorCoordinator.requestFileEditorTransition({ type: 'open-workspace-panel', panel: 'artifacts' }, () => {
      if (isInlineDiffViewerOpen) {
        setIsDiffViewerOpen(false)
        setDiffViewerPresentation('modal')
        handleOpenArtifactsPanel(tab)
        return
      }

      handleToggleArtifactsPanel(tab)
    })
  }, [fileEditorCoordinator, handleOpenArtifactsPanel, handleToggleArtifactsPanel, isInlineDiffViewerOpen, setIsDiffViewerOpen])

  const handleCloseDiffViewer = useCallback(() => {
    setIsDiffViewerOpen(false)
  }, [setIsDiffViewerOpen])

  const handleRequestSourceControlMutation = useCallback((
    mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only' | 'push',
    target: { agentId: string; worktreeId: string | null },
    run: () => void,
  ) => {
    if (!environmentId) return
    fileEditorCoordinator.requestFileEditorTransition({
      type: 'source-control-mutation',
      mutation,
      environmentId,
      agentId: target.agentId,
      worktreeId: target.worktreeId,
    }, run)
  }, [environmentId, fileEditorCoordinator])

  const handleSourceControlMutationComplete = useCallback(() => {
    setFileBrowserRefreshNonce((previous) => previous + 1)
  }, [])

  const handleBrowseWorktreeFromSourceControl = useCallback(
    (worktree: GitWorktreeSummary) => {
      fileEditorCoordinator.requestFileEditorTransition({ type: 'select-file', nextPath: '' }, () => {
        handleBrowseWorktreeFiles({
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          branch: worktree.branch,
          repoRoot: worktree.repoRoot,
        })
        setIsDiffViewerOpen(false)
      })
    },
    [fileEditorCoordinator, handleBrowseWorktreeFiles, setIsDiffViewerOpen],
  )

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalShortcutTarget(event)) return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'E' || event.key === 'e')) {
        event.preventDefault()
        handleGuardedToggleFileBrowser()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
        event.preventDefault()
        handleOpenDiffViewerInline()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleGuardedToggleFileBrowser, handleOpenDiffViewerInline])

  useEffect(() => {
    if (!isDiffViewerOpen && diffViewerPresentation === 'inline') {
      setDiffViewerPresentation('modal')
    }
  }, [diffViewerPresentation, isDiffViewerOpen])

  const keyboardShortcutLabels = useMemo(() => {
    const electronPlatform = typeof window !== 'undefined' ? (window.electronBridge?.platform ?? '') : ''
    const platform =
      electronPlatform || (typeof window !== 'undefined' ? (window.navigator.platform ?? '') : '')
    const normalizedPlatform = platform.toLowerCase()
    const isMacPlatform =
      normalizedPlatform.includes('mac') || normalizedPlatform.includes('darwin')
    return {
      terminal: isMacPlatform ? '⌘`' : 'Ctrl+`',
      changes: isMacPlatform ? '⌘⇧D' : 'Ctrl+Shift+D',
    }
  }, [])

  const activityRailItems = useMemo(() => {
    const workspaceDisabled = !isActivityRailWorkspaceAvailable(activeAgentId, activeManagerAgent)
    const artifactsActive = isArtifactsPanelOpen && artifactsPanelTab === 'artifacts'
    const schedulesActive = isArtifactsPanelOpen && artifactsPanelTab === 'schedules'

    const chatActive = !isInlineDiffViewerOpen && !isFileBrowserOpen && !isArtifactsPanelOpen

    return [
      {
        id: 'chat' as const,
        label: 'Chat',
        icon: MessageSquare,
        active: chatActive,
        disabled: !activeAgentId,
        onClick: handleReturnToChatWorkspace,
      },
      {
        id: 'files' as const,
        label: isFileBrowserOpen && !isInlineDiffViewerOpen ? 'Close file browser' : 'Browse Files',
        icon: FolderOpen,
        active: isFileBrowserOpen && !isInlineDiffViewerOpen,
        disabled: workspaceDisabled || !activeAgentId,
        onClick: handleToggleFileBrowserFromRail,
      },
      {
        id: 'changes' as const,
        label: 'Source Control',
        icon: GitBranch,
        active: isInlineDiffViewerOpen,
        disabled: workspaceDisabled || !activeAgentId,
        shortcutLabel: keyboardShortcutLabels.changes,
        onClick: handleOpenDiffViewerInline,
      },
      {
        id: 'terminal' as const,
        label: terminalPanel.isPanelVisible ? 'Hide terminal panel' : 'Terminal',
        icon: SquareTerminal,
        active: terminalPanel.isPanelVisible,
        disabled: !terminalSessionAgentId,
        badge:
          !terminalPanel.isPanelVisible && terminalCount > 0
            ? terminalCount
            : undefined,
        shortcutLabel: keyboardShortcutLabels.terminal,
        onClick: () => {
          terminalPanel.togglePanel()
        },
      },
      {
        id: 'schedules' as const,
        label: 'Cron / Schedules',
        icon: Clock3,
        active: schedulesActive && !isInlineDiffViewerOpen,
        disabled: workspaceDisabled,
        onClick: () => handleOpenArtifactsFromRail('schedules'),
      },
      {
        id: 'artifacts' as const,
        label: 'Artifacts',
        icon: Package,
        active: artifactsActive && !isInlineDiffViewerOpen,
        disabled: workspaceDisabled,
        onClick: () => handleOpenArtifactsFromRail('artifacts'),
      },
    ]
  }, [
    activeAgentId,
    activeManagerAgent,
    artifactsPanelTab,
    handleOpenArtifactsFromRail,
    handleOpenDiffViewerInline,
    handleReturnToChatWorkspace,
    handleToggleFileBrowserFromRail,
    isArtifactsPanelOpen,
    isInlineDiffViewerOpen,
    isFileBrowserOpen,
    terminalCount,
    terminalPanel,
    terminalSessionAgentId,
    keyboardShortcutLabels.changes,
    keyboardShortcutLabels.terminal,
  ])

  return {
    environmentPanels,
    // panel state / values
    activeArtifact,
    isArtifactsPanelOpen,
    setIsArtifactsPanelOpen,
    artifactsPanelTab,
    setArtifactsPanelTab,
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
    isDiffViewerOpen,
    diffViewerPresentation,
    isInlineDiffViewerOpen,
    diffViewerInitialState,
    diffViewerNavigationRequest,
    isFileBrowserOpen,
    selectedFileBrowserFile,
    fileBrowserTabs,
    activeFileBrowserTabId,
    previewFileBrowserTabId,
    activateFileBrowserTab,
    stickifyFileBrowserTab,
    fileBrowserTreeSnapshot,
    activeFileBrowserContentScrollSnapshot,
    updateFileBrowserTreeSnapshot,
    updateActiveFileBrowserContentScrollSnapshot,
    fileBrowserWorktreeContext,
    fileBrowserRefreshNonce,
    sourceControlRefreshNonce,
    fileEditSession,
    activeFileEditorKey,
    dirtyFileBrowserTabIds,
    fileEditorCoordinator,
    activityRailItems,
    // handlers
    handleOpenArtifact,
    handleSelectAgent,
    handleFileEditorContentLoaded,
    handleGuardedFileBrowserSelectFile,
    handleFileBrowserOpenStickyFile,
    handleFileBrowserCreateFile,
    handleFileBrowserRenameEntry,
    handleFileBrowserDeleteEntry,
    handleRequestCloseFileBrowserTab,
    handleGuardedFileBrowserClosePanel,
    handleGuardedFileBrowserNavigateToDirectory,
    handleGuardedClearFileBrowserWorktreeContext,
    handleGuardedArtifactsClose,
    handleGuardedArtifactDialogClose,
    handleGuardedDiffViewerOpenChange,
    handleGuardedToggleFileBrowser,
    handleOpenDiffViewerModal,
    handleOpenDiffViewerDeepLink,
    handleReturnToChatWorkspace,
    handleToggleFileBrowserFromRail,
    handleOpenDiffViewerInline,
    handleGuardedToggleArtifactsPanel,
    handleCloseDiffViewer,
    handleRequestSourceControlMutation,
    handleSourceControlMutationComplete,
    handleBrowseWorktreeFromSourceControl,
  }
}
