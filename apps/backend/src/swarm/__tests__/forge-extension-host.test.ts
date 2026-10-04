import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import type { AgentDescriptor } from "../types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ForgeExtensionHost", () => {
  it("does not load untrusted repo-root Forge extensions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-repo-"));
    tempDirs.push(rootDir);
    await execFileAsync("git", ["init"], { cwd: rootDir });
    const dataDir = join(rootDir, "data");
    const repoExtensionDir = join(rootDir, ".forge", "extensions");
    await mkdir(repoExtensionDir, { recursive: true });
    await writeFile(join(repoExtensionDir, "repo.ts"), `export default (forge) => forge.on("tool:before", () => undefined)`, "utf8");

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createManagerDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });

    expect(bindings).toBeNull();
  });

  it("loads trusted repo-root Forge extensions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-repo-"));
    tempDirs.push(rootDir);
    await execFileAsync("git", ["init"], { cwd: rootDir });
    const dataDir = join(rootDir, "data");
    const repoForgeDir = join(rootDir, ".forge");
    const repoExtensionDir = join(repoForgeDir, "extensions");
    await mkdir(repoExtensionDir, { recursive: true });
    await writeFile(join(repoExtensionDir, "repo.ts"), `export default (forge) => forge.on("tool:before", () => undefined)`, "utf8");
    await mkdir(join(dataDir, "shared", "config"), { recursive: true });
    await writeFile(
      join(dataDir, "shared", "config", "project-resources.json"),
      JSON.stringify({ version: 1, overrides: {}, executableTrust: { [await realpath(repoForgeDir)]: { state: "trusted", updatedAt: "now", label: "forge" } }, dismissedExecutablePrompts: {} }),
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createManagerDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });

    expect(bindings?.snapshot.extensions).toEqual([
      expect.objectContaining({ path: await realpath(join(repoExtensionDir, "repo.ts")), scope: "project-local" })
    ]);
  });

  it("reloads extension code on the next runtime binding boundary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    const extensionPath = join(extensionsDir, "rewrite.ts");
    await mkdir(extensionsDir, { recursive: true });

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });

    await writeFile(
      extensionPath,
      `
      export default (forge) => {
        forge.on("tool:before", () => ({ input: { command: "first" } }))
      }
      `,
      "utf8"
    );

    const firstBindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(firstBindings!);

    await expect(
      host.dispatchToolBefore(firstBindings!.bindingToken, {
        toolName: "bash",
        toolCallId: "tool-reload-1",
        input: { command: "original" }
      })
    ).resolves.toEqual({ input: { command: "first" } });

    host.deactivateRuntimeBindings(firstBindings!.bindingToken);

    await writeFile(
      extensionPath,
      `
      export default (forge) => {
        forge.on("tool:before", () => ({ input: { command: "second" } }))
      }
      `,
      "utf8"
    );

    const secondBindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 2
    });
    host.activateRuntimeBindings(secondBindings!);

    await expect(
      host.dispatchToolBefore(secondBindings!.bindingToken, {
        toolName: "bash",
        toolCallId: "tool-reload-2",
        input: { command: "original" }
      })
    ).resolves.toEqual({ input: { command: "second" } });
  });
});

function createDescriptor(rootDir: string): AgentDescriptor {
  return {
    agentId: "worker-1",
    displayName: "Worker 1",
    role: "worker",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    cwd: rootDir,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high"
    },
    sessionFile: join(rootDir, "session.jsonl")
  };
}

function createManagerDescriptor(rootDir: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    ...createDescriptor(rootDir),
    agentId: "manager-1",
    displayName: "Session 1",
    role: "manager",
    managerId: "manager-1",
    profileId: "profile-1",
    sessionLabel: "Session 1",
    sessionFile: join(rootDir, "manager-session.jsonl"),
    ...overrides
  };
}
