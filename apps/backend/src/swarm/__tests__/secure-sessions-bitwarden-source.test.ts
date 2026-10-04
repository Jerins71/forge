import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BwsCommandClient } from "../secure-sessions/sources/bitwarden-bws-source.js";

import { SecureSourceError } from "../secure-sessions/sources/host-only-secret.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function createFakeBws(source: string, executableName = "fake-bws") {
  const root = await mkdtemp(join(tmpdir(), "forge-bws-source-test-"));
  temporaryRoots.push(root);
  const executable = join(root, executableName);
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, {
    mode: 0o700,
  });
  await chmod(executable, 0o700);
  return { executable, root };
}

function errorEvidence(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return JSON.stringify({
    name: error.name,
    message: error.message,
    code: "code" in error ? error.code : undefined,
    stack: error.stack,
  });
}

describe("BwsCommandClient", () => {
  it("authenticates with a read-only output-none project list and never puts the token in argv", async () => {
    const captureRoot = await mkdtemp(join(tmpdir(), "forge-bws-capture-"));
    temporaryRoots.push(captureRoot);
    const capturePath = join(captureRoot, "invocations.jsonl");
    const token = `0.${randomUUID()}.test-token-material`;
    const { executable } = await createFakeBws(
      [
        'const fs = require("node:fs");',
        `const capturePath = ${JSON.stringify(capturePath)};`,
        `const expectedToken = ${JSON.stringify(token)};`,
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(capturePath, JSON.stringify({",
        "  args,",
        "  tokenPresent: process.env.BWS_ACCESS_TOKEN === expectedToken,",
        "  home: process.env.HOME,",
        "  configHome: process.env.XDG_CONFIG_HOME,",
        '}) + "\\n");',
        'if (args[0] === "config") process.exit(0);',
        'if (args.join("\\u0000") !== ["project", "list", "--output", "none", "--config-file", args[5]].join("\\u0000")) process.exit(23);',
        'process.stdout.write("discarded-provider-metadata");',
        'process.stderr.write("discarded-provider-warning");',
        "process.exit(0);",
      ].join("\n"),
    );

    await expect(
      new BwsCommandClient(executable, 1_000).testConnection({
        accessToken: Buffer.from(token),
        endpointOrigin: "https://vault.example.test/some/path",
      }),
    ).resolves.toBeUndefined();

    const invocations = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        args: string[];
        tokenPresent: boolean;
        home: string;
        configHome: string;
      });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.args).toEqual([
      "config",
      "server-base",
      "https://vault.example.test",
      "--config-file",
      expect.any(String),
    ]);
    expect(invocations[0]?.tokenPresent).toBe(false);
    expect(invocations[1]?.args).toEqual([
      "project",
      "list",
      "--output",
      "none",
      "--config-file",
      expect.any(String),
    ]);
    expect(invocations[1]?.tokenPresent).toBe(true);
    expect(invocations[1]?.args.join(" ")).not.toContain(token);
    expect(invocations[1]?.home).toBe(invocations[1]?.configHome);
  });

  it("discards malicious provider output and maps nonzero authentication failures safely", async () => {
    const captureRoot = await mkdtemp(join(tmpdir(), "forge-bws-capture-"));
    temporaryRoots.push(captureRoot);
    const argvPath = join(captureRoot, "argv.json");
    const token = `0.${randomUUID()}.must-not-surface`;
    const { executable } = await createFakeBws(
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
        'process.stdout.write(process.env.BWS_ACCESS_TOKEN ?? "");',
        'process.stderr.write(process.env.BWS_ACCESS_TOKEN ?? "");',
        "process.exit(9);",
      ].join("\n"),
    );

    let thrown: unknown;
    try {
      await new BwsCommandClient(executable, 1_000).testConnection({
        accessToken: Buffer.from(token),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "SECURE_SOURCE_AUTH_REQUIRED",
    } satisfies Partial<SecureSourceError>);
    expect(errorEvidence(thrown)).not.toContain(token);
    expect(await readFile(argvPath, "utf8")).not.toContain(token);
  });
});
