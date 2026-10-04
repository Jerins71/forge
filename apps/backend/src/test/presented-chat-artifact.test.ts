import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatArtifactError, MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES, PresentedChatArtifactTicketStore, canonicalizeChatArtifactPath, canonicalizePresentedLinkHrefForPlatform, extractPresentedArtifactPaths, findUniquePresentedConversationMessage, readPresentedChatArtifact, securelyReadPresentedArtifact } from "../swarm/session/presented-chat-artifact.js";
import { getSessionFilePath } from "../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../swarm/session/conversation-timeline.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })))); });
async function fixture() {
  const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir();
  const dataDir = await mkdtemp(join(tempRoot, "forge-chat-artifact-")); roots.push(dataDir);
  const agentId = "manager"; const profileId = "profile"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId);
  await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
  const manager: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: dataDir };
  const profiles = [{ profileId }];
  const source: any = { getAgent: (id: string) => id === agentId ? manager : undefined, listProfiles: () => profiles, getConfig: () => ({ paths: { dataDir } }) };
  return { dataDir, agentId, profileId, sessionFile, manager, profiles, source };
}
function line(data: any, id = data.id) { return JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id, data }) + "\n"; }
function message(id: string | undefined, text: string, source = "speak_to_user", role = "assistant") { return { type: "conversation_message", id, agentId: "some-other-actor", role, source, text, timestamp: new Date().toISOString() }; }
async function errorCode(fn: () => Promise<unknown>) { try { await fn(); } catch (error) { expect(error).toBeInstanceOf(ChatArtifactError); return (error as ChatArtifactError).code; } throw new Error("expected failure"); }

describe("presented chat artifact authorization", () => {

  it("requires a unique ID and rejects corrupt JSONL", async () => {
    const f = await fixture(); const target = join(f.dataDir, "a.txt"); await writeFile(target, "a");
    await writeFile(f.sessionFile, line(message("same", `[x](swarm-file://${target})`)) + line(message("same", `[x](swarm-file://${target})`)));
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "same", path: target }))).toBe("ambiguous_message_id");
    await writeFile(f.sessionFile, "not json\n");
    expect(await errorCode(() => findUniquePresentedConversationMessage(f.sessionFile, "same"))).toBe("corrupt_transcript");
  });

  it("only accepts presented link tokens and exact canonical paths", async () => {
    const f = await fixture(); const target = join(f.dataDir, "my file?.txt"); await writeFile(target, "a");
    await writeFile(f.sessionFile, line(message("m", `[x](<swarm-file://${target.replace("?", "%3F")}> "t") and \`${target}\` and ![x](${target})`)));
    expect((await readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }) as any).content).toBe("a");
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: `${target}x` }))).toBe("path_not_presented");
    await writeFile(f.sessionFile, line(message("escaped", `\\[artifact:${target}]`)));
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "escaped", path: target }))).toBe("path_not_presented");
    expect(extractPresentedArtifactPaths(`[x](file://${target})`)).toEqual([]);
    expect(canonicalizePresentedLinkHrefForPlatform("swarm-file:///tmp/a%252Fz")).toBe(canonicalizeChatArtifactPath("/tmp/a%2Fz"));
    expect(canonicalizePresentedLinkHrefForPlatform("swarm-file:///tmp/%")).toBeUndefined();
    expect(() => canonicalizeChatArtifactPath("//host/share")).toThrow(ChatArtifactError);
  });

  it("issues bounded one-use image capabilities and denies expiry, binding mismatch, and identity races", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const image = join(f.dataDir, "ticket.png");
    await writeFile(image, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES, 0x89));
    await writeFile(f.sessionFile, line(message("ticket", `[image](swarm-file://${image})`)));
    let now = 1_000;
    let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      now: () => now,
      ttlMs: 100,
      createToken: () => `ticket_token_${String(sequence++).padStart(4, "0")}`,
    });
    const issue = async (binding = "user-a") => readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "ticket",
      path: image,
      imageTransport: "http_ticket",
    }, { ticketStore: store, ticketAuthBinding: binding }) as Promise<any>;

    const first = await issue();
    expect(first).toMatchObject({
      binary: true,
      transport: "http_ticket",
      contentType: "image/png",
      totalBytes: MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES,
    });
    expect(first).not.toHaveProperty("content");
    const firstToken = first.ticket.url.split("/").at(-1)!;
    await expect(store.redeem(firstToken, "user-a")).resolves.toMatchObject({ totalBytes: MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES });
    expect(await errorCode(() => store.redeem(firstToken, "user-a"))).toBe("ticket_not_found");

    const wrongBinding = await issue();
    const wrongBindingToken = wrongBinding.ticket.url.split("/").at(-1)!;
    expect(await errorCode(() => store.redeem(wrongBindingToken, "user-b"))).toBe("ticket_not_found");
    await expect(store.redeem(wrongBindingToken, "user-a")).resolves.toMatchObject({ totalBytes: MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES });

    const concurrent = await issue();
    const concurrentToken = concurrent.ticket.url.split("/").at(-1)!;
    const concurrentResults = await Promise.allSettled([
      store.redeem(concurrentToken, "user-a"),
      store.redeem(concurrentToken, "user-a"),
    ]);
    expect(concurrentResults.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const concurrentFailure = concurrentResults.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(concurrentFailure.reason).toMatchObject({ code: "ticket_not_found" });

    const expired = await issue(); now += 101;
    expect(await errorCode(() => store.redeem(expired.ticket.url.split("/").at(-1)!, "user-a"))).toBe("ticket_expired");

    now = 2_000;
    const raced = await issue();
    const replacement = join(f.dataDir, "replacement.png"); await writeFile(replacement, Buffer.alloc(8, 0x42)); await rename(replacement, image);
    expect(await errorCode(() => store.redeem(raced.ticket.url.split("/").at(-1)!, "user-a"))).toBe("file_identity_changed");

    await writeFile(image, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES + 1, 0x89));
    expect(await errorCode(() => issue())).toBe("file_too_large");
  });

  it("rejects final and parent symlinks and reads only ordinary files", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const target = join(f.dataDir, "target"); await writeFile(target, "safe"); const link = join(f.dataDir, "link"); await symlink(target, link);
    expect(await errorCode(() => securelyReadPresentedArtifact(link))).toBe("unsafe_file_identity");
    const dir = join(f.dataDir, "dir"); await mkdir(dir); await symlink(f.dataDir, join(dir, "parent"));
    expect(await errorCode(() => securelyReadPresentedArtifact(join(dir, "parent", "target")))).toBe("unsafe_file_identity");
  });
});
