#!/usr/bin/env node
// Opt-in, one-shot export of Forge V1 Cortex knowledge entries into plain memory files.
//
//   node scripts/forge-v2/export-knowledge-to-memory.mjs --data-dir <dir> [--dry-run]
//
// Global entries (shared/knowledge/entries/*.md) are appended to shared/knowledge/common.md.
// Profile entries (profiles/<id>/knowledge/entries/*.md) are appended to profiles/<id>/memory.md.
// Only active entries are exported. Each modified file is backed up first, and a marker line
// records the exported entry ids so a rerun never imports an entry twice. Nothing under
// shared/knowledge/** other than common.md (and its backup) is written, and nothing is deleted.

import { copyFile, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SECTION_HEADING = "## Imported knowledge (Forge V1)";
const MARKER_PREFIX = "<!-- forge-v1-knowledge-import:";
const MARKER_PATTERN = /<!-- forge-v1-knowledge-import:([^>]*)-->/g;
// Profiles whose memory Forge V2 never reads.
const RETIRED_PROFILE_IDS = new Set(["cortex", "_collaboration"]);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/forge-v2/export-knowledge-to-memory.mjs --data-dir <dir> [--dry-run]");
  process.exit(0);
}
if (!args.dataDir) {
  fail("--data-dir is required. The export never defaults to a live data directory.");
}

const dataDir = resolve(args.dataDir);
if (!(await isDirectory(dataDir))) {
  fail(`Data directory not found: ${dataDir}`);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const targets = [
  {
    label: "global",
    entriesDir: join(dataDir, "shared", "knowledge", "entries"),
    targetPath: join(dataDir, "shared", "knowledge", "common.md"),
    emptyHeader: "# Common Knowledge",
  },
];
for (const profileId of await listDirectories(join(dataDir, "profiles"))) {
  if (RETIRED_PROFILE_IDS.has(profileId)) continue;
  targets.push({
    label: `profile:${profileId}`,
    entriesDir: join(dataDir, "profiles", profileId, "knowledge", "entries"),
    targetPath: join(dataDir, "profiles", profileId, "memory.md"),
    emptyHeader: "# Profile Memory",
  });
}

let exitCode = 0;
let totalExported = 0;
for (const target of targets) {
  try {
    totalExported += await exportTarget(target);
  } catch (error) {
    exitCode = 1;
    console.error(`[${target.label}] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(
  `${args.dryRun ? "Dry run: would export" : "Exported"} ${totalExported} entr${totalExported === 1 ? "y" : "ies"} across ${targets.length} scope(s).`,
);
process.exit(exitCode);

async function exportTarget(target) {
  const entries = await readActiveEntries(target.entriesDir);
  if (entries.skipped > 0) {
    console.log(`[${target.label}] skipping ${entries.skipped} inactive or unreadable entr${entries.skipped === 1 ? "y" : "ies"}`);
  }
  if (entries.active.length === 0) {
    return 0;
  }

  const existing = await readOptional(target.targetPath);
  const alreadyImported = collectImportedIds(existing ?? "");
  const pending = entries.active.filter((entry) => !alreadyImported.has(entry.id));
  if (pending.length === 0) {
    console.log(`[${target.label}] up to date (${entries.active.length} entr${entries.active.length === 1 ? "y" : "ies"} already imported)`);
    return 0;
  }

  const backupPath = existing === undefined ? undefined : `${target.targetPath}.forge-v1-import-${timestamp}.bak`;
  console.log(
    `[${target.label}] ${args.dryRun ? "would append" : "appending"} ${pending.length} entr${pending.length === 1 ? "y" : "ies"} to ${target.targetPath}` +
      (backupPath ? ` (backup: ${backupPath})` : " (new file)"),
  );
  for (const entry of pending) {
    console.log(`  - ${entry.id}`);
  }
  if (args.dryRun) {
    return pending.length;
  }

  if (backupPath) {
    await copyFile(target.targetPath, backupPath);
  }
  const base = existing === undefined ? `${target.emptyHeader}\n` : existing;
  await writeAtomic(target.targetPath, `${base.trimEnd()}\n\n${renderSection(pending)}`);
  return pending.length;
}

async function readActiveEntries(entriesDir) {
  const active = [];
  let skipped = 0;
  let names = [];
  try {
    names = (await readdir(entriesDir)).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return { active, skipped };
    throw error;
  }

  for (const name of names) {
    const parsed = parseEntry(await readFile(join(entriesDir, name), "utf8"));
    const id = parsed?.frontmatter.id || name.replace(/\.md$/, "");
    const status = parsed?.frontmatter.status || "active";
    if (!parsed || status !== "active") {
      skipped += 1;
      continue;
    }
    active.push({
      id,
      title: parsed.frontmatter.title || id,
      type: parsed.frontmatter.type,
      body: parsed.body.trim(),
    });
  }
  return { active, skipped };
}

// Knowledge entries use a flat `key: value` YAML frontmatter; nested values (sources) are ignored.
function parseEntry(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return undefined;
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field || field[2] === "") continue;
    frontmatter[field[1]] = unquote(field[2].trim());
  }
  return { frontmatter, body: match[2] };
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function collectImportedIds(content) {
  const ids = new Set();
  for (const match of content.matchAll(MARKER_PATTERN)) {
    for (const id of match[1].trim().split(/\s+/)) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

function renderSection(entries) {
  const lines = [SECTION_HEADING, `${MARKER_PREFIX} ${entries.map((entry) => entry.id).join(" ")} -->`, ""];
  for (const entry of entries) {
    lines.push(`### ${entry.title}`);
    if (entry.body) {
      lines.push("", entry.body);
    }
    lines.push("", `_Source: \`${entry.id}\`${entry.type ? ` (${entry.type})` : ""}_`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path, content) {
  const tempPath = `${path}.forge-v1-import-${process.pid}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

async function listDirectories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const parsed = { dataDir: undefined, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--data-dir") parsed.dataDir = argv[++index];
    else if (arg.startsWith("--data-dir=")) parsed.dataDir = arg.slice("--data-dir=".length);
    else fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
