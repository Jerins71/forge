import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectAgentDir, sanitizePathSegment } from "../data-paths.js";

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
