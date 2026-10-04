import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const skillRoot = resolve(testDir, "..", "swarm", "skills", "builtins", "create-skill");
const scaffoldScriptPath = join(skillRoot, "scripts", "scaffold-skill.mjs");
const validateScriptPath = join(skillRoot, "scripts", "validate-skill.mjs");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("create-skill helper scripts", () => {
  it("scaffolds a global skill and validates the result", async () => {
    const tempRoot = await makeTempDir("create-skill-machine-local-");
    const dataDir = join(tempRoot, "data");

    const scaffold = await runJsonScript(scaffoldScriptPath, [
      "--name",
      "release-triage",
      "--description",
      "Summarize and triage incoming release requests.",
      "--scope",
      "machine-local",
      "--data-dir",
      dataDir,
    ]);

    expect(scaffold.exitCode).toBe(0);
    expect(scaffold.json).toMatchObject({
      ok: true,
      scope: "global",
      template: "minimal",
      skillName: "release-triage",
      location: join(dataDir, "skills", "release-triage"),
      created: ["SKILL.md"],
      warnings: [],
    });

    const skillFile = join(dataDir, "skills", "release-triage", "SKILL.md");
    const rawSkill = await readFile(skillFile, "utf8");
    expect(rawSkill).toContain("name: release-triage");
    expect(rawSkill).toContain("## Use this skill when");
    expect(rawSkill).toContain("## Workflow");

    const validation = await runJsonScript(validateScriptPath, [join(dataDir, "skills", "release-triage")]);
    expect(validation.exitCode).toBe(0);
    expect(validation.json.ok).toBe(true);
    expect(validation.json.errors).toEqual([]);
    expect(validation.json.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("TODO placeholder"),
      ]),
    );
  });

  it("refuses to overwrite a non-empty skill root without --force", async () => {
    const tempRoot = await makeTempDir("create-skill-overwrite-");
    const dataDir = join(tempRoot, "data");

    const firstRun = await runJsonScript(scaffoldScriptPath, [
      "--name",
      "deploy-notes",
      "--description",
      "Collect deploy notes for release handoff.",
      "--scope",
      "machine-local",
      "--data-dir",
      dataDir,
    ]);
    expect(firstRun.exitCode).toBe(0);

    const secondRun = await runJsonScript(scaffoldScriptPath, [
      "--name",
      "deploy-notes",
      "--description",
      "Collect deploy notes for release handoff.",
      "--scope",
      "machine-local",
      "--data-dir",
      dataDir,
    ]);
    expect(secondRun.exitCode).toBe(1);
    expect(secondRun.json).toMatchObject({
      ok: false,
      error: "Target skill root already exists and is not empty. Re-run with --force to overwrite scaffold-managed files.",
    });
  });

  it("fails safely when --force encounters a symlinked managed parent path", async () => {
    const tempRoot = await makeTempDir("create-skill-force-symlink-");
    const dataDir = join(tempRoot, "data");
    const targetRoot = join(dataDir, "skills", "danger-skill");
    const outsideDir = join(tempRoot, "outside");

    await mkdir(targetRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(targetRoot, "SKILL.md"), "# Existing\n", "utf8");
    await symlink(outsideDir, join(targetRoot, "scripts"));

    const scaffold = await runJsonScript(scaffoldScriptPath, [
      "--name",
      "danger-skill",
      "--description",
      "Attempt a forced overwrite.",
      "--scope",
      "machine-local",
      "--data-dir",
      dataDir,
      "--template",
      "scripted",
      "--force",
    ]);

    expect(scaffold.exitCode).toBe(1);
    expect(scaffold.json).toMatchObject({
      ok: false,
      error: "Managed parent path must not be a symlink.",
    });
    await expect(readFile(join(outsideDir, "main.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects multiline description injection in scaffolded frontmatter", async () => {
    const tempRoot = await makeTempDir("create-skill-multiline-description-");
    const dataDir = join(tempRoot, "data");

    const scaffold = await runJsonScript(scaffoldScriptPath, [
      "--name",
      "unsafe-description",
      "--description",
      "safe line\n---\nname: injected",
      "--scope",
      "machine-local",
      "--data-dir",
      dataDir,
    ]);

    expect(scaffold.exitCode).toBe(1);
    expect(scaffold.json).toMatchObject({
      ok: false,
      error: "Description must be a single line and must not contain YAML frontmatter delimiters.",
    });
  });

  it("rejects symlinked references whose targets escape the skill root", async () => {
    const tempRoot = await makeTempDir("create-skill-validate-symlink-ref-");
    const skillDir = join(tempRoot, "symlink-ref-skill");
    const referencesDir = join(skillDir, "references");
    const outsideFile = join(tempRoot, "outside.md");

    await mkdir(referencesDir, { recursive: true });
    await writeFile(outsideFile, "outside\n", "utf8");
    await symlink(outsideFile, join(referencesDir, "outside.md"));
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: symlink-ref-skill",
        "description: Validation coverage for symlinked references.",
        "---",
        "",
        "# Symlink Ref Skill",
        "",
        "## Use this skill when",
        "- symlink reference validation is needed",
        "",
        "## Do not use this skill when",
        "- in-root references are available",
        "",
        "## Workflow",
        "1. Read `references/outside.md` before proceeding.",
        "",
        "## Guardrails",
        "- Keep references inside the skill root.",
        "",
        "## Output",
        "- Summary:",
        "",
      ].join("\n"),
      "utf8",
    );

    const validation = await runJsonScript(validateScriptPath, [skillDir]);
    expect(validation.exitCode).toBe(1);
    expect(validation.json.ok).toBe(false);
    expect(validation.json.errors).toEqual(
      expect.arrayContaining(["Reference escapes skill root: references/outside.md"]),
    );
  });
});

async function runJsonScript(scriptPath: string, args: string[], options: { cwd?: string } = {}) {
  try {
    const result = await execFile(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
    });

    return {
      exitCode: 0,
      json: JSON.parse(result.stdout),
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      json: JSON.parse(failure.stdout ?? "{}"),
      stderr: failure.stderr ?? "",
    };
  }
}

async function makeTempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const canonicalPath = await realpath(path);
  tempDirs.push(canonicalPath);
  return canonicalPath;
}
