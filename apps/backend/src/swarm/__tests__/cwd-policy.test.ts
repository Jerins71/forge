import { access, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectory, listDirectories, validateDirectory, validateDirectoryPath, type CwdPolicy } from "../cwd-policy.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cwd-policy", () => {
  describe("allowlist enforcement", () => {
    it("fails closed when no usable roots are configured", async () => {
      const root = await makeTempDir("cwd-empty-");
      const policy: CwdPolicy = {
        rootDir: root,
        allowlistRoots: [],
        enforceAllowlist: true,
      };

      await expect(listDirectories(undefined, policy)).rejects.toMatchObject({
        code: "DIRECTORY_NO_ROOTS",
      });
      const validation = await validateDirectory(root, policy);
      expect(validation.valid).toBe(false);
      expect(validation.message).toMatch(/FORGE_CWD_ALLOWLIST_ROOTS/);
    });

    it("accepts paths inside configured roots and denies outside", async () => {
      const allowed = await makeTempDir("cwd-allowed-");
      const nested = join(allowed, "project");
      await mkdir(nested);
      const outside = await makeTempDir("cwd-denied-");

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(validateDirectoryPath(nested, policy)).resolves.toBe(nested);
      await expect(validateDirectoryPath(outside, policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });

      const listed = await listDirectories(undefined, policy);
      expect(listed.roots).toEqual([allowed]);
      expect(listed.directories.map((entry) => entry.path)).toContain(allowed);
      expect(listed.parentPath).toBeNull();
    });

    it("rejects .. traversal and absolute escape", async () => {
      const allowed = await makeTempDir("cwd-trav-");
      const nested = join(allowed, "nested");
      await mkdir(nested);
      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(validateDirectoryPath(join(nested, "..", ".."), policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });
    });

    it("rejects validating a symlink that escapes the root", async () => {
      const allowed = await makeTempDir("cwd-sym-val-");
      const outside = await makeTempDir("cwd-sym-val-out-");
      const escapeLink = join(allowed, "escape");
      await symlink(outside, escapeLink);

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(validateDirectoryPath(escapeLink, policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });
    });
  });

  describe("createDirectory", () => {
    it("aborts parent-replacement TOCTOU to an outside symlink and leaves no orphan outside roots", async () => {
      const allowed = await makeTempDir("cwd-mkdir-toctou-");
      const parent = join(allowed, "parent");
      await mkdir(parent);
      const outside = await makeTempDir("cwd-mkdir-toctou-out-");
      const folderName = "orphan-probe";
      const outsideOrphan = join(outside, folderName);

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(
        createDirectory(parent, folderName, policy, {
          beforeMkdir: async () => {
            await rm(parent, { recursive: true, force: true });
            await symlink(outside, parent);
          },
        }),
      ).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });

      await expect(access(outsideOrphan)).rejects.toMatchObject({ code: "ENOENT" });
      // Symlink parent path must also not retain the created name.
      await expect(access(join(parent, folderName))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
