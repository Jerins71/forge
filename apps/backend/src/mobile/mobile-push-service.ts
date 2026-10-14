import {
  MOBILE_PUSH_ANDROID_CHANNEL_ID,
  MOBILE_PUSH_DATA_VERSION,
  type MobilePushData,
  type MobilePushDevice,
  type ServerEvent,
  type SessionAttention,
  type SessionAttentionReason,
} from "@forge/protocol";
import {
  NotificationSettingsService,
  shouldMuteCliOriginatedNotifications,
} from "../swarm/notification-settings-service.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { ExpoPushClient, type ExpoPushMessage, type ExpoSendResult } from "./expo-push-client.js";
import {
  MobilePushStore,
  type MobileNotificationPreferences,
  type MobileNotificationPreferencesPatch,
} from "./mobile-push-store.js";

const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_SEND_RETRY_BACKOFF_MS = [250, 1000, 2_500] as const;
const RECEIPTS_CHUNK_SIZE = 100;
const DEFAULT_PUSH_TITLE = "Forge";
const DEFAULT_TEST_BODY = "Forge push notifications are configured.";
const MAX_PUSH_TITLE_LENGTH = 64;

const ATTENTION_PUSH_BODY: Record<SessionAttentionReason, string> = {
  work_settled: "Finished — ready for you",
  plan_completed: "Plan complete — ready for you",
  work_graph_completed: "All delegated work is complete",
  awaiting_review: "Ready for your review",
  decision_waiting: "Waiting on your decision",
  work_failed: "Work failed — needs your attention",
};

interface AgentRoutingContext {
  sessionAgentId: string;
  profileId: string;
  agentDisplayName: string;
  sessionDisplayName: string;
  projectDisplayName?: string;
}

interface PendingReceiptRecord {
  token: string;
  createdAt: string;
}

export class MobilePushService {
  private readonly swarmManager: SwarmManager;
  private readonly store: MobilePushStore;
  private readonly expoPushClient: ExpoPushClient;
  private readonly environmentId: () => string | undefined;
  private readonly isDeviceSessionActive: (deviceSessionId: string) => boolean;
  private readonly notificationSettingsService: NotificationSettingsService;
  private readonly receiptPollIntervalMs: number;
  private readonly sendRetryBackoffMs: readonly number[];

  private started = false;
  private receiptTimer: NodeJS.Timeout | null = null;
  private receiptPollingInFlight = false;
  private readonly pendingReceipts = new Map<string, PendingReceiptRecord>();
  /**
   * Attention IDs already visible. Only IDs absent from the previous snapshot
   * push; the first snapshot observed is a baseline so restarts never replay.
   */
  private knownAttentionIds: Set<string> | null = null;

  private readonly onSessionAttentionSnapshot = (event: ServerEvent): void => {
    if (event.type !== "session_attention_snapshot") {
      return;
    }

    void this.handleSessionAttentionSnapshot(event.attentions).catch((error) => {
      this.logError("session_attention_snapshot", error);
    });
  };

  constructor(options: {
    swarmManager: SwarmManager;
    dataDir: string;
    /** The environment pushes are delivered for; nothing is pushed until it is known. */
    environmentId: () => string | undefined;
    /** Whether the paired device session that registered a token is still active. */
    isDeviceSessionActive: (deviceSessionId: string) => boolean;
    notificationSettingsService?: NotificationSettingsService;
    expoPushClient?: ExpoPushClient;
    now?: () => Date;
    receiptPollIntervalMs?: number;
    sendRetryBackoffMs?: number[];
  }) {
    this.swarmManager = options.swarmManager;
    this.store = new MobilePushStore({ dataDir: options.dataDir, now: options.now });
    this.expoPushClient = options.expoPushClient ?? new ExpoPushClient();
    this.environmentId = options.environmentId;
    this.isDeviceSessionActive = options.isDeviceSessionActive;
    this.notificationSettingsService =
      options.notificationSettingsService ?? new NotificationSettingsService({ dataDir: options.dataDir, now: options.now });
    this.receiptPollIntervalMs = options.receiptPollIntervalMs ?? DEFAULT_RECEIPT_POLL_INTERVAL_MS;
    this.sendRetryBackoffMs =
      options.sendRetryBackoffMs && options.sendRetryBackoffMs.length > 0
        ? options.sendRetryBackoffMs
        : DEFAULT_SEND_RETRY_BACKOFF_MS;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.notificationSettingsService.load();

    this.started = true;
    this.knownAttentionIds = this.readBaselineAttentionIds();
    this.swarmManager.on("session_attention_snapshot", this.onSessionAttentionSnapshot);

    this.receiptTimer = setInterval(() => {
      void this.pollReceipts().catch((error) => {
        this.logError("poll_receipts", error);
      });
    }, this.receiptPollIntervalMs);
    this.receiptTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.knownAttentionIds = null;
    this.swarmManager.off("session_attention_snapshot", this.onSessionAttentionSnapshot);

    if (this.receiptTimer) {
      clearInterval(this.receiptTimer);
      this.receiptTimer = null;
    }
  }

  async registerDevice(deviceSessionId: string, payload: unknown): Promise<MobilePushDevice> {
    const maybe = requireObject(payload) as {
      token?: unknown;
      platform?: unknown;
      deviceName?: unknown;
      enabled?: unknown;
    };

    return this.store.registerDevice(deviceSessionId, {
      token: maybe.token,
      platform: maybe.platform,
      deviceName: maybe.deviceName,
      enabled: maybe.enabled,
    });
  }

  async unregisterDevice(deviceSessionId: string, payload: unknown): Promise<boolean> {
    return this.store.unregisterDevice(deviceSessionId, (requireObject(payload) as { token?: unknown }).token);
  }

  async getNotificationPreferences(): Promise<MobileNotificationPreferences> {
    return this.store.getPreferences();
  }

  async updateNotificationPreferences(payload: unknown): Promise<MobileNotificationPreferences> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Request body must be a JSON object");
    }

    const maybe = payload as MobileNotificationPreferencesPatch;
    return this.store.updatePreferences(maybe);
  }

  /** Sends a test push to the enabled tokens the calling device session registered. */
  async sendTestNotification(deviceSessionId: string): Promise<{
    ok: boolean;
    ticketId?: string;
    error?: string;
  }> {
    const environmentId = this.environmentId();
    const tokens = (await this.store.getEnabledDevices())
      .filter((device) => device.deviceSessionId === deviceSessionId)
      .map((device) => device.token);
    if (!environmentId || tokens.length === 0) {
      return { ok: false, error: "This device has no push token registered" };
    }

    let last: { ok: boolean; ticketId?: string; error?: string } = { ok: false };
    for (const token of tokens) {
      last = await this.sendToDeviceWithRetry(token, {
        title: DEFAULT_PUSH_TITLE,
        body: DEFAULT_TEST_BODY,
        sound: "default",
        channelId: MOBILE_PUSH_ANDROID_CHANNEL_ID,
        data: { v: MOBILE_PUSH_DATA_VERSION, type: "test", environmentId } satisfies MobilePushData,
      });
      if (!last.ok) return { ok: false, error: last.error ?? "Failed to send Expo push notification" };
    }
    return { ok: true, ticketId: last.ticketId };
  }

  private readBaselineAttentionIds(): Set<string> | null {
    try {
      return new Set(this.swarmManager.getSessionAttentionSnapshot().attentions.map((entry) => entry.attentionId));
    } catch {
      // Not initialized yet: the first emitted snapshot becomes the baseline.
      return null;
    }
  }

  private async handleSessionAttentionSnapshot(attentions: readonly SessionAttention[]): Promise<void> {
    const previous = this.knownAttentionIds;
    this.knownAttentionIds = new Set(attentions.map((entry) => entry.attentionId));
    if (!previous) {
      return;
    }

    for (const entry of attentions) {
      if (previous.has(entry.attentionId)) {
        continue;
      }

      await this.dispatchNotification({
        agentId: entry.sessionAgentId,
        eventId: entry.attentionId,
        body: ATTENTION_PUSH_BODY[entry.reason] ?? "Needs you",
      });
    }
  }

  private async dispatchNotification(notification: {
    agentId: string;
    eventId: string;
    body: string;
  }): Promise<void> {
    if (!this.started) {
      return;
    }

    const preferences = await this.store.getPreferences();
    if (!preferences.enabled) {
      return;
    }

    const context = this.resolveAgentRoutingContext(notification.agentId);
    if (await this.isPushSuppressedForSession(context.sessionAgentId)) {
      return;
    }

    const environmentId = this.environmentId();
    if (!environmentId) {
      return;
    }

    const devices = (await this.store.getEnabledDevices()).filter(
      (device) => device.deviceSessionId !== undefined && this.isDeviceSessionActive(device.deviceSessionId),
    );
    const data: MobilePushData = {
      v: MOBILE_PUSH_DATA_VERSION,
      type: "attention",
      environmentId,
      projectId: context.profileId,
      sessionId: context.sessionAgentId,
      eventId: notification.eventId,
    };

    for (const device of devices) {
      const sendResult = await this.sendToDeviceWithRetry(device.token, {
        title: buildMessageNotificationTitle(context),
        body: notification.body,
        sound: "default",
        channelId: MOBILE_PUSH_ANDROID_CHANNEL_ID,
        data,
      });
      if (!sendResult.ok) {
        this.logError("send_push", sendResult.error ?? "Unknown Expo send error");
      }
    }
  }

  private async sendToDeviceWithRetry(
    token: string,
    payload: Omit<ExpoPushMessage, "to">
  ): Promise<{ ok: boolean; ticketId?: string; error?: string }> {
    let lastResult: ExpoSendResult | null = null;

    for (let attempt = 0; attempt < this.sendRetryBackoffMs.length; attempt += 1) {
      const result = await this.expoPushClient.send({
        ...payload,
        to: token
      });
      lastResult = result;

      if (result.ok) {
        if (result.ticketId) {
          this.pendingReceipts.set(result.ticketId, {
            token,
            createdAt: new Date().toISOString()
          });
        }

        return {
          ok: true,
          ticketId: result.ticketId
        };
      }

      if (result.errorCode === "DeviceNotRegistered") {
        await this.store.disableDevice(token, "DeviceNotRegistered");
        return {
          ok: false,
          error: result.error ?? "Device token is not registered"
        };
      }

      if (!result.retryable || attempt === this.sendRetryBackoffMs.length - 1) {
        return {
          ok: false,
          error: result.error ?? "Expo push request failed"
        };
      }

      const delayMs = this.sendRetryBackoffMs[attempt] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return {
      ok: false,
      error: lastResult?.error ?? "Expo push request failed"
    };
  }

  private async pollReceipts(): Promise<void> {
    if (!this.started || this.receiptPollingInFlight || this.pendingReceipts.size === 0) {
      return;
    }

    this.receiptPollingInFlight = true;

    try {
      const receiptIds = Array.from(this.pendingReceipts.keys());

      for (let index = 0; index < receiptIds.length; index += RECEIPTS_CHUNK_SIZE) {
        const chunk = receiptIds.slice(index, index + RECEIPTS_CHUNK_SIZE);
        let receipts: Record<string, { status: "ok" | "error"; details?: { error?: string } }>;

        try {
          receipts = await this.expoPushClient.getReceipts(chunk);
        } catch (error) {
          this.logError("fetch_receipts", error);
          return;
        }

        for (const receiptId of chunk) {
          const record = this.pendingReceipts.get(receiptId);
          if (!record) {
            continue;
          }

          const receipt = receipts[receiptId];
          if (!receipt) {
            continue;
          }

          if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
            await this.store.disableDevice(record.token, "DeviceNotRegistered");
          }

          this.pendingReceipts.delete(receiptId);
        }
      }
    } finally {
      this.receiptPollingInFlight = false;
    }
  }

  private resolveAgentRoutingContext(agentId: string): AgentRoutingContext {
    const descriptor = this.swarmManager.getAgent(agentId);

    if (descriptor?.role === "manager") {
      const profileId = normalizeOptionalString(descriptor.profileId) ?? descriptor.agentId;
      return {
        sessionAgentId: descriptor.agentId,
        profileId,
        agentDisplayName: descriptor.displayName,
        sessionDisplayName: getSessionDisplayName(descriptor),
        projectDisplayName: this.resolveProjectDisplayName(profileId)
      };
    }

    if (descriptor?.role === "worker") {
      const managerDescriptor = this.swarmManager.getAgent(descriptor.managerId);
      const profileId =
        managerDescriptor?.role === "manager"
          ? normalizeOptionalString(managerDescriptor.profileId) ?? managerDescriptor.agentId
          : descriptor.managerId;

      return {
        sessionAgentId: descriptor.managerId,
        profileId,
        agentDisplayName: descriptor.displayName,
        sessionDisplayName: managerDescriptor ? getSessionDisplayName(managerDescriptor) : descriptor.managerId,
        projectDisplayName: this.resolveProjectDisplayName(profileId)
      };
    }

    return {
      sessionAgentId: agentId,
      profileId: agentId,
      agentDisplayName: agentId,
      sessionDisplayName: agentId
    };
  }

  private resolveProjectDisplayName(profileId: string): string | undefined {
    const profile = this.swarmManager.listProfiles().find((entry) => entry.profileId === profileId);
    return normalizeOptionalString(profile?.displayName);
  }

  private async isPushSuppressedForSession(sessionAgentId: string): Promise<boolean> {
    const descriptor = this.swarmManager.getAgent(sessionAgentId);
    return shouldMuteCliOriginatedNotifications({
      settingsService: this.notificationSettingsService,
      descriptor,
    });
  }

  private logError(scope: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mobile-push] ${scope}: ${message}`);
  }
}

function buildMessageNotificationTitle(context: AgentRoutingContext): string {
  const sessionDisplayName = normalizeOptionalString(context.sessionDisplayName) ?? context.sessionAgentId;
  const projectDisplayName = normalizeOptionalString(context.projectDisplayName);

  if (projectDisplayName && projectDisplayName !== sessionDisplayName) {
    const combinedTitle = `${projectDisplayName} / ${sessionDisplayName}`;
    if (combinedTitle.length <= MAX_PUSH_TITLE_LENGTH) {
      return combinedTitle;
    }
  }

  return truncateText(sessionDisplayName, MAX_PUSH_TITLE_LENGTH);
}

function getSessionDisplayName(descriptor: { agentId: string; displayName: string; sessionLabel?: string }): string {
  return normalizeOptionalString(descriptor.sessionLabel) ?? normalizeOptionalString(descriptor.displayName) ?? descriptor.agentId;
}

function requireObject(payload: unknown): object {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Request body must be a JSON object");
  }
  return payload;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
