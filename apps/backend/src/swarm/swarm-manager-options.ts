import type { ObservabilityFacade } from "../observability/observability-types.js";
import type { CodexAppServerService } from "./codex-app-server/codex-app-server-service.js";
import type { CodexAppServerServiceOptions } from "./codex-app-server/types.js";
import type { CompactionRuntimeSettingsProvider } from "./compaction-runtime-settings-provider.js";
import type {
  ExternalThreadStopInterruptCallback,
  ExternalThreadTerminateCleanupCallback,
} from "./swarm-agent-lifecycle-service.js";

/** Optional composition seams for the SwarmManager application root. */
export interface SwarmManagerOptions {
  now?: () => string;
  observability?: ObservabilityFacade;
  codexAppServerService?: CodexAppServerService;
  codexAppServerServiceOptions?: CodexAppServerServiceOptions;
  /** Stop-only seam for preserved sidecars; defaults to CodexAppServerService.interruptTurn(). */
  interruptExternalThreadSidecarTurn?: ExternalThreadStopInterruptCallback;
  /** Kill/delete cleanup-only seam. Distinct from stop interrupts; defaults to Codex cleanup. */
  terminateExternalThreadSidecarTurn?: ExternalThreadTerminateCleanupCallback;
  compactionRuntimeSettingsProvider?: CompactionRuntimeSettingsProvider;
  browserEngine?: import("./browser-automation/browser-engine.js").BrowserEngine;
}
