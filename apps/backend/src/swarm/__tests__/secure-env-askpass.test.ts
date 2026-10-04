import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HELPER_PATH = fileURLToPath(
  new URL(
    "../secure-sessions/execution/forge-env-askpass",
    import.meta.url,
  ),
);

function resolvePosixShell(): string {
  if (process.platform !== "win32") return "/bin/sh";
  const programDirectories = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
  ];
  for (const directory of programDirectories) {
    if (directory === undefined) continue;
    const candidate = join(directory, "Git", "bin", "sh.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "sh";
}

const POSIX_SHELL = resolvePosixShell();

describe("secure runner environment askpass bridge", () => {
  it("returns only the selected authorized environment value", () => {
    const result = spawnSync(
      POSIX_SHELL,
      [HELPER_PATH, "Password:"],
      {
        encoding: "utf8",
        env: {
          FORGE_ASKPASS_ENV: "FORGE_SECRET_SSH_PASSWORD_A1B2",
          FORGE_SECRET_SSH_PASSWORD_A1B2: "ssh-canary-value",
          UNRELATED_SECRET: "must-not-be-returned",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ssh-canary-value\n");
    expect(result.stdout).not.toContain("must-not-be-returned");
    expect(result.stderr).toBe("");
  });

  it("fails without output when the selected variable is absent", () => {
    const result = spawnSync(
      POSIX_SHELL,
      [HELPER_PATH, "Password:"],
      {
        encoding: "utf8",
        env: { FORGE_ASKPASS_ENV: "FORGE_SECRET_MISSING" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
