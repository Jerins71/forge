import { describe, expect, it } from "vitest";
import { boundCodexMcpToolUiPreview, MAX_CODEX_MCP_UI_PREVIEW_BYTES } from "../codex-app-server/codex-mcp-args.js";

describe("boundCodexMcpToolUiPreview", () => {
  it("redacts secrets and caps persisted UI preview size", () => {
    const preview = boundCodexMcpToolUiPreview(
      `adam@secret.com Bearer sk-live-abcdef1234567890 meeting notes ${"x".repeat(8_000)}`,
    );

    expect(preview).toContain("[redacted]");
    expect(preview).not.toContain("adam@secret.com");
    expect(preview).not.toContain("sk-live-abcdef1234567890");
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(MAX_CODEX_MCP_UI_PREVIEW_BYTES);
  });
});
