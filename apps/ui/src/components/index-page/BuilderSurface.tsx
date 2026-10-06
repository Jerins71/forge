import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AgentSidebarConnected } from '@/components/chat/AgentSidebarConnected'
import { WorkGraphWorkerHighlightProvider } from '@/components/chat/WorkGraphWorkerHighlight'
import { ArtifactsSidebar } from '@/components/chat/ArtifactsSidebar'
import { shouldRevealBrowserPanel } from '@/components/index-page/activity-rail-workspace'
import { BrowserAutomationHost, type BrowserAutomationHostHandle } from '@/components/browser/BrowserAutomationHost'
import { BrowserPreviewSurface } from '@/components/browser/BrowserPreviewSurface'
import { BrowserPanel, type BrowserWorkspaceCommandPort } from '@/components/browser/BrowserPanel'
import { countOpenBrowserTabs, projectRuntimeBrowserTabState } from '@/components/browser/browser-runtime-state'
import type { ManagedBrowserWorkspaceMode } from '@/lib/electron-bridge'
import { ArchiveView } from '@/components/index-page/ArchiveView'
import { type MessageSourceView } from '@/components/chat/ChatHeader'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import type { ProjectSettingsActions } from '@/components/settings/SettingsProjectSettings'
import { type MessageInputHandle } from '@/components/chat/MessageInput'
import type {
  SecureGrantInput,
  SecurePrivateFulfillmentInput,
  SecureSessionAvailability,
  SecureSessionPickerConfig,
  SecureSessionRequestConfig,
} from '@/components/chat/secure-session/types'
import {
  resolveSecureOutputQuarantineUi,
  secureOutputQuarantineConfigFields,
} from '@/components/chat/secure-session/output-quarantine'
import { isSessionModelPickerEligible } from '@/components/chat/message-input/session-model-picker-eligibility'
import { isSecureSessionRuntimeSupported } from '@/components/index-page/secure-session-runtime-eligibility'
import { shouldShowSecureSessionPicker } from '@/components/index-page/secure-session-picker-visibility'
import { type MessageListHandle } from '@/components/chat/MessageList'
import { ChatSidePanels } from '@/components/index-page/ChatSidePanels'
import { ChatWorkspace } from '@/components/index-page/ChatWorkspace'
import { FileBrowserPanel } from '@/components/file-browser/FileBrowserPanel'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { FileDirtyConfirmDialog } from '@/components/file-browser/FileDirtyConfirmDialog'
import { FILE_BROWSER_INLINE_EDITING_ENABLED } from '@/components/file-browser/file-editor-feature-gates'
import type { useFileEditorCoordinator } from '@/components/file-browser/use-file-editor-coordinator'
import { DiffViewerContent } from '@/components/diff-viewer/DiffViewerDialog'
import {
  remoteUpdateSnapshotMatchesTarget,
  type RemoteUpdateAwarenessMutationTarget,
} from '@/components/diff-viewer/remote-update-awareness-mutation'
import { GlobalDialogs } from '@/components/index-page/GlobalDialogs'
import { BitwardenUnlockDialog } from '@/components/chat/secure-session/BitwardenUnlockDialog'
import { StatsPage } from '@/components/index-page/StatsPage'
import { shouldEnableCodexMention } from '@/components/index-page/codex-mention-utils'
import { defaultMessageSourceViewForAgentRole } from '@/components/index-page/message-source-view'
import { resolveWorkerFetchManagerId } from '@/lib/agent-hierarchy'
import {
  DEFAULT_MANAGER_AGENT_ID,
  type ActiveView,
  type AppRouteState,
  type StatsTab,
} from '@/hooks/index-page/use-route-state'
import { resolveStreamDeckNavigationRoute } from '@/hooks/index-page/stream-deck-navigation'
import { fetchModelCacheVisualizationEnabled } from '@/components/settings/model-cache-visualization-api'
import { activateRemoteUpdateAwarenessProject } from '@/components/settings/remote-update-awareness-api'
import { getActiveLocalRemoteUpdateSnapshot } from '@/components/index-page/remote-update-awareness'
import {
  BuilderSidebarOrderApiConflictError,
  createLocalBuilderSidebarOrderApi,
  type BuilderSidebarOrderApi,
} from '@/lib/builder-sidebar-order-api'
import {
  applySecureSessionProjectDefaults,
  approveSecureSshHostTrustRequest,
  denySecureAccessRequest,
  dismissSecureSshHostTrustRequest,
  fetchSecureSessionCatalog,
  fetchSecureSessionSnapshot,
  fulfillSecureAccessRequestPrivately,
  grantSecureSessionLease,
  grantSecureSessionLeases,
  isPrivateSecureFulfillmentAvailable,
  isSecureControlAvailable,
  revokeSecureSessionLease,
  resolveSecureSecretsForProfile,
  secureSessionUiErrorMessage,
  SecureSessionUiError,
  shouldRefreshAfterProjectDefaultsApplyError,
  startSecureSession,
  setSecureSessionAccess,
  stopSecureSession,
  toSecureSecretOptions,
  toSecureSessionSnapshotView,
  unlockLocalProjectDefaultsIfNeeded,
} from '@/lib/secure-sessions-api'
import {
  fetchBitwardenPasswordManagerSettings,
  resolveMaxProjectDefaults,
  unlockBitwardenPasswordManager,
  type SecureSecretsCatalog,
} from '@/lib/secure-secrets-api'
import { useBitwardenUnlockPrompt } from './use-bitwarden-unlock-prompt'
import {
  claimSecureBrowserPairing,
  createSecureBrowserPairingRequest,
  fetchSecureBrowserControlStatus,
} from '@/lib/secure-browser-control-api'
import { hydrateSessionWorkers } from './worker-hydration'
import {
  reconcileSecureBatchGrantFailure,
  secureGrantMatchesSnapshot,
  shouldRefreshSecureRequestAfterError,
} from './secure-batch-grant-reconciliation'
import type { ManagerWsClient } from '@/lib/ws-client'
import { buildModelCacheHeaderSummary } from '@/components/chat/model-cache'
import { isPiGenerationThroughputEligible } from '@/lib/generation-throughput-eligibility'
import { deriveMissingPendingChoiceIds } from '@/lib/ws-client/utils'
import { useEnvironmentConnection, useEnvironmentHandles } from '@/hooks/index-page/use-environment-connection'
import { useEnvironmentSettingsClient } from '@/hooks/use-environment-settings-client'
import { useOriginSlice } from '@/lib/origin-store'
import type { ManagerWsState } from '@/lib/ws-state'
import { useManagerActions } from '@/hooks/index-page/use-manager-actions'
import { useActiveAgent } from '@/hooks/index-page/use-active-agent'
import { useWorkspacePanels } from '@/hooks/index-page/use-workspace-panels'
import { useTranscriptController } from '@/hooks/index-page/use-transcript-controller'
import { useSessionActions } from '@/hooks/index-page/use-session-actions'
import { useSideChat } from '@/hooks/index-page/use-side-chat'
import { SideChatPanel } from '@/components/index-page/SideChatPanel'
import { useFileDrop } from '@/hooks/index-page/use-file-drop'
import {
  getProjectAgentSuggestions,
  shouldLoadExternalProjectAgentDirectory,
} from '@/hooks/index-page/project-agent-suggestions'
import { SIDE_SLASH_COMMAND, useSlashCommands } from '@/hooks/index-page/use-slash-commands'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { useConversationThroughputDisplayPreference } from '@/hooks/use-conversation-throughput-display-preference'
import { useDynamicFavicon } from '@/hooks/use-dynamic-favicon'
import { useTerminalPanel } from '@/hooks/useTerminalPanel'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { useEnvironmentNavigation } from '@/components/chat/agent-sidebar/hooks/useEnvironmentNavigation'
import { EnvironmentSessionStrip, EnvironmentSessionView, LaunchSessionWorkspace } from '@/components/index-page/EnvironmentSessionWorkspace'
import type { SessionRef } from '@forge/protocol/environment-v2'
import { qualifiedKey } from '@forge/client-runtime'
import { useRevokedDraftPurge } from '@/hooks/use-revoked-draft-purge'
import { Archive, BarChart3, FolderPlus, MessageSquarePlus, Settings2, SunMoon } from 'lucide-react'
import { applyAppearanceConfig, applyThemePreference, readStoredAppearanceConfig } from '@/lib/theme'
import { CommandPalette, type CommandPaletteCommand, type CommandPaletteSession } from './CommandPalette'
import {
  type AgentDescriptor,
  type ProjectAgentExternalDirectoryEntry,
  type RemoteUpdateAwarenessProjectSnapshot,
  type SecureBrowserControlStatus,
  type SecureSessionSnapshot,
} from '@forge/protocol'

type FileEditorCoordinator = ReturnType<typeof useFileEditorCoordinator>

interface BuilderSurfaceProps {
  wsUrl: string
  routeState: AppRouteState
  activeView: ActiveView
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
}

export function BuilderSurface({
  wsUrl,
  routeState,
  activeView,
  navigateToRoute,
}: BuilderSurfaceProps) {
  const [showConversationThroughput] = useConversationThroughputDisplayPreference()


  // Shell-level refs shared across the extracted controllers.  Keeping these at
  // the shell (not inside a hook) is what breaks the apparent ordering cycle
  // between active-agent derivation and the workspace panels: the route-sync
  // effect reads `fileEditorCoordinatorRef.current` lazily, and the shell keeps
  // the ref current during render once the panels hook has created the
  // coordinator — so every effect (regardless of which hook registered it) sees
  // the live coordinator.
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)
  const previousAgentsByIdRef = useRef<Map<string, AgentDescriptor>>(new Map())
  const fileEditorCoordinatorRef = useRef<FileEditorCoordinator | null>(null)
  const archiveHydrationRequestedRef = useRef(false)
  const browserHostRef = useRef<BrowserAutomationHostHandle | null>(null)
  const browserSelectionRef = useRef<{ sessionAgentId: string | null; profileId: string | null }>({
    sessionAgentId: null,
    profileId: null,
  })
  const handledBrowserRevealRef = useRef<string | null>(null)
  const handledDeckPanelRef = useRef<string | null>(null)
  const handledStreamDeckNavigationRef = useRef<string | null>(null)
  const [browserWorkspaceMode, setBrowserWorkspaceMode] = useState<ManagedBrowserWorkspaceMode>(
    window.electronBridge?.browserWorkspace?.capability.popoutAvailable ? 'docked' : 'unavailable',
  )
  const browserCommandPort = useMemo<BrowserWorkspaceCommandPort>(() => {
    const host = (): BrowserAutomationHostHandle => {
      if (!browserHostRef.current) throw new Error('Browser controller is unavailable')
      return browserHostRef.current
    }
    return {
      open: (autoOpenAttemptKey) => host().open(autoOpenAttemptKey), activate: (tabId) => host().activate(tabId), close: (tabId) => host().close(tabId),
      resize: (tabId, viewport) => host().resize(tabId, viewport), navigate: (tabId, url) => host().navigate(tabId, url),
      history: async (tabId, direction) => host().history(tabId, direction), reload: async (tabId, hard) => host().reload(tabId, hard),
      zoom: async (tabId, factor) => host().setZoom(tabId, factor), capture: (tabId) => host().captureScreenshot(tabId),
      startRecording: (tabId) => host().startRecording(tabId), stopRecording: (tabId, recordingId) => host().stopRecording(tabId, recordingId),
      reveal: (tabId) => host().reveal(tabId), takeControl: (tabId) => host().takeControl(tabId),
      popOut: () => host().popOut(), dock: () => host().dock(),
    }
  }, [])

  // ── Environment addressing ──
  // The chat workspace and every project panel address the routed session's own environment. The
  // sidebar tree, project actions and app-wide views stay on the primary environment unless Settings
  // or Stats explicitly target another one. An unknown environment is never opened against another host.
  const environmentContext = useOptionalEnvironmentContext()
  const primaryEnvironmentId = environmentContext?.primaryEnvironmentId || null
  const routedEnvironmentId = routeState.view === 'chat' || routeState.view === 'settings' ? routeState.environmentId : undefined
  const selectedEnvironmentId = routedEnvironmentId ?? primaryEnvironmentId
  const { client: localClient, clientRef, httpClientRef, state, setState } = useEnvironmentConnection(selectedEnvironmentId)
  const isPrimarySelected = selectedEnvironmentId === primaryEnvironmentId
  // App-level calls (onboarding, provider usage) address this machine.
  const primarySettingsClient = useEnvironmentSettingsClient(primaryEnvironmentId)
  const selectedSettingsClient = useEnvironmentSettingsClient(selectedEnvironmentId)
  // Stable so delivery-state rows stay memoized; Retry keeps the command, Resend creates a new one.
  const handleRetryEnvironmentMessage = useCallback((commandId: string) => {
    clientRef.current?.retryEnvironmentMessage(commandId)
  }, [clientRef])
  const handleResendEnvironmentMessage = useCallback((commandId: string) => {
    clientRef.current?.resendEnvironmentMessage(commandId)
  }, [clientRef])
  // The primary feeds only the sidebar's project actions. Its handles do not subscribe, and while
  // another environment is selected only its session and project lists are read, so primary
  // conversation traffic never re-renders the remote chat workspace.
  const primary = useEnvironmentHandles(primaryEnvironmentId)
  const primarySidebarSlice = useOriginSlice(
    isPrimarySelected ? UNSELECTED_ORIGIN : primaryEnvironmentId ?? UNSELECTED_ORIGIN,
    selectPrimarySidebarState,
    { selectorKey: 'builder-primary-sidebar', equalityFn: samePrimarySidebarState },
  )
  const environmentClient = localClient.getEnvironmentClient() ?? null
  useRevokedDraftPurge()
  const primaryState = isPrimarySelected ? state : primarySidebarSlice
  const builderSidebarOrderApi = useMemo(
    () => withPrimaryOrderOrigin(createLocalBuilderSidebarOrderApi(wsUrl), primaryEnvironmentId),
    [primaryEnvironmentId, wsUrl],
  )
  // Primary routes keep their environment-free URLs.
  const navigateToBuilderRoute = useCallback((next: AppRouteState, replace?: boolean) => {
    navigateToRoute(next.view === 'chat' && next.environmentId === primaryEnvironmentId
      ? { ...next, environmentId: undefined }
      : next, replace)
  }, [navigateToRoute, primaryEnvironmentId])
  const handleBrowserRuntimeTabStateChanged = useCallback((tab: Parameters<typeof projectRuntimeBrowserTabState>[1]) => {
    setState((previous) => projectRuntimeBrowserTabState(previous, tab))
  }, [setState])

  useEffect(() => {
    let cancelled = false
    void fetchModelCacheVisualizationEnabled(httpClientRef.current ?? wsUrl)
      .then((enabled) => {
        if (!cancelled) {
          clientRef.current?.applyLoadedModelCacheVisualizationSetting(enabled)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [clientRef, httpClientRef, wsUrl])

  useEffect(() => {
    if (activeView !== 'archive') {
      archiveHydrationRequestedRef.current = false
      return
    }
    if (!state.connected || archiveHydrationRequestedRef.current) return
    archiveHydrationRequestedRef.current = true
    clientRef.current?.hydrateArchiveLastUsed().catch((error) => {
      console.warn('Failed to hydrate archive last-used metadata', error)
      archiveHydrationRequestedRef.current = false
    })
  }, [activeView, clientRef, state.connected])

  const {
    onboardingState,
    isMutating: isMutatingOnboardingState,
    error: onboardingError,
    savePreferences: saveOnboardingPreferences,
    skip: skipOnboarding,
  } = useOnboardingState(primarySettingsClient)

  const [messageSourceView, setMessageSourceView] = useState<MessageSourceView>('web')
  const [planExpanded, setPlanExpanded] = useState(false)
  const [externalProjectAgentEntries, setExternalProjectAgentEntries] = useState<ProjectAgentExternalDirectoryEntry[]>([])
  const [secureCatalog, setSecureCatalog] = useState<SecureSecretsCatalog | null>(null)
  const [secureCatalogLoading, setSecureCatalogLoading] = useState(false)
  const [secureCatalogUnavailable, setSecureCatalogUnavailable] = useState(false)
  const [secureRuntimeUnsupported, setSecureRuntimeUnsupported] = useState(false)
  const [secureBrowserControl, setSecureBrowserControl] =
    useState<SecureBrowserControlStatus | null>(null)
  const [acknowledgedSecureOutputQuarantineKey, setAcknowledgedSecureOutputQuarantineKey] =
    useState<string | null>(null)

  // ── Environment-qualified routes ──
  // A session on another environment, or a launch draft, is rendered from the environment runtime.
  // The local route→subscription sync must not see its session ID, so it is never opened locally.
  const routedSessionId = routeState.view === 'chat' ? routeState.agentId : undefined
  const environmentSession = useMemo<SessionRef | null>(
    () => routedEnvironmentId && routedSessionId && !isPrimarySelected
      ? { environmentId: routedEnvironmentId, sessionId: routedSessionId }
      : null,
    [isPrimarySelected, routedEnvironmentId, routedSessionId],
  )
  const launchGroupKey = routeState.view === 'chat' && environmentContext ? routeState.launch ?? null : null
  const isUnknownEnvironment = routedEnvironmentId !== undefined && !environmentClient
  const localRouteState = useMemo<AppRouteState>(
    // A launch draft or unknown environment leaves the current subscription untouched.
    () => (launchGroupKey !== null || isUnknownEnvironment ? { view: 'archive' } : routeState),
    [isUnknownEnvironment, launchGroupKey, routeState],
  )
  const handleSelectEnvironmentSession = useCallback((session: SessionRef) => {
    navigateToBuilderRoute({ view: 'chat', agentId: session.sessionId, environmentId: session.environmentId })
  }, [navigateToBuilderRoute])
  const handleNewEnvironmentSession = useCallback((groupKey: string) => {
    navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID, launch: groupKey })
  }, [navigateToRoute])
  const environmentNavigation = useEnvironmentNavigation({
    selectedSession: environmentSession,
    onSelectSession: handleSelectEnvironmentSession,
    onNewSession: handleNewEnvironmentSession,
  })

  // ── Active-agent derivation + route→subscription sync ──
  const {
    activeAgentId,
    activeAgent,
    activeManagerId,
    activeManagerAgent,
    isActiveManager,
    terminalSessionAgentId,
    activeAgentStatus,
    activeAgentProfileName,
    activeAgentSessionLabel,
    activeAgentLabel,
  } = useActiveAgent({
    state,
    routeState: localRouteState,
    navigateToRoute: navigateToBuilderRoute,
    clientRef,
    fileEditorCoordinatorRef,
    previousAgentsByIdRef,
  })

  const totalUnreadCount = useMemo(() => {
    if (!state.unreadCounts) return 0
    return Object.entries(state.unreadCounts).reduce((sum, [agentId, count]) => {
      if (agentId === activeAgentId) return sum
      return sum + count
    }, 0)
  }, [state.unreadCounts, activeAgentId])

  // Reset local chat chrome when switching active agent/session
  useEffect(() => {
    setPlanExpanded(false)
    setMessageSourceView(defaultMessageSourceViewForAgentRole(activeAgent?.role))
  }, [activeAgentId, activeAgent?.role])

  useEffect(() => {
    clientRef.current?.setConversationView(messageSourceView)
  }, [clientRef, messageSourceView])

  const planSnapshot = isActiveManager && activeAgentId && state.planSnapshotLoadingSessionId !== activeAgentId
    ? state.planSnapshots[activeAgentId] ?? null
    : null
  const goalSnapshot = isActiveManager && activeAgentId && state.goalSnapshotLoadingSessionId !== activeAgentId
    ? state.goalSnapshots[activeAgentId] ?? null
    : null
  const secureAuthorityAgentId = activeAgent?.role === 'worker'
    ? activeAgent.managerId
    : activeAgentId
  const secureSessionSnapshot =
    secureAuthorityAgentId
    && state.secureSessionSnapshotLoadingSessionId !== activeAgentId
      ? state.secureSessionSnapshots[secureAuthorityAgentId] ?? null
      : null

  useEffect(() => {
    if (!state.connected) {
      setSecureCatalog(null)
      setSecureCatalogLoading(false)
      setSecureCatalogUnavailable(false)
      return
    }
    const apiClient = httpClientRef.current
    if (!apiClient) return

    let cancelled = false
    setSecureCatalogLoading(true)
    setSecureCatalogUnavailable(false)
    void fetchSecureSessionCatalog(apiClient)
      .then((catalog) => {
        if (cancelled) return
        setSecureCatalog(catalog)
        setSecureCatalogUnavailable(false)
      })
      .catch(() => {
        if (cancelled) return
        setSecureCatalog(null)
        setSecureCatalogUnavailable(true)
      })
      .finally(() => {
        if (!cancelled) setSecureCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    activeAgentId,
    httpClientRef,
    state.connected,
    state.secureSecretCatalogRevision,
  ])

  const refreshSecureBrowserControl = useCallback(async () => {
    if (!state.connected) {
      setSecureBrowserControl(null)
      return null
    }
    const apiClient = httpClientRef.current
    if (!apiClient) return null
    try {
      const status = await fetchSecureBrowserControlStatus(apiClient)
      setSecureBrowserControl(status)
      return status
    } catch {
      setSecureBrowserControl(null)
      return null
    }
  }, [httpClientRef, state.connected])

  useEffect(() => {
    void refreshSecureBrowserControl()
  }, [refreshSecureBrowserControl])

  const handleUnlockBitwardenPasswordManager = useCallback(async (
    providerId: string,
    masterPassword: string,
  ) => {
    const apiClient = httpClientRef.current
    if (!apiClient) {
      throw new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE')
    }

    await unlockBitwardenPasswordManager(apiClient, providerId, masterPassword)
    setSecureCatalog((current) => current
      ? {
          ...current,
          providers: current.providers.map((provider) => provider.providerId === providerId
            ? { ...provider, status: 'available' }
            : provider),
        }
      : current)

    try {
      setSecureCatalog(await fetchSecureSessionCatalog(apiClient))
      setSecureCatalogUnavailable(false)
    } catch {
      // Unlock succeeded. The catalog revision event will retry the refresh.
    }
  }, [httpClientRef])

  const {
    lockedProvider: lockedBitwardenProvider,
    prompt: bitwardenUnlockPrompt,
    ensureUnlocked: ensureBitwardenUnlocked,
    unlockPrompt: unlockBitwardenPrompt,
    dismissPrompt: dismissBitwardenPrompt,
  } = useBitwardenUnlockPrompt({
    catalog: secureCatalog,
    providerIds: secureCatalog?.secrets.filter((secret) =>
      secureSessionSnapshot?.projectDefaults?.some((entry) => entry.secretId === secret.secretId
        && entry.state !== 'blocked')).map((secret) => secret.providerId) ?? [],
    promptWhenNeeded: secureSessionSnapshot?.accessPolicy?.paused !== true
      && !secureSessionSnapshot?.accessPolicy?.blockedAgentIds.includes(activeAgentId ?? '')
      && secureSessionSnapshot?.projectDefaults?.some((entry) => entry.state === 'unavailable') === true,
    active: state.connected && true,
    canUnlock:
      isSecureControlAvailable(secureBrowserControl?.authorized === true)
      && isPrivateSecureFulfillmentAvailable(
        secureBrowserControl?.privateEntryAvailable === true,
      ),
    unlock: handleUnlockBitwardenPasswordManager,
  })

  useEffect(() => {
    if (
      !state.connected
      || !activeAgentId
      || !isSecureSessionRuntimeSupported(activeAgent)
    ) {
      setSecureRuntimeUnsupported(false)
      return
    }
    const apiClient = httpClientRef.current
    const client = clientRef.current
    if (!apiClient || !client) return

    let cancelled = false
    const requestedSessionAgentId = activeAgentId
    setSecureRuntimeUnsupported(false)
    void fetchSecureSessionSnapshot(apiClient, requestedSessionAgentId)
      .then((snapshot) => {
        if (!cancelled && clientRef.current === client) {
          client.applySecureSessionSnapshot(snapshot)
        }
      })
      .catch((error) => {
        if (cancelled) return
        setSecureRuntimeUnsupported(
          error instanceof SecureSessionUiError
          && error.code === 'SECURE_SESSION_UNSUPPORTED',
        )
      })
    return () => {
      cancelled = true
    }
  }, [
    activeAgentId,
    activeAgent,
    clientRef,
    httpClientRef,
    state.connected,
  ])

  const secureSessionAvailability = useMemo<SecureSessionAvailability>(() => {
    if (!isSecureSessionRuntimeSupported(activeAgent) || secureRuntimeUnsupported) {
      return { state: 'unsupported_runtime' }
    }
    if (secureCatalogUnavailable) {
      return { state: 'source_unavailable' }
    }
    return { state: 'available' }
  }, [
    activeAgent,
    secureCatalogUnavailable,
    secureRuntimeUnsupported,
  ])

  const secureSecretOptions = useMemo(
    () => toSecureSecretOptions(resolveSecureSecretsForProfile(
      secureCatalog?.secrets ?? [],
      secureSessionSnapshot?.profileId ?? activeAgent?.profileId,
    )),
    [
      activeAgent?.profileId,
      secureCatalog?.secrets,
      secureSessionSnapshot?.profileId,
    ],
  )
  const secureSessionSnapshotView = useMemo(
    () => secureSessionSnapshot
      ? toSecureSessionSnapshotView(secureSessionSnapshot)
      : null,
    [secureSessionSnapshot],
  )
  const secureOutputQuarantineUi = useMemo(
    () => resolveSecureOutputQuarantineUi({
      snapshot: secureSessionSnapshotView,
      originId: selectedEnvironmentId ?? '',
      acknowledgedKey: acknowledgedSecureOutputQuarantineKey,
    }),
    [
      selectedEnvironmentId,
      acknowledgedSecureOutputQuarantineKey,
      secureSessionSnapshotView,
    ],
  )
  const handleDismissSecureOutputQuarantine = useCallback(() => {
    if (secureOutputQuarantineUi.eventKey) {
      setAcknowledgedSecureOutputQuarantineKey(secureOutputQuarantineUi.eventKey)
    }
  }, [secureOutputQuarantineUi.eventKey])
  useEffect(() => {
    if (
      secureSessionSnapshotView
      && secureSessionSnapshotView.outputState !== 'quarantined'
      && acknowledgedSecureOutputQuarantineKey !== null
    ) {
      setAcknowledgedSecureOutputQuarantineKey(null)
    }
  }, [acknowledgedSecureOutputQuarantineKey, secureSessionSnapshotView])
  const securePendingRequestViews = useMemo(
    () => secureSessionSnapshotView?.pendingRequests ?? [],
    [secureSessionSnapshotView],
  )
  const securePendingSshTrustRequestViews = useMemo(
    () => secureSessionSnapshotView?.pendingSshTrustRequests ?? [],
    [secureSessionSnapshotView],
  )

  const modelCacheHeaderSummary =
    state.modelCacheVisualizationEnabled && isActiveManager
      ? buildModelCacheHeaderSummary({
          enabled: true,
          observations: state.modelCacheObservations,
        })
      : null

  const activeAgentRole = activeAgent?.role ?? null
  const activeAgentProfileId = activeAgent?.profileId ?? null
  const activeAgentProfile = useMemo(
    () => state.profiles.find((profile) => profile.profileId === activeAgentProfileId) ?? null,
    [activeAgentProfileId, state.profiles],
  )
  const activeAgentProfileType = activeAgentProfile?.profileType ?? null
  const activeProjectId = activeAgent?.profileId ?? activeManagerAgent?.profileId ?? null
  const remoteUpdateSnapshot = getActiveLocalRemoteUpdateSnapshot(
    state.remoteUpdateAwarenessSnapshot,
    activeProjectId,
  )
  const handleRemoteUpdateSnapshotChange = useCallback((
    snapshot: RemoteUpdateAwarenessProjectSnapshot,
    expectedTarget?: RemoteUpdateAwarenessMutationTarget,
  ) => {
    setState((current) => {
      if (expectedTarget) {
        const currentProjection = getActiveLocalRemoteUpdateSnapshot(
          current.remoteUpdateAwarenessSnapshot,
          activeProjectId,
        )
        if (!remoteUpdateSnapshotMatchesTarget(currentProjection, expectedTarget)) {
          return current
        }
      }
      return { ...current, remoteUpdateAwarenessSnapshot: snapshot }
    })
  }, [activeProjectId, setState])

  useEffect(() => {
    if (!state.connected || !activeProjectId) return
    if (!environmentClient) return
    void activateRemoteUpdateAwarenessProject(environmentClient.features.settings, activeProjectId).catch(() => undefined)
  }, [activeProjectId, environmentClient, state.connected])

  useEffect(() => {
    if (!state.connected || !shouldLoadExternalProjectAgentDirectory({
      activeAgentRole,
      activeProfileId: activeAgentProfileId,
      activeProfileType: activeAgentProfileType,
    })) {
      setExternalProjectAgentEntries([])
      return
    }

    const client = clientRef.current
    if (!client) {
      setExternalProjectAgentEntries([])
      return
    }

    let cancelled = false
    void client.getProjectAgentExternalDirectory()
      .then((result) => {
        if (!cancelled) {
          setExternalProjectAgentEntries(result.entries)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExternalProjectAgentEntries([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    activeAgentProfileId,
    activeAgentProfileType,
    activeAgentRole,
    clientRef,
    state.connected,
    state.promptChangeKey,
  ])

  // Project agents for @mention autocomplete — only when the active agent is a manager session
  const projectAgentSuggestions = useMemo(
    () => getProjectAgentSuggestions(activeAgent, state.agents, externalProjectAgentEntries),
    [activeAgent, externalProjectAgentEntries, state.agents],
  )

  const terminalPanel = useTerminalPanel({
    environmentClient,
    sessionAgentId: terminalSessionAgentId,
    sessionCwd: activeManagerAgent?.cwd ?? activeAgent?.cwd ?? null,
    terminals: state.terminals,
    enabled: activeView === 'chat',
    onError: (message) => {
      setState((previous) => ({
        ...previous,
        lastError: message,
      }))
    },
  })

  const browserSessionAgentId = activeManagerAgent?.agentId ?? null
  const browserProfileId = activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null
  browserSelectionRef.current = { sessionAgentId: browserSessionAgentId, profileId: browserProfileId }
  const browserSessionSnapshot = browserSessionAgentId
    ? state.browserSessions[browserSessionAgentId] ?? null
    : null

  // ── Workspace panels (file browser / diff viewer / artifacts / activity rail) ──
  const panels = useWorkspacePanels({
    environmentClient,
    activeAgentId,
    activeAgent,
    activeManagerAgent,
    terminalSessionAgentId,
    terminalPanel,
    terminalCount: state.terminals.length,
    browserTabCount: countOpenBrowserTabs(browserSessionSnapshot),
    clientRef,
    messageInputRef,
    navigateToRoute: navigateToBuilderRoute,
  })

  // Keep the shell-level coordinator ref current for the active-agent route-sync
  // effect.  Assigned during render (after panels creates the coordinator) so it
  // is visible to every effect on the next commit, matching the original
  // in-component ordering where the ref always held the live coordinator.
  fileEditorCoordinatorRef.current = panels.fileEditorCoordinator

  const handleOpenManagedPreviewTab = useCallback(async (tabId: string): Promise<void> => {
    const selection = browserSelectionRef.current
    await browserCommandPort.activate(tabId)
    const currentSelection = browserSelectionRef.current
    if (currentSelection.sessionAgentId !== selection.sessionAgentId || currentSelection.profileId !== selection.profileId) return
    panels.handleOpenBrowserFromReveal()
    if (browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening') {
      await browserHostRef.current?.bringToFront()
    }
  }, [browserCommandPort, browserWorkspaceMode, panels])

  useEffect(() => {
    const request = state.streamDeckNavigationRequest
    if (!request || handledStreamDeckNavigationRef.current === request.requestId) return
    if (window.electronBridge?.windowRole !== 'main') return
    handledStreamDeckNavigationRef.current = request.requestId
    void window.electronBridge.focusMainWindow?.()
    const nextRoute = resolveStreamDeckNavigationRoute(request, activeAgentId)
    if (nextRoute) navigateToRoute(nextRoute)
  }, [
    activeAgentId,
    state.streamDeckNavigationRequest,
    navigateToRoute,
  ])

  useEffect(() => {
    if (routeState.view !== 'chat' || !routeState.deckPanel || !activeAgentId) return
    if (routeState.deckPanel === 'terminal' && !terminalSessionAgentId) return
    const streamDeckRequest = state.streamDeckNavigationRequest
    const streamDeckRequestId =
      streamDeckRequest?.sessionAgentId === activeAgentId &&
      streamDeckRequest.surface === routeState.deckPanel
        ? streamDeckRequest.requestId
        : 'route'
    const requestKey = `${activeAgentId}:${routeState.deckPanel}:${streamDeckRequestId}`
    if (handledDeckPanelRef.current === requestKey) return
    handledDeckPanelRef.current = requestKey

    if (routeState.deckPanel === 'git') {
      panels.handleOpenDiffViewerInline()
    } else if (routeState.deckPanel === 'browser') {
      panels.handleOpenBrowserFromReveal()
      if (browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening') {
        void browserHostRef.current?.bringToFront()
      }
    } else {
      if (state.terminals.length === 0) {
        void terminalPanel.createTerminal()
      } else {
        terminalPanel.expandPanel()
      }
    }
  }, [
    activeAgentId,
    browserWorkspaceMode,
    panels,
    state.streamDeckNavigationRequest,
    routeState,
    state.terminals.length,
    terminalSessionAgentId,
    terminalPanel,
  ])

  useEffect(() => {
    const request = state.browserPanelRevealRequest
    if (!shouldRevealBrowserPanel({
      electronHostAvailable: Boolean(window.electronBridge?.browserAutomation),
      selectedSessionAgentId: browserSessionAgentId,
      request,
      currentHostGeneration: state.browserHost.hostGeneration,
    })) return
    const key = `${request!.hostGeneration}:${request!.sequence}:${request!.tabId}`
    if (handledBrowserRevealRef.current === key) return
    handledBrowserRevealRef.current = key
    panels.handleOpenBrowserFromReveal()
    if (browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening') {
      void browserHostRef.current?.bringToFront()
    }
  }, [browserSessionAgentId, browserWorkspaceMode, state.browserHost.hostGeneration, state.browserPanelRevealRequest, panels])

  // Workers belonging to the active manager session (for pill bar)
  const sessionWorkers = useMemo(() => {
    if (!activeManagerId) return []
    return state.agents.filter(
      (a) => a.role === 'worker' && a.managerId === activeManagerId,
    )
  }, [activeManagerId, state.agents])

  // Track the active manager's workerCount so the effect re-fires when workers spawn/despawn
  const activeManagerWorkerCount = useMemo(() => {
    if (!activeManagerId) return 0
    const manager = state.agents.find(
      (a) => a.role === 'manager' && a.agentId === activeManagerId,
    )
    return manager?.workerCount ?? 0
  }, [activeManagerId, state.agents])

  // Resolve worker-fetch target from actual active agent context only.
  const workerFetchManagerId = useMemo(
    () => resolveWorkerFetchManagerId(activeAgent),
    [activeAgent],
  )
  const workerMetadataHydrated = Boolean(
    workerFetchManagerId && state.workerMetadataSessionIds.has(workerFetchManagerId),
  )

  useEffect(() => {
    if (!selectedEnvironmentId || !workerFetchManagerId || workerMetadataHydrated) return
    hydrateSessionWorkers(selectedEnvironmentId, workerFetchManagerId)
  }, [selectedEnvironmentId, workerFetchManagerId, workerMetadataHydrated, activeManagerWorkerCount])

  // Resolve parent manager label for the worker back-bar
  const parentManagerLabel = useMemo(() => {
    if (activeAgent?.role !== 'worker' || !activeAgent.managerId) return null
    const manager = state.agents.find((a) => a.agentId === activeAgent.managerId)
    if (!manager) return activeAgent.managerId
    if (manager.profileId && manager.sessionLabel) {
      const profile = state.profiles.find((p) => p.profileId === manager.profileId)
      const profileName = profile?.displayName ?? manager.profileId
      return `${profileName} › ${manager.sessionLabel}`
    }
    return manager.displayName ?? manager.agentId
  }, [activeAgent, state.agents, state.profiles])
  const workerSecureStatus = useMemo(() => {
    if (activeAgent?.role !== 'worker' || !secureSessionSnapshotView) return undefined
    const activeGrantCount = secureSessionSnapshotView.leases.filter(
      (lease) => lease.status === 'active',
    ).length
    const active =
      secureSessionSnapshotView.executionMode === 'secure'
      && secureSessionSnapshotView.environmentStatus === 'ready'
    return {
      active,
      label: secureOutputQuarantineUi.outputState === 'quarantined'
        ? 'Protected output redacted'
        : active
          ? `Team Secure Bash · ${activeGrantCount} ${activeGrantCount === 1 ? 'grant' : 'grants'}`
          : `Secure Bash ${secureSessionSnapshotView.environmentStatus}`,
    }
  }, [activeAgent?.role, secureOutputQuarantineUi.outputState, secureSessionSnapshotView])

  // For settings, only show profile-level managers (default sessions or legacy managers without profileId)
  const settingsManagers = useMemo(() => {
    const defaultSessionIds = new Set(state.profiles.map((p) => p.defaultSessionAgentId))
    return state.agents.filter((agent) => {
      if (agent.role !== 'manager') return false
      if (state.profiles.length > 0) {
        return defaultSessionIds.has(agent.agentId) || !agent.profileId
      }
      return true
    })
  }, [state.agents, state.profiles])

  useDynamicFavicon({
    agents: state.agents,
    statuses: state.statuses,
  })

  // ── Transcript / search / feedback / pins / context window / pending response ──
  const transcript = useTranscriptController({
    state,
    activeView,
    activeAgent,
    activeAgentId,
    activeAgentStatus,
    messageSourceView,
    messageListRef,
    settingsClient: selectedSettingsClient,
  })
  const { feedback } = transcript
  const isLoading = transcript.isLoading
  const conversationActionsEnabled = transcript.isConversationInteractive

  const missingPendingChoiceIds = useMemo(
    () => deriveMissingPendingChoiceIds(state.pendingChoiceIds, state.messages, activeAgentId),
    [activeAgentId, state.messages, state.pendingChoiceIds],
  )
  const hasActivePendingChoice = state.pendingChoiceIds.size > 0
  const canStopAllAgents =
    isActiveManager &&
    (activeAgentStatus === 'idle' || activeAgentStatus === 'streaming')

  const autoCompactionInProgress = useMemo(() => {
    if (!activeAgentId) return false
    return state.statuses[activeAgentId]?.contextRecoveryInProgress === true
  }, [activeAgentId, state.statuses])

  const hasCreatedProjectManager = useMemo(() => state.agents.some((agent) => agent.role === 'manager'), [state.agents])
  // Sidebar actions act on the primary environment's own sessions.
  const localActiveAgentId = isPrimarySelected ? activeAgentId : null
  const localActiveAgent = localActiveAgentId
    ? primaryState.agents.find((agent) => agent.agentId === localActiveAgentId) ?? null
    : null
  const localIsActiveManager = Boolean(localActiveAgent && localActiveAgent.role === 'manager')

  const shouldShowWelcomeForm =
    routeState.view === 'chat' &&
    !hasCreatedProjectManager &&
    onboardingState?.status === 'pending'
  const shouldShowCreateManagerState =
    routeState.view === 'chat' &&
    !hasCreatedProjectManager &&
    Boolean(onboardingState && onboardingState.status !== 'pending')

  const { slashCommands } = useSlashCommands({ wsUrl, activeView })
  const builderSlashCommands = useMemo(() => [SIDE_SLASH_COMMAND, ...slashCommands], [slashCommands])

  // Project creation and sidebar project actions address the primary environment.
  const localSidebarManager = useManagerActions({
    wsUrl,
    environmentClient: primary.client.getEnvironmentClient() ?? null,
    clientRef: primary.clientRef,
    agents: primaryState.agents,
    activeAgent: localActiveAgent,
    activeAgentId: localActiveAgentId,
    isActiveManager: localIsActiveManager,
    navigateToRoute,
    setState: primary.setState,
    clearPendingResponseForAgent: transcript.clearPendingResponseForAgent,
  })
  const {
    isCreateManagerDialogOpen,
    newManagerName,
    newManagerCwd,
    newManagerModelSelection,
    newManagerReasoningLevel,
    newManagerSecureSessionsEnabled,
    handleNewManagerSecureSessionsEnabledChange,
    scaffoldForgeResources,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerModelSelectionChange,
    handleNewManagerReasoningLevelChange,
    handleScaffoldForgeResourcesChange,
    handleOpenCreateManagerDialog,
    projectEnvironmentId,
    handleProjectEnvironmentChange,
    getProjectTargetClient,
    handleCreateManagerDialogOpenChange,
    handleBrowseDirectory,
    handleCreateManager,
    createProjectSourceMode,
    repositoryUrl,
    repositoryFolder,
    repositoryBasePath,
    cloneStage,
    clonePercent,
    cloneCancellable,
    handleCreateProjectSourceModeChange,
    handleRepositoryUrlChange,
    handleRepositoryFolderChange,
    handleRepositoryBasePathChange,
    handleBrowseRepositoryBasePath,
    handleCancelClone,
    isCancellingClone,
  } = localSidebarManager
  const {
    isCompactingManager,
    handleCompactManager,
    isSmartCompactingManager,
    handleSmartCompactManager,
    isStoppingAllAgents,
    handleStopAllAgents,
  } = useManagerActions({
    wsUrl,
    environmentClient,
    clientRef,
    agents: state.agents,
    activeAgent,
    activeAgentId,
    isActiveManager,
    navigateToRoute,
    setState,
    clearPendingResponseForAgent: transcript.clearPendingResponseForAgent,
  })


  const sideChat = useSideChat({
    clientRef,
    agents: state.agents,
    activeAgentId: isActiveManager ? activeAgentId : null,
    setState,
  })

  // ── Session / sidebar action handlers ──
  const session = useSessionActions({
    clientRef,
    fileEditorCoordinator: panels.fileEditorCoordinator,
    state,
    activeAgent,
    activeAgentId,
    isActiveManager,
    isLoading,
    navigateToRoute,
    setState,
    visibleMessages: transcript.visibleMessages,
    markPendingResponse: transcript.markPendingResponse,
    handleCompactManager,
    startSideChat: sideChat.startSideChat,
    messageInputRef,
    messageListRef,
  })

  const applySecureMutationResult = useCallback((
    client: ManagerWsClient,
    snapshot: SecureSessionSnapshot,
  ) => {
    const clientState = client.getState()
    const targetAgentId = clientState.targetAgentId
    const targetAgent = clientState.agents.find(
      (agent) => agent.agentId === targetAgentId,
    )
    const targetAuthorityAgentId = targetAgent?.role === 'worker'
      ? targetAgent.managerId
      : targetAgentId
    const ownerManagerAgentId =
      snapshot.ownerManagerAgentId ?? snapshot.sessionAgentId
    if (
      clientRef.current !== client
      || (
        targetAgentId !== snapshot.sessionAgentId
        && targetAuthorityAgentId !== ownerManagerAgentId
      )
    ) return
    client.applySecureSessionSnapshot(snapshot)
    setState((current) => current.lastError
      ? { ...current, lastError: null }
      : current)
  }, [clientRef, setState])

  const reportSecureMutationError = useCallback((
    client: ManagerWsClient,
    sessionAgentId: string,
    error: unknown,
  ) => {
    const clientState = client.getState()
    const targetDescriptor = clientState.agents.find(
      (agent) => agent.agentId === sessionAgentId,
    )
    const ownerManagerAgentId = targetDescriptor?.role === 'worker'
      ? targetDescriptor.managerId
      : sessionAgentId
    if (
      clientRef.current !== client
      || (
        clientState.targetAgentId !== sessionAgentId
        && clientState.targetAgentId !== ownerManagerAgentId
      )
    ) return
    const message = secureSessionUiErrorMessage(error)
    setState((current) => ({ ...current, lastError: message }))
  }, [clientRef, setState])

  const handleStartSecureSession = useCallback(async () => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    if (!apiClient || !client || !activeAgentId) return false
    const transitioningWorkerCount = activeManagerAgent?.activeWorkerCount ?? 0
    try {
      if (!(await ensureBitwardenUnlocked())) return false
      const localVaultReady = await unlockLocalProjectDefaultsIfNeeded(
        secureCatalog,
        secureSessionSnapshot?.profileId ?? activeAgent?.profileId,
        secureBrowserControl?.authorized === true
          && secureBrowserControl.privateEntryAvailable === true,
      )
      if (!localVaultReady) {
        throw new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE')
      }
      const snapshot = await startSecureSession(
        apiClient,
        activeAgentId,
        secureSessionSnapshot?.revision,
      )
      applySecureMutationResult(client, snapshot)
      if (transitioningWorkerCount > 0) {
        const workerLabel = transitioningWorkerCount === 1 ? 'worker' : 'workers'
        const possessive = transitioningWorkerCount === 1 ? 'its' : 'their'
        setState((current) => ({
          ...current,
          lastSuccess: `Secure Mode started. ${transitioningWorkerCount} active ${workerLabel} will switch before ${possessive} next assignment.`,
        }))
      }
      return toSecureSessionSnapshotView(snapshot)
    } catch (error) {
      reportSecureMutationError(client, activeAgentId, error)
      return false
    }
  }, [
    activeAgent?.profileId,
    activeAgentId,
    activeManagerAgent?.activeWorkerCount,
    applySecureMutationResult,
    clientRef,
    ensureBitwardenUnlocked,
    httpClientRef,
    reportSecureMutationError,
    secureBrowserControl,
    secureCatalog,
    secureSessionSnapshot?.profileId,
    secureSessionSnapshot?.revision,
    setState,
  ])

  const handleApplySecureProjectDefaults = useCallback(async (
    managerAgentId: string,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const managerSnapshot =
      client?.getState().secureSessionSnapshots[managerAgentId] ?? null
    if (
      !apiClient
      || !client
      || !managerSnapshot
      || managerSnapshot.principalKind !== 'manager'
    ) return false

    try {
      const localVaultReady = await unlockLocalProjectDefaultsIfNeeded(
        secureCatalog,
        managerSnapshot.profileId,
        secureBrowserControl?.authorized === true
          && secureBrowserControl.privateEntryAvailable === true,
      )
      if (!localVaultReady) {
        throw new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE')
      }
      applySecureMutationResult(client, await applySecureSessionProjectDefaults(
        apiClient,
        managerAgentId,
        managerSnapshot.revision,
      ))
      return true
    } catch (error) {
      if (shouldRefreshAfterProjectDefaultsApplyError(error)) {
        try {
          const refreshed = await fetchSecureSessionSnapshot(
            apiClient,
            managerAgentId,
          )
          applySecureMutationResult(client, refreshed)
          return false
        } catch {
          // Report the original fixed failure when exact reconciliation is unavailable.
        }
      }
      reportSecureMutationError(client, managerAgentId, error)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    reportSecureMutationError,
    secureBrowserControl,
    secureCatalog,
  ])

  const handleReviewProjectSecrets = useCallback(() => {
    const profileId = secureSessionSnapshot?.profileId
    if (!isActiveManager || !profileId) return
    panels.fileEditorCoordinator.requestFileEditorTransition(
      { type: 'navigate-route', nextView: 'settings' },
      () => {
        navigateToRoute({
          view: 'settings',
          settingsTab: 'secrets',
          settingsProfileId: profileId,
        })
      },
    )
  }, [
    isActiveManager,
    navigateToRoute,
    panels.fileEditorCoordinator,
    secureSessionSnapshot?.profileId,
  ])

  const handleGrantSecureSession = useCallback(async (
    sessionAgentId: string,
    grant: SecureGrantInput,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
    ) return false
    try {
      let baseRevision = principalSnapshot.revision
      let nextSnapshot
      try {
        nextSnapshot = await grantSecureSessionLease(
          apiClient,
          sessionAgentId,
          baseRevision,
          grant,
        )
      } catch (error) {
        if (
          !grant.requestId
          || !shouldRefreshSecureRequestAfterError(error)
        ) throw error
        let refreshed
        try {
          refreshed = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, refreshed)
        if (!refreshed.pendingRequests.some(
          (request) => request.requestId === grant.requestId,
        )) {
          return secureGrantMatchesSnapshot(grant, refreshed)
        }
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        baseRevision = refreshed.revision
        nextSnapshot = await grantSecureSessionLease(
          apiClient,
          sessionAgentId,
          baseRevision,
          grant,
        )
      }
      applySecureMutationResult(client, nextSnapshot)
      return true
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    reportSecureMutationError,
  ])

  const handleGrantSecureSessions = useCallback(async (
    sessionAgentId: string,
    grants: SecureGrantInput[],
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || grants.length === 0
    ) return false

    try {
      const nextSnapshot = await grantSecureSessionLeases(
        apiClient,
        sessionAgentId,
        principalSnapshot.revision,
        grants,
      )
      applySecureMutationResult(client, nextSnapshot)
      return true
    } catch (error) {
      let reportedError = error
      const reconciliation = await reconcileSecureBatchGrantFailure(
        error,
        grants,
        () => fetchSecureSessionSnapshot(apiClient, sessionAgentId),
      )
      if (reconciliation) {
        applySecureMutationResult(client, reconciliation.snapshot)
        if (reconciliation.confirmed) return true
        reportedError = new SecureSessionUiError('SECURE_STALE_REVISION')
      }
      reportSecureMutationError(client, sessionAgentId, reportedError)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    reportSecureMutationError,
  ])

  const handleRevokeSecureSession = useCallback(async (
    sessionAgentId: string,
    leaseId?: string,
    options?: { stopProcesses?: boolean },
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
    ) return
    try {
      const nextSnapshot = options?.stopProcesses
        ? await stopSecureSession(apiClient, sessionAgentId, principalSnapshot.revision)
        : leaseId
          ? await revokeSecureSessionLease(
              apiClient,
              sessionAgentId,
              leaseId,
              principalSnapshot.revision,
            )
          : null
      if (nextSnapshot) applySecureMutationResult(client, nextSnapshot)
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    reportSecureMutationError,
  ])

  const handleDenySecureRequest = useCallback(async (
    sessionAgentId: string,
    requestId: string,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
    ) return
    try {
      let nextSnapshot
      try {
        nextSnapshot = await denySecureAccessRequest(
          apiClient,
          sessionAgentId,
          requestId,
          principalSnapshot.revision,
        )
      } catch (error) {
        if (!shouldRefreshSecureRequestAfterError(error)) throw error
        let refreshed
        try {
          refreshed = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, refreshed)
        if (!refreshed.pendingRequests.some(
          (request) => request.requestId === requestId,
        )) return
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        nextSnapshot = await denySecureAccessRequest(
          apiClient,
          sessionAgentId,
          requestId,
          refreshed.revision,
        )
      }
      applySecureMutationResult(client, nextSnapshot)
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    reportSecureMutationError,
  ])

  const handleResolveSecureSshTrustRequest = useCallback(async (
    sessionAgentId: string,
    requestId: string,
    decision: 'approve' | 'dismiss',
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
    ) return false

    try {
      let currentSnapshot = principalSnapshot
      let nextSnapshot
      try {
        nextSnapshot = decision === 'approve'
          ? await approveSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
          : await dismissSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
      } catch (error) {
        if (!shouldRefreshSecureRequestAfterError(error)) throw error
        try {
          currentSnapshot = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, currentSnapshot)
        if (!(currentSnapshot.pendingSshTrustRequests ?? []).some(
          (request) => request.requestId === requestId,
        )) return true
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        nextSnapshot = decision === 'approve'
          ? await approveSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
          : await dismissSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
      }
      applySecureMutationResult(client, nextSnapshot)
      return true
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    reportSecureMutationError,
  ])

  const handleTrustSecureSshHost = useCallback((
    sessionAgentId: string,
    requestId: string,
  ) => handleResolveSecureSshTrustRequest(sessionAgentId, requestId, 'approve'), [
    handleResolveSecureSshTrustRequest,
  ])

  const handleDismissSecureSshTrustRequest = useCallback((
    sessionAgentId: string,
    requestId: string,
  ) => handleResolveSecureSshTrustRequest(sessionAgentId, requestId, 'dismiss'), [
    handleResolveSecureSshTrustRequest,
  ])

  const handlePrivateSecureFulfillment = useCallback(async (
    sessionAgentId: string,
    requestId: string,
    input: SecurePrivateFulfillmentInput,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    const request = principalSnapshot?.pendingRequests.find(
      (candidate) => candidate.requestId === requestId,
    )
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || !request
    ) {
      throw new SecureSessionUiError('SECURE_REQUEST_INVALID')
    }
    try {
      let nextSnapshot
      try {
        nextSnapshot = await fulfillSecureAccessRequestPrivately(
          apiClient,
          sessionAgentId,
          request,
          principalSnapshot.revision,
          input,
        )
      } catch (error) {
        if (!shouldRefreshSecureRequestAfterError(error)) throw error
        let refreshed
        try {
          refreshed = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, refreshed)
        const refreshedRequest = refreshed.pendingRequests.find(
          (candidate) =>
            candidate.requestId === requestId
            && candidate.secretId === null,
        )
        if (!refreshedRequest) {
          return
        }
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        nextSnapshot = await fulfillSecureAccessRequestPrivately(
          apiClient,
          sessionAgentId,
          refreshedRequest,
          refreshed.revision,
          input,
        )
      }
      applySecureMutationResult(client, nextSnapshot)
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
      throw error
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    reportSecureMutationError,
  ])

  const handleLoadSecurePrivateDestinations = useCallback(async () => {
    const apiClient = httpClientRef.current
    if (!apiClient) return []
    const providers = (secureCatalog?.providers ?? []).filter(
      (provider) => provider.kind === 'bitwarden_password_manager'
        && provider.enabled
        && provider.status === 'available',
    )
    const settings = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        settings: await fetchBitwardenPasswordManagerSettings(
          apiClient,
          provider.providerId,
        ),
      })),
    )
    return settings.flatMap(({ provider, settings: providerSettings }) =>
      providerSettings.collections
        .filter((collection) => collection.selected)
        .map((collection) => ({
          destination: {
            kind: 'bitwarden_password_manager' as const,
            providerId: provider.providerId,
            collectionId: collection.collectionId,
          },
          label: `${provider.displayName} — ${collection.name}`,
          description: `Creates a Bitwarden login in ${collection.name}.`,
        })),
    )
  }, [httpClientRef, secureCatalog?.providers])

  const handleCreateSecureBrowserPairing = useCallback(async () => {
    const apiClient = httpClientRef.current
    if (!apiClient) {
      throw new SecureSessionUiError('SECURE_PRIVATE_API_UNAVAILABLE')
    }
    return await createSecureBrowserPairingRequest(apiClient)
  }, [httpClientRef])

  const handleClaimSecureBrowserPairing = useCallback(async (
    requestId: string,
    claimSecret: string,
  ) => {
    const apiClient = httpClientRef.current
    if (!apiClient) {
      throw new SecureSessionUiError('SECURE_PRIVATE_API_UNAVAILABLE')
    }
    return await claimSecureBrowserPairing(apiClient, requestId, claimSecret)
  }, [httpClientRef])

  const handleSecureBrowserPaired = useCallback(async () => {
    await refreshSecureBrowserControl()
  }, [refreshSecureBrowserControl])

  const handleSetSecureAccess = useCallback(async (
    subject: import('@forge/protocol').SecureSessionAccessSubject,
    blocked: boolean,
  ): Promise<boolean> => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    if (!apiClient || !client || !secureAuthorityAgentId) return false
    const current = client.getState().secureSessionSnapshots[secureAuthorityAgentId]
    if (!current?.accessPolicy) return false
    try {
      const snapshot = await setSecureSessionAccess(apiClient, secureAuthorityAgentId, {
        baseRevision: current.revision, subject, blocked,
      })
      applySecureMutationResult(client, snapshot)
      return true
    } catch (error) {
      try { applySecureMutationResult(client, await fetchSecureSessionSnapshot(apiClient, secureAuthorityAgentId)) } catch { /* Preserve the original fixed error. */ }
      reportSecureMutationError(client, secureAuthorityAgentId, error)
      return false
    }
  }, [httpClientRef, clientRef, secureAuthorityAgentId, applySecureMutationResult, reportSecureMutationError])

  const handleRecoverSecureAccess = useCallback(async (): Promise<boolean> => {
    try {
      if (!(await ensureBitwardenUnlocked())) return false
      return await unlockLocalProjectDefaultsIfNeeded(secureCatalog,
        secureSessionSnapshot?.profileId ?? activeAgent?.profileId,
        secureBrowserControl?.authorized === true && secureBrowserControl.privateEntryAvailable === true)
    } catch (error) {
      const client = clientRef.current
      if (client && secureAuthorityAgentId) reportSecureMutationError(client, secureAuthorityAgentId, error)
      return false
    }
  }, [ensureBitwardenUnlocked, secureCatalog, secureSessionSnapshot?.profileId, activeAgent?.profileId,
    secureBrowserControl, clientRef, secureAuthorityAgentId, reportSecureMutationError])

  const secureSessionPicker = useMemo<SecureSessionPickerConfig | undefined>(() => {
    if (!activeAgentId || activeAgentProfile?.secureSessionsEnabled === false) return undefined
    const config: SecureSessionPickerConfig = {
      originId: selectedEnvironmentId ?? '',
      availability: secureSessionAvailability,
      snapshot: secureSessionSnapshotView,
      ...(!isActiveManager ? { readOnly: true } : {}),
      accessAgentId: activeAgentId,
      lockedBitwardenProviderName: lockedBitwardenProvider?.displayName,
      ...(isSecureControlAvailable(secureBrowserControl?.authorized === true)
        ? { onSetAccess: handleSetSecureAccess,
            ...(isPrivateSecureFulfillmentAvailable(secureBrowserControl?.privateEntryAvailable === true)
              ? { onRecoverAccess: handleRecoverSecureAccess } : {}) } : {}),
      secrets: secureSecretOptions,
      ...(!secureSessionSnapshotView
        ? {}
        : secureOutputQuarantineConfigFields(secureOutputQuarantineUi)),
      disabled:
        !state.connected
        || ((
          secureCatalogLoading
          || state.secureSessionSnapshotLoadingSessionId === activeAgentId
        )),
      ...(!isActiveManager
        ? {}
        : {
            onStart: handleStartSecureSession,
            onGrant: handleGrantSecureSessions,
            onApplyProjectDefaults: handleApplySecureProjectDefaults,
            onReviewProjectSecrets: handleReviewProjectSecrets,
            onRevoke: handleRevokeSecureSession,
          }),
    }
    return shouldShowSecureSessionPicker(config) ? config : undefined
  }, [
    selectedEnvironmentId,
    activeAgentProfile?.secureSessionsEnabled,
    activeAgentId,
    lockedBitwardenProvider,
    secureBrowserControl,
    handleSetSecureAccess,
    handleRecoverSecureAccess,
    handleGrantSecureSessions,
    handleApplySecureProjectDefaults,
    handleRevokeSecureSession,
    handleReviewProjectSecrets,
    handleStartSecureSession,
    isActiveManager,
    secureCatalogLoading,
    secureOutputQuarantineUi,
    secureSecretOptions,
    secureSessionAvailability,
    secureSessionSnapshotView,
    state.connected,
    state.secureSessionSnapshotLoadingSessionId,
  ])

  const secureSessionRequests = useMemo<SecureSessionRequestConfig | undefined>(() => {
    if (!activeAgentId) return undefined
    return {
      originId: selectedEnvironmentId ?? '',
      ...(secureSessionSnapshotView
        ? { sessionAgentId: secureSessionSnapshotView.sessionAgentId }
        : {}),
      availability: secureSessionAvailability,
      requests: securePendingRequestViews,
      sshTrustRequests: securePendingSshTrustRequestViews,
      secrets: secureSecretOptions,
      ...(secureSessionSnapshot
        ? {
            project: {
              profileId: secureSessionSnapshot.profileId,
              displayName:
                state.profiles.find(
                  (profile) => profile.profileId === secureSessionSnapshot.profileId,
                )?.displayName ?? secureSessionSnapshot.profileId,
              projectDefaultLimitReached:
                (secureCatalog?.projectDefaults?.filter(
                  (projectDefault) =>
                    projectDefault.profileId === secureSessionSnapshot.profileId,
                ).length ?? 0) >= resolveMaxProjectDefaults(secureCatalog),
              maxProjectDefaults: resolveMaxProjectDefaults(secureCatalog),
            },
          }
        : {}),
      ...(!secureSessionSnapshotView
        ? {}
        : {
            ...secureOutputQuarantineConfigFields(secureOutputQuarantineUi),
            onDismissOutputQuarantine: handleDismissSecureOutputQuarantine,
          }),
      disabled: !state.connected || secureCatalogLoading,
      canApprove:
        true
        && isSecureControlAvailable(secureBrowserControl?.authorized === true),
      onGrant: handleGrantSecureSession,
      onDeny: handleDenySecureRequest,
      onTrustSshHost: handleTrustSecureSshHost,
      onDismissSshTrustRequest: handleDismissSecureSshTrustRequest,
      ...(isActiveManager ? { onRevoke: handleRevokeSecureSession } : {}),
      ...(isPrivateSecureFulfillmentAvailable(
        secureBrowserControl?.privateEntryAvailable === true,
      )
        ? { onPrivateFulfill: handlePrivateSecureFulfillment }
        : {}),
      loadPrivateDestinations: handleLoadSecurePrivateDestinations,
      ...(
        !isSecureControlAvailable(secureBrowserControl?.authorized === true)
        && secureBrowserControl?.available === true
        && secureBrowserControl.secureContextRequired === false
          ? {
              onCreateBrowserPairing: handleCreateSecureBrowserPairing,
              onClaimBrowserPairing: handleClaimSecureBrowserPairing,
              onBrowserPaired: handleSecureBrowserPaired,
            }
          : {}
      ),
    }
  }, [
    selectedEnvironmentId,
    activeAgentId,
    handleDenySecureRequest,
    handleDismissSecureSshTrustRequest,
    handleGrantSecureSession,
    handleLoadSecurePrivateDestinations,
    handleTrustSecureSshHost,
    handlePrivateSecureFulfillment,
    handleCreateSecureBrowserPairing,
    handleClaimSecureBrowserPairing,
    handleSecureBrowserPaired,
    handleDismissSecureOutputQuarantine,
    handleRevokeSecureSession,
    isActiveManager,
    secureCatalogLoading,
    secureCatalog,
    secureOutputQuarantineUi,
    secureSecretOptions,
    securePendingRequestViews,
    securePendingSshTrustRequestViews,
    secureSessionAvailability,
    secureSessionSnapshot,
    secureSessionSnapshotView,
    secureBrowserControl,
    state.profiles,
    state.connected,
  ])

  const sessionModelPicker =
    isActiveManager && isSessionModelPickerEligible(activeAgent, activeAgentProfile)
      ? {
          originId: selectedEnvironmentId ?? '',
          httpClientRef,
          sessionAgentId: activeAgent.agentId,
          sessionLabel: activeAgent.sessionLabel || activeAgent.displayName || activeAgent.agentId,
          currentModel: activeAgent.model,
          modelOrigin: activeAgent.modelOrigin,
          profileDefaultModel: activeAgentProfile?.defaultModel,
          disabled: !state.connected,
          modelConfigChangeKey: state.modelConfigChangeKey,
          connectionEpoch: state.connectionEpoch,
          onUpdate: session.handleUpdateSessionModel,
        }
      : undefined

  const sessionContextModePicker =
    isActiveManager
    && true
    && isSessionModelPickerEligible(activeAgent, activeAgentProfile)
      ? {
          originId: selectedEnvironmentId ?? '',
          httpClientRef,
          sessionAgentId: activeAgent.agentId,
          disabled: !state.connected,
          connectionEpoch: state.connectionEpoch,
        }
      : undefined

  const sessionCoordinationPicker =
    isActiveManager
    && activeAgent
    && activeAgentProfile
    && isSessionModelPickerEligible(activeAgent, activeAgentProfile)
      ? {
          originId: selectedEnvironmentId ?? '',
          httpClientRef,
          sessionAgentId: activeAgent.agentId,
          profileId: activeAgentProfile.profileId,
          managerPosture: activeAgent.managerPosture,
          managerPostureOrigin: activeAgent.managerPostureOrigin,
          projectDefaultManagerPosture: activeAgentProfile.defaultManagerPosture,
          delegationRosterId: activeAgent.delegationRosterId,
          delegationRosterOrigin: activeAgent.delegationRosterOrigin,
          projectDefaultDelegationRosterId: activeAgentProfile.defaultDelegationRosterId,
          disabled: !state.connected,
          modelConfigChangeKey: state.modelConfigChangeKey,
          connectionEpoch: state.connectionEpoch,
          onUpdateProjectDefaults: session.handleUpdateProjectDelegationDefaults,
          onUpdateSession: session.handleUpdateSessionDelegation,
        }
      : undefined

  const localSidebarSession = useSessionActions({
    clientRef: primary.clientRef,
    fileEditorCoordinator: panels.fileEditorCoordinator,
    state: primaryState,
    activeAgent: localActiveAgent,
    activeAgentId: localActiveAgentId,
    isActiveManager: localIsActiveManager,
    isLoading,
    navigateToRoute,
    setState: primary.setState,
    visibleMessages: transcript.visibleMessages,
    markPendingResponse: transcript.markPendingResponse,
    handleCompactManager: async () => {},
    startSideChat: () => {},
    messageInputRef,
    messageListRef,
  })
  const { replyTarget, setReplyTarget, messageForkTarget, setMessageForkTarget } = session
  const sideChatPanelProps = {
    environmentId: selectedEnvironmentId ?? '',
    sideChatAgentId: sideChat.sideChatAgentId,
    sourceLabel: activeAgentLabel,
    isExpanded: sideChat.isExpanded,
    initialMessage: sideChat.initialMessage,
    onInitialMessageSent: sideChat.clearInitialMessage,
    onExpand: sideChat.expandSideChat,
    onCollapse: sideChat.collapseSideChat,
    onDiscard: sideChat.discardSideChat,
  }

  const {
    isDraggingFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useFileDrop({
    activeView,
    messageInputRef,
    acceptSessionReferences: isActiveManager,
  })

  useEffect(() => {
    if (!state.lastSuccess) return
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, lastSuccess: null }))
    }, 4000)
    return () => clearTimeout(timer)
  }, [state.lastSuccess, setState])

  const handleSaveOnboarding = useCallback((input: import('@/lib/onboarding-api').SaveOnboardingPreferencesInput) => {
    void (async () => {
      const nextState = await saveOnboardingPreferences(input)
      if (!nextState) {
        return
      }
      navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true)
    })()
  }, [navigateToRoute, saveOnboardingPreferences])

  const handleSkipOnboarding = useCallback(() => {
    void (async () => {
      const nextState = await skipOnboarding()
      if (!nextState) {
        return
      }
      navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true)
    })()
  }, [navigateToRoute, skipOnboarding])

  const previewSession = useMemo(() => {
    if (!activeAgentId) return null
    const activeDescriptor = state.agents.find((agent) => agent.agentId === activeAgentId)
    if (!activeDescriptor) return null

    const sessionAgentId = activeDescriptor.role === 'manager' ? activeDescriptor.agentId : activeDescriptor.managerId
    const sessionDescriptor = state.agents.find((agent) => agent.agentId === sessionAgentId && agent.role === 'manager')
    if (!sessionDescriptor?.profileId) return null

    return {
      agentId: sessionDescriptor.agentId,
      profileId: sessionDescriptor.profileId,
    }
  }, [activeAgentId, state.agents])

  const handleOpenProjectSettings = useCallback((profileId: string) => {
    panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'settings' }, () => {
      navigateToRoute({
        view: 'settings',
        settingsTab: 'project-settings',
        settingsProfileId: profileId,
      })
    })
  }, [navigateToRoute, panels.fileEditorCoordinator])

  const handleOpenProjectSecrets = useCallback((profileId: string) => {
    panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'settings' }, () => {
      navigateToRoute({
        view: 'settings',
        settingsTab: 'secrets',
        settingsProfileId: profileId,
      })
    })
  }, [navigateToRoute, panels.fileEditorCoordinator])

  const projectSettingsActions = useMemo<ProjectSettingsActions>(() => ({
    onRenameProfile: localSidebarSession.handleRenameProfile,
    onUpdateManagerModel: localSidebarSession.handleUpdateManagerModel,
    onUpdateManagerCwd: localSidebarSession.handleUpdateManagerCwd,
    onBrowseDirectory: localSidebarSession.handleBrowseDirectoryForCwd,
    onValidateDirectory: localSidebarSession.handleValidateDirectoryForCwd,
    onOpenProjectSecrets: handleOpenProjectSecrets,
  }), [
    handleOpenProjectSecrets,
    localSidebarSession.handleBrowseDirectoryForCwd,
    localSidebarSession.handleRenameProfile,
    localSidebarSession.handleUpdateManagerCwd,
    localSidebarSession.handleUpdateManagerModel,
    localSidebarSession.handleValidateDirectoryForCwd,
  ])

  const showActivityRail = activeView === 'chat'

  const handleSelectSidebarAgent = useCallback((agentId: string) => {
    panels.handleSelectAgent(agentId, primaryEnvironmentId ?? undefined)
  }, [panels, primaryEnvironmentId])

  const openSettingsView = useCallback(() => {
    panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'settings' }, () => {
      navigateToRoute({ view: 'settings' })
    })
  }, [navigateToRoute, panels.fileEditorCoordinator])

  const openStatsView = useCallback(() => {
    panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'stats' }, () => {
      navigateToRoute({ view: 'stats' })
    })
  }, [navigateToRoute, panels.fileEditorCoordinator])

  const openArchiveView = useCallback(() => {
    panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'archive' }, () => {
      navigateToRoute({ view: 'archive' })
    })
  }, [navigateToRoute, panels.fileEditorCoordinator])

  // ⌘K command palette: one keyboard entry point for jumping between sessions
  // and running workspace commands without hunting through the chrome.
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setIsCommandPaletteOpen((open) => !open)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const commandPaletteSessions = useMemo<CommandPaletteSession[]>(() => {
    if (!isCommandPaletteOpen) return []
    const projectNames = new Map(state.profiles.map((profile) => [profile.profileId, profile.displayName]))
    return state.agents
      .filter((agent) =>
        agent.role === 'manager' &&
        !agent.archivedAt &&
        agent.sessionPurpose !== 'side_chat',
      )
      .map((agent) => ({
        id: agent.agentId,
        title: agent.sessionLabel || agent.displayName || agent.agentId,
        projectName: projectNames.get(agent.profileId ?? '') ?? agent.profileId ?? '',
        status: (agent.pendingChoiceCount ?? 0) > 0
          ? 'attention'
          : agent.status === 'error'
            ? 'error'
            : agent.status === 'streaming' || (agent.activeWorkerCount ?? 0) > 0
              ? 'live'
              : 'idle',
        updatedAt: agent.lastUserMessageAt ?? agent.updatedAt,
      }))
  }, [isCommandPaletteOpen, state.agents, state.profiles])

  const commandPaletteCommands = useMemo<CommandPaletteCommand[]>(() => {
    const commands: CommandPaletteCommand[] = []
    if (activeAgentProfileId) {
      commands.push({
        id: 'new-session',
        label: 'New session in this project',
        icon: MessageSquarePlus,
        run: () => localSidebarSession.handleCreateSession(activeAgentProfileId),
      })
    }
    commands.push({ id: 'new-project', label: 'New project…', icon: FolderPlus, run: handleOpenCreateManagerDialog })
    for (const item of panels.activityRailItems ?? []) {
      if (item.id === 'chat') continue
      commands.push({
        id: `rail-${item.id}`,
        label: item.label,
        icon: item.icon,
        shortcut: item.shortcutLabel,
        disabled: item.disabled,
        run: item.onClick,
      })
    }
    commands.push(
      {
        id: 'toggle-theme',
        label: 'Toggle light / dark theme',
        icon: SunMoon,
        run: () => {
          const nextMode = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
          const stored = readStoredAppearanceConfig()
          // Keep an applied custom palette; only flip its mode.
          if (stored.customApplied) applyAppearanceConfig({ ...stored, mode: nextMode })
          else applyThemePreference(nextMode)
        },
      },
      { id: 'settings', label: 'Open settings', icon: Settings2, run: openSettingsView },
      { id: 'stats', label: 'Open stats', icon: BarChart3, run: openStatsView },
      { id: 'archive', label: 'Open archive', icon: Archive, run: openArchiveView },
    )
    return commands
  }, [activeAgentProfileId, handleOpenCreateManagerDialog, localSidebarSession, openArchiveView, openSettingsView, openStatsView, panels.activityRailItems])

  const feedbackProfileId = transcript.feedbackProfileId

  return (
    <WorkGraphWorkerHighlightProvider>
      <FileDirtyConfirmDialog state={panels.fileEditorCoordinator.dialogState} />
      <BrowserAutomationHost
        ref={browserHostRef}
        client={localClient}
        state={state}
        selectedSessionAgentId={browserSessionAgentId}
        selectedProfileId={browserProfileId}
        panelVisible={activeView === 'chat' && panels.isBrowserOpen}
        onRuntimeTabStateChanged={handleBrowserRuntimeTabStateChanged}
        onWorkspaceModeChange={(mode) => {
          setBrowserWorkspaceMode(mode)
          if (mode === 'docked') window.requestAnimationFrame(() => {
            const control = document.querySelector('button[aria-label="Open Managed Browser in a separate window"]')
            if (control instanceof HTMLElement) control.focus()
          })
        }}
      />

      <AgentSidebarConnected
        wsUrl={wsUrl}
        modelConfigChangeKey={state.modelConfigChangeKey}
        connectionEpoch={state.connectionEpoch}
        builderSidebarOrderApi={builderSidebarOrderApi}
        activityRailItems={showActivityRail ? panels.activityRailItems : undefined}
        selectedAgentId={isPrimarySelected && launchGroupKey === null ? activeAgentId : null}
        environmentNavigation={environmentNavigation}
        isSettingsActive={activeView === 'settings'}
        isStatsActive={activeView === 'stats'}
        isArchiveActive={activeView === 'archive'}
        isMobileOpen={panels.isMobileSidebarOpen}
        onMobileClose={() => panels.setIsMobileSidebarOpen(false)}
        onAddManager={handleOpenCreateManagerDialog}
        onSelectAgent={handleSelectSidebarAgent}
        onDeleteAgent={localSidebarSession.handleDeleteAgent}
        onDeleteManager={localSidebarManager.handleRequestDeleteManager}
        onOpenSettings={openSettingsView}
        onOpenProjectSettings={handleOpenProjectSettings}
        onOpenProjectSecrets={handleOpenProjectSecrets}
        onOpenStats={openStatsView}
        onOpenArchive={openArchiveView}
        onCreateSession={localSidebarSession.handleCreateSession}
        onStopSession={localSidebarSession.handleStopSession}
        onResumeSession={localSidebarSession.handleResumeSession}
        onDeleteSession={localSidebarSession.handleDeleteSession}
        onArchiveSession={localSidebarSession.handleArchiveSession}
        onArchiveProfile={localSidebarSession.handleArchiveProfile}
        onRenameSession={localSidebarSession.handleRenameSession}
        onPinSession={localSidebarSession.handlePinSession}
        onRenameProfile={localSidebarSession.handleRenameProfile}
        onForkSession={localSidebarSession.handleForkSession}
        onMarkUnread={localSidebarSession.handleMarkUnread}
        onMarkAllRead={localSidebarSession.handleMarkAllRead}
        onUpdateManagerModel={localSidebarSession.handleUpdateManagerModel}
        onUpdateSessionModel={localSidebarSession.handleUpdateSessionModel}
        onUpdateManagerCwd={localSidebarSession.handleUpdateManagerCwd}
        onBrowseDirectory={localSidebarSession.handleBrowseDirectoryForCwd}
        onValidateDirectory={localSidebarSession.handleValidateDirectoryForCwd}
        onRequestSessionWorkers={localSidebarSession.handleRequestSessionWorkers}
        onSetSessionProjectAgent={localSidebarSession.handleSetSessionProjectAgent}
        onGetProjectAgentConfig={localSidebarSession.handleGetProjectAgentConfig}
        onGetProjectAgentSharing={localSidebarSession.handleGetProjectAgentSharing}
        onSetProjectAgentSharing={localSidebarSession.handleSetProjectAgentSharing}
        onListProjectAgentReferences={localSidebarSession.handleListProjectAgentReferences}
        onGetProjectAgentReference={localSidebarSession.handleGetProjectAgentReference}
        onSetProjectAgentReference={localSidebarSession.handleSetProjectAgentReference}
        onDeleteProjectAgentReference={localSidebarSession.handleDeleteProjectAgentReference}
        onRequestProjectAgentRecommendations={localSidebarSession.handleRequestProjectAgentRecommendations}
        onCreateAgentCreator={localSidebarSession.handleCreateAgentCreator}
      />

      <CommandPalette
        open={isCommandPaletteOpen}
        onOpenChange={setIsCommandPaletteOpen}
        sessions={commandPaletteSessions}
        commands={commandPaletteCommands}
        activeSessionId={activeAgentId}
        onSelectSession={handleSelectSidebarAgent}
      />

      <div
          className="relative flex min-w-0 flex-1"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {activeView === 'chat' && isDraggingFiles ? (
            <div className="pointer-events-none absolute inset-3 z-50 rounded-2xl border border-dashed border-primary/60 bg-primary/[0.06] backdrop-blur-[2px]" />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && panels.isArtifactsPanelOpen ? (
            <ArtifactsSidebar
              environmentClient={environmentClient}
              managerId={activeManagerId}
              artifacts={transcript.collectedArtifacts}
              isOpen={panels.isArtifactsPanelOpen}
              onClose={panels.handleGuardedArtifactsClose}
              onArtifactClick={panels.handleOpenArtifact}
              activeTab={panels.artifactsPanelTab}
              onActiveTabChange={panels.setArtifactsPanelTab}
              panelMode="rail-selected"
              desktopPlacement="left"
              desktopOnly
            />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && !panels.isArtifactsPanelOpen ? (
            <FileBrowserSidebar
              panel={panels.environmentPanels}
              agentId={activeAgentId}
              isOpen={panels.isFileBrowserOpen}
              onClose={panels.handleGuardedToggleFileBrowser}
              onSelectFile={panels.handleGuardedFileBrowserSelectFile}
              onOpenStickyFile={panels.handleFileBrowserOpenStickyFile}
              selectedFile={panels.selectedFileBrowserFile}
              treeSnapshot={panels.fileBrowserTreeSnapshot}
              onTreeSnapshotChange={panels.updateFileBrowserTreeSnapshot}
              worktreeContext={panels.fileBrowserWorktreeContext}
              onClearWorktreeContext={panels.handleGuardedClearFileBrowserWorktreeContext}
              projectResourceProfileId={activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null}
              projectResourceSessionAgentId={activeManagerAgent?.agentId ?? null}
              desktopPlacement="left"
              desktopOnly
              refreshNonce={panels.fileBrowserRefreshNonce}
              onDeleteEntry={panels.handleFileBrowserDeleteEntry}
              onCreateFile={panels.handleFileBrowserCreateFile}
              onRenameEntry={panels.handleFileBrowserRenameEntry}
            />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && panels.isFileBrowserOpen && panels.selectedFileBrowserFile ? (
            <FileBrowserPanel
              panel={panels.environmentPanels}
              agentId={activeAgentId}
              filePath={panels.selectedFileBrowserFile}
              onClose={panels.handleGuardedFileBrowserClosePanel}
              onNavigateToDirectory={panels.handleGuardedFileBrowserNavigateToDirectory}
              tabs={panels.fileBrowserTabs}
              activeTabId={panels.activeFileBrowserTabId}
              previewTabId={panels.previewFileBrowserTabId}
              dirtyTabIds={panels.dirtyFileBrowserTabIds}
              contentScrollSnapshot={panels.activeFileBrowserContentScrollSnapshot}
              onContentScrollSnapshotChange={panels.updateActiveFileBrowserContentScrollSnapshot}
              onActivateTab={panels.activateFileBrowserTab}
              onCloseTab={(tab) => panels.handleRequestCloseFileBrowserTab(tab.id)}
              onStickifyTab={panels.stickifyFileBrowserTab}
              worktreeId={panels.fileBrowserWorktreeContext?.worktreeId ?? null}
              desktopOnly
              resizeHandlePlacement="right"
              inlineEditingEnabled={FILE_BROWSER_INLINE_EDITING_ENABLED}
              editSession={panels.fileEditSession}
              editorSessionKey={panels.activeFileEditorKey}
              refreshNonce={panels.fileBrowserRefreshNonce}
              onContentLoaded={panels.handleFileEditorContentLoaded}
            />
          ) : null}

          <div className="relative flex min-w-0 flex-1 flex-col md:min-w-[min(420px,40%)]">
            {panels.isInlineDiffViewerOpen ? (
              <div className="diff-viewer m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl glass" aria-label="Source Control workspace">
                <DiffViewerContent
                  active={panels.isInlineDiffViewerOpen}
                  panel={panels.environmentPanels}
                  agentId={activeAgentId}
                  onClose={panels.handleCloseDiffViewer}
                  onBrowseWorktreeFiles={panels.handleBrowseWorktreeFromSourceControl}
                  onRequestSourceControlMutation={panels.handleRequestSourceControlMutation}
                  onSourceControlMutationComplete={panels.handleSourceControlMutationComplete}
                  externalRefreshNonce={panels.sourceControlRefreshNonce}
                  remoteUpdateSnapshot={remoteUpdateSnapshot}
                  onRemoteUpdateSnapshotChange={handleRemoteUpdateSnapshotChange}
                  navigationRequest={panels.diffViewerNavigationRequest}
                  initialTab={panels.diffViewerInitialState?.initialTab}
                />
              </div>
            ) : activeView === 'settings' ? (
              <SettingsPanel
                environmentId={selectedEnvironmentId ?? ''}
                onEnvironmentChange={(environmentId) =>
                  navigateToRoute({
                    view: 'settings',
                    settingsTab: routeState.view === 'settings' ? routeState.settingsTab : undefined,
                    ...(environmentId !== primaryEnvironmentId ? { environmentId } : {}),
                  })
                }
                managers={settingsManagers}
                profiles={state.profiles}
                promptChangeKey={state.promptChangeKey}
                specialistChangeKey={state.specialistChangeKey}
                modelConfigChangeKey={state.modelConfigChangeKey}
                connectionEpoch={state.connectionEpoch}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                previewSession={previewSession}
                contextProfileId={routeState.view === 'settings' ? routeState.settingsProfileId : undefined}
                projectSettingsActions={projectSettingsActions}
                initialTab={routeState.view === 'settings' ? routeState.settingsTab : undefined}
                initialSkillImportUrl={routeState.view === 'settings' ? routeState.skillImportUrl : undefined}
                onSkillImportUrlConsumed={() => {
                  if (routeState.view === 'settings' && routeState.skillImportUrl) {
                    navigateToRoute({ ...routeState, skillImportUrl: undefined }, true)
                  }
                }}
              />
            ) : activeView === 'stats' ? (
              <StatsPage
                environmentId={(routeState.view === 'stats' ? routeState.environmentId : undefined) ?? primaryEnvironmentId ?? ''}
                routeState={routeState as { view: 'stats'; statsTab?: StatsTab }}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                onTabChange={(tab) =>
                  navigateToRoute({ view: 'stats', statsTab: tab, ...(routeState.view === 'stats' && routeState.environmentId ? { environmentId: routeState.environmentId } : {}) })
                }
                onEnvironmentChange={(environmentId) =>
                  navigateToRoute({
                    view: 'stats',
                    statsTab: routeState.view === 'stats' ? routeState.statsTab : undefined,
                    ...(environmentId !== primaryEnvironmentId ? { environmentId } : {}),
                  })
                }
              />
            ) : activeView === 'archive' ? (
              <ArchiveView
                agents={state.agents}
                profiles={state.profiles}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                onRestoreProfile={session.handleRestoreProfile}
                onRestoreSession={session.handleRestoreSession}
              />
            ) : activeView === 'chat' && panels.isBrowserOpen && browserSessionAgentId && browserProfileId ? (
              browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening' ? (
                <section className="relative flex min-h-0 flex-1 items-center justify-center" aria-label="Managed Browser workspace">
                  <div data-browser-automation-viewport className="pointer-events-none absolute inset-0" aria-hidden="true" />
                  <div className="relative z-10 max-w-md text-center">
                    <h2 className="font-medium">Browser is open in a separate window</h2>
                    <p className="mt-2 text-sm text-muted-foreground">The same managed tab, automation queue, and recording remain active.</p>
                    <div className="mt-4 flex justify-center gap-2">
                      <button type="button" className="rounded border px-3 py-1.5 text-sm hover:bg-muted focus-visible:ring-2" onClick={() => void browserHostRef.current?.bringToFront()}>Bring to front</button>
                      <button id="managed-browser-dock-control" type="button" className="rounded border px-3 py-1.5 text-sm hover:bg-muted focus-visible:ring-2" onClick={() => void browserHostRef.current?.dock()}>Dock</button>
                    </div>
                  </div>
                </section>
              ) : <BrowserPanel
                snapshot={browserSessionSnapshot}
                host={state.browserHost}
                commandPort={browserCommandPort}
                mode={browserWorkspaceMode}
                popoutAvailable={Boolean(window.electronBridge?.browserWorkspace?.capability.popoutAvailable)}
              />
            ) : launchGroupKey ? (
              <LaunchSessionWorkspace key={launchGroupKey} groupKey={launchGroupKey} onLaunched={handleSelectEnvironmentSession} />
            ) : isUnknownEnvironment ? (
              <EnvironmentSessionView
                onOpenEnvironmentSettings={() => navigateToRoute({ view: 'settings', settingsTab: 'environments' })}
              />
            ) : (
              <div
                className="flex min-h-0 min-w-0 flex-1 flex-col"
                data-testid={environmentSession ? 'environment-session' : undefined}
                data-environment-id={selectedEnvironmentId ?? undefined}
              >
              <ChatWorkspace
                environmentStrip={environmentSession ? <EnvironmentSessionStrip session={environmentSession} /> : null}
                pendingInputCount={state.connected && activeAgent?.model.provider === 'claude-native'
                  ? state.statuses[activeAgentId ?? '']?.pendingCount ?? 0 : 0}
                managerToolActivity={
                  isActiveManager && state.managerToolActivity?.sessionAgentId === activeAgentId
                    ? state.managerToolActivity
                    : null
                }
                headerProps={{
                  connected: state.connected,
                  activeAgentId,
                  activeAgentLabel,
                  environmentClient,
                  activeAgentProfileName,
                  activeAgentSessionLabel,
                  totalUnreadCount,
                  activeAgentArchetypeId: activeAgent?.archetypeId,
                  activeAgentSessionPurpose: activeAgent?.sessionPurpose,
                  activeAgentStatus,
                  activeAgentRole: activeAgent?.role ?? null,
                  activeAgentCreatedAt: activeAgent?.createdAt ?? null,
                  activeAgentUpdatedAt: activeAgent?.updatedAt ?? null,
                  channelView: messageSourceView,
                  onChannelViewChange: setMessageSourceView,
                  contextWindowUsage: transcript.contextWindowUsage,
                  modelCacheHeaderSummary,
                  generationThroughputEligible:
                    isActiveManager && isPiGenerationThroughputEligible(activeAgent),
                  showGenerationThroughput: showConversationThroughput,
                  generationThroughput:
                    isActiveManager && activeAgentId && isPiGenerationThroughputEligible(activeAgent)
                      ? state.generationThroughputByAgentId[activeAgentId]
                      : undefined,
                  generationThroughputLatestFinal:
                    isActiveManager && activeAgentId && isPiGenerationThroughputEligible(activeAgent)
                      ? state.generationThroughputLatestFinalByAgentId[activeAgentId]
                      : undefined,
                  compactionCount: activeAgent?.compactionCount,
                  showCompact: isActiveManager,
                  compactInProgress: isCompactingManager,
                  onCompact: () => void handleCompactManager(),
                  showSmartCompact: isActiveManager,
                  smartCompactInProgress: isSmartCompactingManager,
                  onSmartCompact: () => void handleSmartCompactManager(),
                  autoCompactionInProgress,
                  pinnedCount: transcript.pinnedCount,
                  pinnedMessageIds: transcript.pinnedMessageIds,
                  onScrollToMessage: transcript.handleScrollToMessage,
                  onClearAllPins: conversationActionsEnabled ? session.handleClearAllPins : undefined,
                  showStopAll: isActiveManager,
                  stopAllInProgress: isStoppingAllAgents,
                  stopAllDisabled: !state.connected || !canStopAllAgents,
                  onStopAll: () => void handleStopAllAgents(),
                  showNewChat: isActiveManager,
                  onNewChat: session.handleNewChat,
                  isArtifactsPanelOpen: panels.isArtifactsPanelOpen,
                  onToggleArtifactsPanel: panels.handleGuardedToggleArtifactsPanel,
                  isTerminalPanelOpen: terminalPanel.isPanelVisible,
                  terminalCount: state.terminals.length,
                  onToggleTerminalPanel: terminalSessionAgentId ? terminalPanel.togglePanel : undefined,
                  onOpenDiffViewer: panels.handleOpenDiffViewerModal,
                  remoteUpdateAttentionRequired:
                    remoteUpdateSnapshot?.effectiveEnabled === true &&
                    remoteUpdateSnapshot.state === 'update_available' &&
                    remoteUpdateSnapshot.attentionRequired === true,
                  isFileBrowserOpen: panels.isFileBrowserOpen,
                  onToggleFileBrowser: panels.handleGuardedToggleFileBrowser,
                  onToggleMobileSidebar: () =>
                    panels.setIsMobileSidebarOpen((previous) => !previous),
                  showDesktopWorkspaceActions: !showActivityRail,
                  sessionFeedbackVote: isActiveManager && activeAgentId ? feedback.getVote(activeAgentId) : null,
                  sessionFeedbackHasComment: isActiveManager && activeAgentId ? feedback.hasComment(activeAgentId) : false,
                  onSessionFeedbackVote:
                    conversationActionsEnabled && isActiveManager && feedbackProfileId ? feedback.submitVote : undefined,
                  onSessionFeedbackComment:
                    conversationActionsEnabled && isActiveManager && feedbackProfileId ? feedback.submitComment : undefined,
                  onSessionFeedbackClearComment:
                    conversationActionsEnabled && isActiveManager && feedbackProfileId ? feedback.clearComment : undefined,
                  isFeedbackSubmitting: feedback.isSubmitting,
                }}
                remoteUpdateSnapshot={remoteUpdateSnapshot}
                onRemoteUpdateSnapshotChange={handleRemoteUpdateSnapshotChange}
                onOpenRemoteUpdateIncoming={() => panels.handleOpenDiffViewerDeepLink({
                  initialTab: 'incoming',
                })}
                lastError={state.lastError}
                localSettingsClient={httpClientRef.current}
                lastSuccess={state.lastSuccess}
                restartRecovery={state.restartRecovery}
                onResumeRestartRecovery={() => clientRef.current?.resumeRestartRecovery()}
                onDismissRestartRecovery={() => clientRef.current?.dismissRestartRecovery()}
                chatSearchBarProps={{ search: transcript.chatSearch }}
                showWelcomeForm={shouldShowWelcomeForm}
                showCreateManagerState={shouldShowCreateManagerState}
                welcomeCalloutProps={{
                  mode: 'first-launch',
                  state: onboardingState,
                  isBusy: isMutatingOnboardingState,
                  error: onboardingError,
                  onSave: handleSaveOnboarding,
                  onSkipForNow: handleSkipOnboarding,
                }}
                readyCalloutProps={{
                  mode: 'ready',
                  state: onboardingState,
                  isBusy: isMutatingOnboardingState,
                  error: onboardingError,
                  onCreateManager: handleOpenCreateManagerDialog,
                }}
                isMessageListHidden={
                  terminalPanel.panelMode === 'maximized' &&
                  !terminalPanel.isMobile &&
                  terminalPanel.isPanelVisible
                }
                messageListRef={messageListRef}
                messageListProps={{
                  messages: transcript.visibleMessages,
                  projectName: activeAgentProfileName,
                  agents: state.agents,
                  isLoading,
                  environmentClient,
                  activeAgentId,
                  projectAgent: activeAgent?.projectAgent,
                  onSuggestionClick: conversationActionsEnabled ? session.handleSuggestionClick : undefined,
                  onArtifactClick: conversationActionsEnabled ? panels.handleOpenArtifact : undefined,
                  onForkFromMessage: conversationActionsEnabled && activeAgentId ? session.handleForkFromMessage : undefined,
                  onPinMessage: conversationActionsEnabled && isActiveManager && activeAgentId ? session.handlePinMessage : undefined,
                  onStopExternalThread: conversationActionsEnabled ? session.handleStopSession : undefined,
                  onReplyToMessage: conversationActionsEnabled ? session.handleReplyToMessage : undefined,
                  getVote: conversationActionsEnabled && feedbackProfileId ? feedback.getVote : undefined,
                  hasComment: conversationActionsEnabled && feedbackProfileId ? feedback.hasComment : undefined,
                  onFeedbackVote: conversationActionsEnabled && feedbackProfileId ? feedback.submitVote : undefined,
                  onFeedbackComment: conversationActionsEnabled && feedbackProfileId ? feedback.submitComment : undefined,
                  onFeedbackClearComment: conversationActionsEnabled && feedbackProfileId ? feedback.clearComment : undefined,
                  isFeedbackSubmitting: feedback.isSubmitting,
                  onChoiceSubmit: conversationActionsEnabled ? session.handleChoiceSubmit : undefined,
                  onChoiceCancel: conversationActionsEnabled ? session.handleChoiceCancel : undefined,
                  pendingChoiceIds: conversationActionsEnabled ? state.pendingChoiceIds : new Set(),
                  codexElicitations: conversationActionsEnabled ? state.codexElicitations : [],
                  onCodexElicitationResponse: conversationActionsEnabled
                    ? (agentId, elicitationId, decision, values, persistScope) =>
                        clientRef.current?.sendCodexElicitationResponse(agentId, elicitationId, decision, values, persistScope)
                    : undefined,
                  missingPendingChoiceIds,
                  planSnapshot,
                  planExpanded,
                  onPlanExpandedChange: setPlanExpanded,
                  statuses: state.statuses,
                  hasOlder: conversationActionsEnabled && (state.conversationPage?.hasOlder ?? false),
                  olderCursor: conversationActionsEnabled ? state.conversationPage?.nextCursor : undefined,
                  isLoadingOlder: conversationActionsEnabled && state.conversationPageLoading,
                  historyCompleteness: state.conversationPage?.completeness ?? 'complete',
                  historyMutation: state.conversationHistoryMutation,
                  secureSessionRequests,
                  onLoadOlder: conversationActionsEnabled ? () => {
                    if (state.conversationPage?.completeness === 'source_changed') {
                      return clientRef.current?.refreshConversationHistory()
                    }
                    return clientRef.current?.loadOlderConversation()
                  } : undefined,
                  conversationBootstrapPhase: transcript.conversationBootstrap?.phase,
                  hasStalePresentation: transcript.hasStaleConversationPresentation,
                  bootstrapErrorMessage: transcript.conversationBootstrap?.errorMessage,
                  onRetryBootstrap: () => clientRef.current?.retryConversationBootstrap(),
                  commandStatuses: state.commandStatuses,
                  onRetryCommand: handleRetryEnvironmentMessage,
                  onResendCommand: handleResendEnvironmentMessage,
                  streamingStartedAt:
                    activeAgentStatus === 'streaming'
                      ? state.statuses[activeAgentId ?? '']?.streamingStartedAt
                      : undefined,
                }}
                planSnapshot={planSnapshot}
                goalSnapshot={goalSnapshot}
                onGoalAction={(action) => {
                  if (activeAgentId) clientRef.current?.controlSessionGoal(activeAgentId, action)
                }}
                workerPillBarProps={
                  isActiveManager
                    ? {
                        workers: sessionWorkers,
                        statuses: state.statuses,
                        activityMessages: state.activityMessages,
                        generationThroughputByAgentId: workerMetadataHydrated
                          ? state.generationThroughputByAgentId
                          : undefined,
                        generationThroughputLatestFinalByAgentId: workerMetadataHydrated
                          ? state.generationThroughputLatestFinalByAgentId
                          : undefined,
                        workerMetadataSessionIds: state.workerMetadataSessionIds,
                        showGenerationThroughput: showConversationThroughput,
                        onNavigateToWorker: panels.handleSelectAgent,
                      }
                    : undefined
                }
                workerBackBarProps={
                  activeAgent?.role === 'worker' && activeAgent.managerId && parentManagerLabel
                    ? {
                        managerLabel: parentManagerLabel,
                        onNavigateBack: () => panels.handleSelectAgent(activeAgent.managerId),
                        ...(workerSecureStatus ? { secureStatus: workerSecureStatus } : {}),
                      }
                    : undefined
                }
                environmentClient={environmentClient}
                terminalPanelProps={{
                  environmentClient,
                  sessionAgentId: terminalSessionAgentId,
                  terminals: state.terminals,
                  panelMode: terminalPanel.panelMode,
                  activeTerminalId: terminalPanel.activeTerminalId,
                  panelHeight: terminalPanel.panelHeight,
                  isMobile: terminalPanel.isMobile,
                  maxTerminalsPerManager: terminalPanel.maxTerminalsPerManager,
                  editingTerminalId: terminalPanel.editingTerminalId,
                  renameDraft: terminalPanel.renameDraft,
                  onSelectTerminal: terminalPanel.setActiveTerminalId,
                  onCreateTerminal: () => {
                    void terminalPanel.createTerminal()
                  },
                  onCloseTerminal: terminalPanel.closeTerminal,
                  onStartRenameTerminal: terminalPanel.startRenameTerminal,
                  onRenameDraftChange: terminalPanel.setRenameDraft,
                  onCommitRenameTerminal: terminalPanel.commitRenameTerminal,
                  onCancelRenameTerminal: terminalPanel.cancelRenameTerminal,
                  onCollapsePanel: terminalPanel.collapsePanel,
                  onRestorePanel: terminalPanel.restorePanel,
                  onMaximizePanel: terminalPanel.maximizePanel,
                  onHidePanel: terminalPanel.hidePanel,
                  onPanelHeightChange: terminalPanel.setPanelHeight,
                  onFocusChatInput: session.handleFocusChatInput,
                  onAddToChat: session.handleTerminalAddToChat,
                }}
                messageInputRef={messageInputRef}
                messageInputProps={{
                  onSend: session.handleSend,
                  onSubmitted: session.handleMessageInputSubmitted,
                  isLoading,
                  disabled: !state.connected || !activeAgentId || hasActivePendingChoice || !conversationActionsEnabled,
                  placeholderOverride: hasActivePendingChoice
                    ? 'Respond to the choice above or click Skip…'
                    : undefined,
                  allowWhileLoading: true,
                  agentLabel: activeAgentLabel,
                  environmentClient,
                  agentId: activeAgentId ?? undefined,
                  draftKey: activeAgentId && selectedEnvironmentId ? qualifiedKey(selectedEnvironmentId, activeAgentId) : undefined,
                  slashCommands: isActiveManager ? builderSlashCommands : slashCommands,
                  projectAgents: projectAgentSuggestions,
                  enableCodexMention: shouldEnableCodexMention(activeAgent),
                  managerAgentId: activeAgentId ?? undefined,
                  replyTarget,
                  onClearReplyTarget: () => setReplyTarget(null),
                  sessionModelPicker,
                  sessionCoordinationPicker,
                  sessionContextModePicker,
                  secureSessionPicker,
                }}
              />
              </div>
            )}
            {activeView === 'chat' && !panels.isInlineDiffViewerOpen ? (
              <BrowserPreviewSurface hidden={panels.isBrowserOpen} onOpenManagedTab={handleOpenManagedPreviewTab} />
            ) : null}
            {activeView === 'chat' && !panels.isInlineDiffViewerOpen && sideChat.isOpen && !sideChat.isExpanded ? (
              <SideChatPanel {...sideChatPanelProps} />
            ) : null}
          </div>

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && sideChat.isOpen && sideChat.isExpanded ? (
            <SideChatPanel {...sideChatPanelProps} />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen ? (
            <ChatSidePanels
              artifactsSidebarProps={{
                environmentClient,
                managerId: activeManagerId,
                artifacts: transcript.collectedArtifacts,
                isOpen: panels.isArtifactsPanelOpen,
                onClose: panels.handleGuardedArtifactsClose,
                onArtifactClick: panels.handleOpenArtifact,
                activeTab: panels.artifactsPanelTab,
                onActiveTabChange: panels.setArtifactsPanelTab,
                panelMode: 'rail-selected',
                mobileOnly: true,
              }}
              fileBrowserPanelProps={
                panels.isFileBrowserOpen && panels.selectedFileBrowserFile
                  ? {
                      panel: panels.environmentPanels,
                      agentId: activeAgentId,
                      filePath: panels.selectedFileBrowserFile,
                      onClose: panels.handleGuardedFileBrowserClosePanel,
                      onNavigateToDirectory: panels.handleGuardedFileBrowserNavigateToDirectory,
                      tabs: panels.fileBrowserTabs,
                      activeTabId: panels.activeFileBrowserTabId,
                      previewTabId: panels.previewFileBrowserTabId,
                      dirtyTabIds: panels.dirtyFileBrowserTabIds,
                      contentScrollSnapshot: panels.activeFileBrowserContentScrollSnapshot,
                      onContentScrollSnapshotChange: panels.updateActiveFileBrowserContentScrollSnapshot,
                      onActivateTab: panels.activateFileBrowserTab,
                      onCloseTab: (tab) => panels.handleRequestCloseFileBrowserTab(tab.id),
                      onStickifyTab: panels.stickifyFileBrowserTab,
                      worktreeId: panels.fileBrowserWorktreeContext?.worktreeId ?? null,
                      mobileOnly: true,
                    }
                  : null
              }
              fileBrowserSidebarProps={{
                panel: panels.environmentPanels,
                agentId: activeAgentId,
                isOpen: panels.isFileBrowserOpen,
                onClose: panels.handleGuardedToggleFileBrowser,
                onSelectFile: panels.handleGuardedFileBrowserSelectFile,
                onOpenStickyFile: panels.handleFileBrowserOpenStickyFile,
                selectedFile: panels.selectedFileBrowserFile,
                treeSnapshot: panels.fileBrowserTreeSnapshot,
                onTreeSnapshotChange: panels.updateFileBrowserTreeSnapshot,
                worktreeContext: panels.fileBrowserWorktreeContext,
                onClearWorktreeContext: panels.handleGuardedClearFileBrowserWorktreeContext,
                projectResourceProfileId: activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null,
                projectResourceSessionAgentId: activeManagerAgent?.agentId ?? null,
                mobileOnly: true,
                refreshNonce: panels.fileBrowserRefreshNonce,
                onDeleteEntry: panels.handleFileBrowserDeleteEntry,
                onCreateFile: panels.handleFileBrowserCreateFile,
                onRenameEntry: panels.handleFileBrowserRenameEntry,
              }}
            />
          ) : null}
      </div>

      <GlobalDialogs
        postUpdateSource={wsUrl}
        artifactPanelProps={{
          artifact: panels.activeArtifact,
          environmentClient,
          activeAgentId,
          onClose: panels.handleGuardedArtifactDialogClose,
          onArtifactClick: panels.handleOpenArtifact,
        }}
        createManagerDialogProps={{
          open: isCreateManagerDialogOpen,
          originId: projectEnvironmentId ?? primaryEnvironmentId ?? '',
          environmentPicker: primaryEnvironmentId ? {
            environmentId: projectEnvironmentId ?? primaryEnvironmentId,
            onChange: (environmentId) => handleProjectEnvironmentChange(environmentId === primaryEnvironmentId ? null : environmentId),
          } : undefined,
          // Folders on another machine are browsed on that machine; local dialogs only see this one.
          serverDirectoryBrowser: projectEnvironmentId && getProjectTargetClient()
            ? { client: getProjectTargetClient()!, canCreateDirectory: true }
            : undefined,
          modelConfigChangeKey: state.modelConfigChangeKey,
          connectionEpoch: state.connectionEpoch,
          isCreatingManager,
          isValidatingDirectory,
          isPickingDirectory,
          newManagerName,
          newManagerCwd,
          newManagerModelSelection,
          newManagerReasoningLevel,
          secureSessionsEnabled: newManagerSecureSessionsEnabled,
          onSecureSessionsEnabledChange: handleNewManagerSecureSessionsEnabledChange,
          scaffoldForgeResources,
          createManagerError,
          browseError,
          cloneRepositoryEnabled: !projectEnvironmentId,
          sourceMode: createProjectSourceMode,
          repositoryUrl,
          repositoryFolder,
          repositoryBasePath,
          cloneStage,
          clonePercent,
          cloneCancellable,
          isCancellingClone,
          onSourceModeChange: handleCreateProjectSourceModeChange,
          onRepositoryUrlChange: handleRepositoryUrlChange,
          onRepositoryFolderChange: handleRepositoryFolderChange,
          onRepositoryBasePathChange: handleRepositoryBasePathChange,
          onBrowseRepositoryBasePath: () => {
            void handleBrowseRepositoryBasePath()
          },
          onCancelClone: () => {
            void handleCancelClone()
          },
          onOpenChange: handleCreateManagerDialogOpenChange,
          onNameChange: handleNewManagerNameChange,
          onCwdChange: handleNewManagerCwdChange,
          onModelSelectionChange: handleNewManagerModelSelectionChange,
          onReasoningLevelChange: handleNewManagerReasoningLevelChange,
          onScaffoldForgeResourcesChange: handleScaffoldForgeResourcesChange,
          onBrowseDirectory: projectEnvironmentId ? undefined : () => {
            void handleBrowseDirectory()
          },
          onSubmit: (event) => {
            void handleCreateManager(event)
          },
        }}
        deleteManagerDialogProps={{
          managerToDelete: localSidebarManager.managerToDelete,
          deleteManagerError: localSidebarManager.deleteManagerError,
          isDeletingManager: localSidebarManager.isDeletingManager,
          onClose: localSidebarManager.handleCloseDeleteManagerDialog,
          onConfirm: () => {
            void localSidebarManager.handleConfirmDeleteManager()
          },
        }}
        forkSessionDialogProps={
          messageForkTarget
            ? {
                onConfirm: session.handleConfirmMessageFork,
                onClose: () => setMessageForkTarget(null),
                fromMessageTimestamp: messageForkTarget.messageTimestamp
                  ? new Date(messageForkTarget.messageTimestamp).toLocaleString()
                  : undefined,
              }
            : null
        }
        diffViewerDialogProps={{
          open: panels.isDiffViewerOpen && panels.diffViewerPresentation === 'modal',
          onOpenChange: panels.handleGuardedDiffViewerOpenChange,
          panel: panels.environmentPanels,
          agentId: activeAgentId,
          onBrowseWorktreeFiles: panels.handleBrowseWorktreeFromSourceControl,
          onRequestSourceControlMutation: panels.handleRequestSourceControlMutation,
          onSourceControlMutationComplete: panels.handleSourceControlMutationComplete,
          externalRefreshNonce: panels.sourceControlRefreshNonce,
          remoteUpdateSnapshot,
          onRemoteUpdateSnapshotChange: handleRemoteUpdateSnapshotChange,
          navigationRequest: panels.diffViewerNavigationRequest,
          initialTab: panels.diffViewerInitialState?.initialTab,
        }}
      />

      {bitwardenUnlockPrompt ? (
        <BitwardenUnlockDialog
          open
          providerName={bitwardenUnlockPrompt.providerName}
          reason={bitwardenUnlockPrompt.reason}
          onUnlock={unlockBitwardenPrompt}
          onDismiss={dismissBitwardenPrompt}
        />
      ) : null}
    </WorkGraphWorkerHighlightProvider>
  )
}

const UNSELECTED_ORIGIN = 'unregistered'
const NO_MESSAGES: ManagerWsState['messages'] = []

/** Primary sidebar actions read sessions and projects only; the primary transcript is not theirs. */
function selectPrimarySidebarState(state: ManagerWsState): Pick<ManagerWsState, 'messages' | 'agents' | 'profiles'> {
  return { messages: NO_MESSAGES, agents: state.agents, profiles: state.profiles }
}

function samePrimarySidebarState(
  a: Pick<ManagerWsState, 'agents' | 'profiles'>,
  b: Pick<ManagerWsState, 'agents' | 'profiles'>,
): boolean {
  return a.agents === b.agents && a.profiles === b.profiles
}

/** Orders saved before environment identity used the reserved `local` origin; read them as the primary. */
function withPrimaryOrderOrigin(api: BuilderSidebarOrderApi, primaryEnvironmentId: string | null): BuilderSidebarOrderApi {
  if (!primaryEnvironmentId) return api
  const migrate = <T extends Awaited<ReturnType<BuilderSidebarOrderApi['get']>>>(state: T): T => ({
    ...state,
    order: state.order.map((ref) => (ref.originId === 'local' ? { ...ref, originId: primaryEnvironmentId } : ref)),
  })
  return {
    get: async () => migrate(await api.get()),
    put: async (request) => {
      try {
        return migrate(await api.put(request))
      } catch (error) {
        throw error instanceof BuilderSidebarOrderApiConflictError
          ? new BuilderSidebarOrderApiConflictError(migrate(error.current))
          : error
      }
    },
  }
}
