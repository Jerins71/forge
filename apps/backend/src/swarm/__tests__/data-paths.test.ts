import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getHostInstallationStateDir, getProjectAgentDir, sanitizePathSegment } from "../data-paths.js";

const DATA_DIR = join(tmpdir(), "forge-data");
const PROFILE_ID = "feature-manager";

describe("data-paths", () => {
  it("sanitizePathSegment rejects traversal and path-unsafe input", () => {
    expect(sanitizePathSegment(" feature-manager ")).toBe("feature-manager");

    expect(() => sanitizePathSegment("../etc/passwd")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("..\\evil")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("nested/segment")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("nested\\segment")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment(`bad${String.fromCharCode(0)}id`)).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("CON")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("NUL")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("COM1")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("LPT1")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("aux.txt")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("bad:name")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("bad*name")).toThrow(/Invalid path segment/);
  });

  it("getProjectAgentDir rejects traversal handles", () => {
    expect(() => getProjectAgentDir(DATA_DIR, PROFILE_ID, "../escape")).toThrow(/Invalid path segment/);
  });
});

const isolatedInstallation = join(tmpdir(), "forge-installation-test");
describe("installation state isolation", () => {
  it.each(["darwin", "linux", "win32"] as const)("uses one explicit absolute override on %s", platform => {
    expect(getHostInstallationStateDir(platform, { FORGE_INSTALLATION_STATE_DIR: isolatedInstallation })).toBe(isolatedInstallation);
  });
  it("rejects relative and empty overrides before any filesystem write", () => {
    for (const value of ["relative", "", "   "]) expect(() => getHostInstallationStateDir(process.platform, { FORGE_INSTALLATION_STATE_DIR: value })).toThrow(/absolute/);
  });
  it("preserves platform defaults for an ordinary isolated home", () => {
    const home = join(tmpdir(), "forge-synthetic-home");
    expect(getHostInstallationStateDir("darwin", {}, home)).toBe(join(home, "Library", "Application Support", "Forge", "installation"));
    expect(getHostInstallationStateDir("linux", {}, home)).toBe(join(home, ".local", "state", "forge", "installation"));
    expect(getHostInstallationStateDir("win32", {}, home)).toBe(join(home, "AppData", "Local", "Forge", "installation"));
  });
  it("fails a test that would resolve the real installation directory, including explicit overrides", () => {
    const home = homedir();
    const real = process.platform === "darwin" ? join(home, "Library", "Application Support", "Forge", "installation")
      : process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Forge", "installation")
      : join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "forge", "installation");
    expect(() => getHostInstallationStateDir(process.platform, {}, home)).toThrow(/real.*installation/i);
    expect(() => getHostInstallationStateDir(process.platform, { FORGE_INSTALLATION_STATE_DIR: real }, home)).toThrow(/real.*installation/i);
  });
});
