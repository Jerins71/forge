import { writeFileAtomic } from "../../utils/atomic-files.js";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizePathSegment } from "./data-paths.js";
import { isEnoentError } from "../../utils/fs-errors.js";

export interface ReferenceDocMetadata {
  fileName: string;
  path: string;
}

export async function readPromptFile(promptPath: string): Promise<string | null> {
  try {
    return await readFile(promptPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writePromptFile(promptPath: string, content: string): Promise<void> {
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, content, "utf8");
}

export async function listReferenceDocs(referenceDir: string): Promise<ReferenceDocMetadata[]> {
  try {
    const entries = await readdir(referenceDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        fileName: entry.name,
        path: join(referenceDir, entry.name)
      }))
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }
}

export async function readReferenceDoc(referenceDir: string, filename: string): Promise<string | null> {
  const targetPath = getReferenceDocPath(referenceDir, filename);
  await assertReferencePath(targetPath, referenceDir);

  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writeReferenceDoc(referenceDir: string, filename: string, content: string): Promise<void> {
  const targetPath = getReferenceDocPath(referenceDir, filename);
  await assertReferencePath(targetPath, referenceDir);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFileAtomic(targetPath, ensureTrailingNewline(content.trimEnd()), { durable: true, beforeCommit: () => assertReferencePath(targetPath, referenceDir) });
}

export async function deleteReferenceDoc(referenceDir: string, filename: string): Promise<void> {
  const targetPath = getReferenceDocPath(referenceDir, filename);
  await assertReferencePath(targetPath, referenceDir);

  try {
    await rm(targetPath, { force: false });
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }

    throw error;
  }
}

function getReferenceDocPath(referenceDir: string, filename: string): string {
  if (filename === "." || filename === ".." || sanitizePathSegment(filename) !== filename)
    throw Object.assign(new Error("Invalid reference filename"), { code: "INVALID_INPUT" });
  return join(referenceDir, filename);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}


async function assertReferencePath(path: string, referenceDir: string): Promise<void> {
  // Reference roots and files must not redirect outside their file-backed owner.
  for (let current = path; current !== dirname(dirname(referenceDir)); current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Object.assign(new Error("Reference symlinks are unavailable"), { code: "FORBIDDEN" }); }
    catch (error) { if (!isEnoentError(error)) throw error; }
  }
}
