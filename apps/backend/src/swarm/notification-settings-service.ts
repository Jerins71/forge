import type { AgentDescriptor, NotificationSettings, UpdateNotificationSettingsRequest } from "@forge/protocol";
import { open, readFile } from "node:fs/promises";
import { getNotificationSettingsPath } from "./data-paths.js";
import { isEnoentError } from "../utils/fs-errors.js";
import { writeJsonFileAtomic } from "../utils/atomic-files.js";

const SETTINGS_FILE_VERSION = 1;

interface NotificationSettingsFile {
  version: 1;
  muteCliOriginatedNotifications?: unknown;
  updatedAt?: unknown;
}

export class NotificationSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationSettingsValidationError";
  }
}

export class NotificationSettingsService {
  private readonly settingsPath: string;
  private readonly now: () => Date;
  private settings: NotificationSettings = createDefaultNotificationSettings();
  private updateMutex: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.settingsPath = getNotificationSettingsPath(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      this.settings = normalizeLoadedSettings(JSON.parse(raw) as unknown);
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[notification-settings] Failed to load settings from ${this.settingsPath}: ${message}`);
      }
      this.settings = createDefaultNotificationSettings();
    }
  }

  getSettings(): NotificationSettings {
    return {
      muteCliOriginatedNotifications: this.settings.muteCliOriginatedNotifications,
      updatedAt: this.settings.updatedAt,
    };
  }

  async update(payload: UpdateNotificationSettingsRequest | unknown): Promise<NotificationSettings> {
    const patch = normalizeUpdatePayload(payload);

    return this.withUpdateLock(async () => {
      const next: NotificationSettings = {
        muteCliOriginatedNotifications:
          patch.muteCliOriginatedNotifications === undefined
            ? this.settings.muteCliOriginatedNotifications
            : normalizeBoolean(patch.muteCliOriginatedNotifications, "muteCliOriginatedNotifications"),
        updatedAt: this.now().toISOString(),
      };

      await writeSettingsFile(this.settingsPath, next);
      this.settings = next;
      return this.getSettings();
    });
  }

  private async withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.updateMutex;
    let release: (() => void) | undefined;
    this.updateMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export async function isCliOriginatedSession(descriptor: AgentDescriptor | undefined): Promise<boolean> {
  if (!descriptor || descriptor.role !== "manager") {
    return false;
  }

  if (descriptor.cli?.createdBy === "forge-cli") {
    return true;
  }

  const latestUserInputChannel = await readLatestUserInputChannel(descriptor.sessionFile);
  return latestUserInputChannel === "cli";
}

export async function shouldMuteCliOriginatedNotifications(options: {
  settingsService: Pick<NotificationSettingsService, "getSettings">;
  descriptor: AgentDescriptor | undefined;
}): Promise<boolean> {
  if (!options.settingsService.getSettings().muteCliOriginatedNotifications) {
    return false;
  }

  return isCliOriginatedSession(options.descriptor);
}

interface UserInputChannelScan {
  ino: number;
  /** Byte offset just past the last complete line already scanned. */
  offset: number;
  channel: string | null;
}

// Checked on every assistant message, so rereading the whole transcript would be quadratic in session length.
// Each file is scanned once, then only appended complete lines; a replaced or truncated file is rescanned.
const userInputChannelScans = new Map<string, UserInputChannelScan>();
const MAX_TRACKED_SESSION_FILES = 2048;

const pendingUserInputChannelScans = new Map<string, Promise<string | null>>();

/** Scans of one file run in order so concurrent callers each read only what the previous scan left. */
function readLatestUserInputChannel(sessionFile: string): Promise<string | null> {
  const previous = pendingUserInputChannelScans.get(sessionFile);
  const next = (previous ?? Promise.resolve(null)).then(() => scanLatestUserInputChannel(sessionFile));
  pendingUserInputChannelScans.set(sessionFile, next);
  void next.finally(() => {
    if (pendingUserInputChannelScans.get(sessionFile) === next) pendingUserInputChannelScans.delete(sessionFile);
  });
  return next;
}

async function scanLatestUserInputChannel(sessionFile: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(sessionFile, "r");
    const stats = await handle.stat();
    const prior = userInputChannelScans.get(sessionFile);
    const scan = prior && prior.ino === stats.ino && prior.offset <= stats.size ? prior : { ino: stats.ino, offset: 0, channel: null };
    if (stats.size > scan.offset) {
      const appended = Buffer.alloc(stats.size - scan.offset);
      const { bytesRead } = await handle.read(appended, 0, appended.length, scan.offset);
      const lastNewline = appended.subarray(0, bytesRead).lastIndexOf(10);
      if (lastNewline >= 0) {
        const lines = appended.subarray(0, lastNewline).toString("utf8").split(/\r?\n/);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const channel = userInputChannel(lines[index]!);
          if (channel !== undefined) {
            scan.channel = channel;
            break;
          }
        }
        scan.offset += lastNewline + 1;
      }
    }
    userInputChannelScans.delete(sessionFile);
    if (userInputChannelScans.size >= MAX_TRACKED_SESSION_FILES) {
      userInputChannelScans.delete(userInputChannelScans.keys().next().value!);
    }
    userInputChannelScans.set(sessionFile, scan);
    return scan.channel;
  } catch (error) {
    userInputChannelScans.delete(sessionFile);
    if (!isEnoentError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[notification-settings] Failed to inspect CLI origin from ${sessionFile}: ${message}`);
    }
    return null;
  } finally {
    await handle?.close();
  }
}

/** The channel of a user-input conversation line, or undefined when the line is anything else. */
function userInputChannel(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = safeParseJsonObject(trimmed);
  if (
    parsed?.type === "conversation_message" &&
    parsed.source === "user_input" &&
    parsed.sourceContext &&
    typeof parsed.sourceContext === "object" &&
    !Array.isArray(parsed.sourceContext)
  ) {
    const channel = (parsed.sourceContext as { channel?: unknown }).channel;
    return typeof channel === "string" ? channel : "web";
  }
  return undefined;
}

function createDefaultNotificationSettings(): NotificationSettings {
  return {
    muteCliOriginatedNotifications: false,
    updatedAt: null,
  };
}

function normalizeLoadedSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultNotificationSettings();
  }

  const maybe = value as NotificationSettingsFile;
  return {
    muteCliOriginatedNotifications:
      maybe.muteCliOriginatedNotifications === undefined
        ? false
        : maybe.muteCliOriginatedNotifications === true,
    updatedAt: typeof maybe.updatedAt === "string" ? maybe.updatedAt : null,
  };
}

function normalizeUpdatePayload(payload: unknown): UpdateNotificationSettingsRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new NotificationSettingsValidationError("Request body must be a JSON object");
  }

  const maybe = payload as { muteCliOriginatedNotifications?: unknown };
  return {
    muteCliOriginatedNotifications:
      maybe.muteCliOriginatedNotifications === undefined
        ? undefined
        : normalizeBoolean(maybe.muteCliOriginatedNotifications, "muteCliOriginatedNotifications"),
  };
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new NotificationSettingsValidationError(`${field} must be a boolean`);
  }
  return value;
}

function safeParseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeSettingsFile(settingsPath: string, settings: NotificationSettings): Promise<void> {
  const payload = {
    version: SETTINGS_FILE_VERSION,
    muteCliOriginatedNotifications: settings.muteCliOriginatedNotifications,
    updatedAt: settings.updatedAt,
  } satisfies NotificationSettingsFile;

  await writeJsonFileAtomic(settingsPath, payload);
}

