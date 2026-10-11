import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, type ReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { writeFileAtomic } from "../../utils/atomic-files.js";
import type { Database } from "better-sqlite3";
import type { ArtifactRef } from "@forge/protocol/environment-v2";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { ConversationAttachment, ConversationEntryEvent } from "../../swarm/types.js";
import { getEnvironmentArtifactDir, getUploadsDir } from "../../swarm/storage/data-paths.js";
import { trustPersistedConversationAttachment } from "../../swarm/conversation-attachment-service.js";
import type { Principal } from "./control-types.js";
import type { ArtifactPort, InputArtifact } from "./effect-types.js";

const MAX_FILE = 25 * 1024 * 1024;
const MAX_COMMAND = 50 * 1024 * 1024;
interface ArtifactRow {
  artifact_id: string; upload_id: string; device_session_id: string; project_id: string;
  file_name: string; mime_type: string; size_bytes: number; sha256: string; storage_name: string; created_at: number;
}
function error(code: string, message: string): Error & { code: string; retryable: boolean } { return Object.assign(new Error(message), { code, retryable: false }); }
function ref(row: ArtifactRow): ArtifactRef { return { artifactId: row.artifact_id, fileName: row.file_name, mimeType: row.mime_type, sizeBytes: row.size_bytes }; }
export interface ArtifactService extends ArtifactPort {
  upload(input: { principal: Principal; projectId: string; uploadId: string; fileName: string; mimeType: string; sizeBytes?: number; body: AsyncIterable<Uint8Array>; signal?: AbortSignal }): Promise<ArtifactRef>;
  prepareInternalInput(input: { commandId:string; threadId:string; projectId:string; attachments:readonly ConversationAttachment[] }): Promise<InputArtifact[]>;
  attachmentsForInput(inputId: string): Promise<ConversationAttachment[]>;
  prepareHistoricalArtifacts(sessionId: string, entries: readonly ConversationEntryEvent[]): Promise<void>;
  refsForEntry(sessionId: string, entry: ConversationEntryEvent): ArtifactRef[];
  openDownload(input: { principal: Principal; artifactId: string; range?: string; signal?: AbortSignal }): Promise<{ ref: ArtifactRef; stream: ReadStream; start: number; end: number; sizeBytes: number; partial: boolean }>;
  sweep(now?: number): Promise<void>;
}
export function createArtifactService({ database, dataDir, swarmManager }: { database: Database; dataDir: string; swarmManager?: Pick<SwarmManager, "getAgentForInternalUse"> }): ArtifactService {
  const directory = getEnvironmentArtifactDir(dataDir);
  function assertActive(principal: Principal, scope: "session:read" | "session:operate") {
    if (!principal.scopes.has(scope)) throw error("FORBIDDEN", "Artifact access requires the matching session scope.");
    const device = database.prepare("SELECT revoked_at, expires_at FROM device_sessions WHERE device_session_id=?").get(principal.deviceSessionId) as { revoked_at: number | null; expires_at: number } | undefined;
    if (!device || device.revoked_at !== null || device.expires_at <= Date.now()) throw error("UNAUTHENTICATED", "Device access is no longer active.");
  }
  function storagePath(row: ArtifactRow): string {
    if (basename(row.storage_name) !== row.storage_name || !/^[a-f0-9-]{36}$/.test(row.storage_name)) throw error("INTERNAL", "Artifact storage identity is invalid.");
    return join(directory, row.storage_name);
  }
  function authorized(row: ArtifactRow, principal: Principal, sessionId?: string): boolean {
    if (row.device_session_id === principal.deviceSessionId) return true;
    if (row.device_session_id.startsWith("history:")) {
      const historicalSession = row.device_session_id.slice("history:".length);
      const descriptor = swarmManager?.getAgentForInternalUse(historicalSession);
      if (descriptor && (descriptor.profileId ?? descriptor.agentId) === row.project_id && (!sessionId || sessionId === historicalSession)) return true;
    }
    const query = `SELECT 1 FROM input_artifacts a JOIN control_inputs i ON i.input_id=a.input_id WHERE a.artifact_id=?${sessionId ? " AND i.session_id=?" : ""} LIMIT 1`;
    return Boolean(database.prepare(query).get(...(sessionId ? [row.artifact_id, sessionId] : [row.artifact_id])));
  }
  const service: ArtifactService = {
    async upload(input) {
      assertActive(input.principal, "session:operate");
      if (!database.prepare("SELECT 1 FROM control_projects WHERE project_id=?").get(input.projectId)) throw error("NOT_FOUND", "Upload project is unavailable.");
      if (!input.uploadId || input.uploadId.length > 128 || !input.projectId || input.projectId.length > 128 || !input.fileName || input.fileName.length > 256 || /[\x00-\x1f]/.test(input.fileName) || input.mimeType.length > 256 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(input.mimeType)) throw error("INVALID_INPUT", "Artifact metadata is invalid.");
      if (input.sizeBytes !== undefined && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_FILE)) throw error("PAYLOAD_TOO_LARGE", "Artifact exceeds 25 MiB.");
      await mkdir(directory, { recursive: true });
      const artifactId = randomUUID(); const storageName = randomUUID();
      const target = join(directory, storageName);
      const hash = createHash("sha256"); let bytes = 0; let committed = false;
      try {
        async function* guardedBody() {
          for await (const chunk of input.body) {
            input.signal?.throwIfAborted(); bytes += chunk.byteLength;
            if (bytes > MAX_FILE) throw error("PAYLOAD_TOO_LARGE", "Artifact exceeds 25 MiB.");
            hash.update(chunk); yield chunk;
          }
          input.signal?.throwIfAborted();
          if (input.sizeBytes !== undefined && input.sizeBytes !== bytes) throw error("INVALID_INPUT", "Artifact length does not match its declared size.");
        }
        await writeFileAtomic(target, guardedBody(), { durable: true, mode: 0o600, beforeCommit: async () => { input.signal?.throwIfAborted(); assertActive(input.principal, "session:operate"); } });
        const sha256 = hash.digest("hex");
        const row: ArtifactRow = { artifact_id: artifactId, upload_id: input.uploadId, device_session_id: input.principal.deviceSessionId, project_id: input.projectId,
          file_name: input.fileName, mime_type: input.mimeType, size_bytes: bytes, sha256, storage_name: storageName, created_at: Date.now() };
        const result = database.transaction(() => {
          input.signal?.throwIfAborted(); assertActive(input.principal, "session:operate");
          const existing = database.prepare("SELECT * FROM artifacts WHERE device_session_id=? AND upload_id=?").get(input.principal.deviceSessionId, input.uploadId) as ArtifactRow | undefined;
          if (existing) {
            if (existing.sha256 !== sha256 || existing.file_name !== input.fileName || existing.mime_type !== input.mimeType || existing.project_id !== input.projectId || existing.size_bytes !== bytes) throw error("CONFLICT", "Upload ID already names different artifact bytes or metadata.");
            return ref(existing);
          }
          database.prepare(`INSERT INTO artifacts (artifact_id,upload_id,device_session_id,project_id,file_name,mime_type,size_bytes,sha256,storage_name,created_at)
            VALUES (@artifact_id,@upload_id,@device_session_id,@project_id,@file_name,@mime_type,@size_bytes,@sha256,@storage_name,@created_at)`).run(row);
          return ref(row);
        }).immediate();
        committed = result.artifactId === artifactId; return result;
      } finally {
        if (!committed) await rm(target, { force: true });
      }
    },
    validateInput(input) {
      assertActive(input.principal, "session:operate");
      if (input.artifactIds.length > 20 || new Set(input.artifactIds).size !== input.artifactIds.length) throw error("PAYLOAD_TOO_LARGE", "A command accepts at most 20 distinct artifacts.");
      let total = 0;
      return input.artifactIds.map(id => {
        const row = database.prepare("SELECT * FROM artifacts WHERE artifact_id=?").get(id) as ArtifactRow | undefined;
        if (!row || row.project_id !== input.projectId || !authorized(row, input.principal, input.sessionId)) throw error("NOT_FOUND", "Artifact is unavailable to this command.");
        try {
          const file = lstatSync(storagePath(row));
          if (!file.isFile() || file.size !== row.size_bytes) throw error("NOT_FOUND", "Artifact file is unavailable.");
        } catch { throw error("NOT_FOUND", "Artifact file is unavailable."); }
        total += row.size_bytes; if (total > MAX_COMMAND) throw error("PAYLOAD_TOO_LARGE", "Command attachments exceed 50 MiB.");
        return { artifactId: row.artifact_id };
      });
    },
    pinInput(inputId, rows: readonly InputArtifact[]) { const insert = database.prepare("INSERT OR IGNORE INTO input_artifacts (input_id,artifact_id) VALUES (?,?)"); for (const row of rows) insert.run(inputId, row.artifactId); },
    refsForEntry(sessionId, entry) {
      if (entry.type !== "conversation_message") return [];
      if (entry.controlCommandId) {
        return (database.prepare("SELECT a.* FROM artifacts a JOIN input_artifacts p ON p.artifact_id=a.artifact_id JOIN control_inputs i ON i.input_id=p.input_id WHERE i.command_id=? ORDER BY a.artifact_id").all(entry.controlCommandId) as ArtifactRow[]).map(ref);
      }
      return (entry.attachments ?? []).flatMap(attachment => {
        const fileRef = "fileRef" in attachment ? attachment.fileRef : undefined; if (!fileRef) return [];
        const row = database.prepare("SELECT * FROM artifacts WHERE device_session_id=? AND upload_id=?").get(`history:${sessionId}`, fileRef) as ArtifactRow | undefined;
        return row ? [ref(row)] : [];
      });
    },
    async prepareHistoricalArtifacts(sessionId, entries) {
      const descriptor = swarmManager?.getAgentForInternalUse(sessionId);
      if (!descriptor || descriptor.role !== "manager") return;
      const uploads = await realpath(getUploadsDir(dataDir)).catch((caught: NodeJS.ErrnoException) => { if (caught.code === "ENOENT") return null; throw caught; });
      if (!uploads) return;
      for (const entry of entries) {
        if (entry.type !== "conversation_message" || entry.controlCommandId) continue;
        for (const attachment of entry.attachments ?? []) {
          const fileRef = "fileRef" in attachment ? attachment.fileRef : undefined;
          if (!fileRef || fileRef !== basename(fileRef) || !/^[A-Za-z0-9._-]+$/.test(fileRef)) continue;
          if (database.prepare("SELECT 1 FROM artifacts WHERE device_session_id=? AND upload_id=?").get(`history:${sessionId}`, fileRef)) continue;
          const original = await realpath(join(uploads, fileRef)); const within = relative(uploads, original);
          if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw error("FORBIDDEN", "Historical attachment is outside its owned upload directory.");
          const info = await stat(original); if (info.size > MAX_FILE) throw error("PAYLOAD_TOO_LARGE", "Historical attachment exceeds 25 MiB.");
          const bytes = await readFile(original); if (bytes.length > MAX_FILE) throw error("PAYLOAD_TOO_LARGE", "Historical attachment exceeds 25 MiB.");
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const identity = createHash("sha256").update(`${sessionId}\n${fileRef}\n${sha256}`).digest("hex");
          const artifactId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
          const storageName = randomUUID(); const path = join(directory, storageName); let committed = false;
          try {
            await writeFileAtomic(path, bytes, { durable: true, mode: 0o600 });
            const row: ArtifactRow = { artifact_id: artifactId, upload_id: fileRef, device_session_id: `history:${sessionId}`, project_id: descriptor.profileId ?? descriptor.agentId,
              file_name: (attachment.fileName ?? fileRef).slice(0, 256), mime_type: attachment.mimeType.slice(0, 256), size_bytes: bytes.length, sha256, storage_name: storageName, created_at: Date.now() };
            const inserted = database.prepare(`INSERT OR IGNORE INTO artifacts (artifact_id,upload_id,device_session_id,project_id,file_name,mime_type,size_bytes,sha256,storage_name,created_at)
              VALUES (@artifact_id,@upload_id,@device_session_id,@project_id,@file_name,@mime_type,@size_bytes,@sha256,@storage_name,@created_at)`).run(row);
            committed = inserted.changes > 0;
          } finally { if (!committed) await rm(path, { force: true }); }
        }
      }
    },
    async prepareInternalInput(input) {
      if (input.attachments.length > 20) throw error("PAYLOAD_TOO_LARGE", "A command accepts at most 20 attachments.");
      await mkdir(directory, { recursive:true }); let total = 0;
      const result: InputArtifact[] = [];
      for (const [index, attachment] of input.attachments.entries()) {
        const bytes = attachment.type === "text" ? Buffer.from(attachment.text) : Buffer.from(attachment.data,"base64");
        total += bytes.length;
        if (bytes.length > MAX_FILE || total > MAX_COMMAND) throw error("PAYLOAD_TOO_LARGE", "Command attachments exceed their byte budget.");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const owner = `internal:${input.threadId}`; const uploadId = `${input.commandId}:${index}`;
        const prior = database.prepare("SELECT * FROM artifacts WHERE device_session_id=? AND upload_id=?").get(owner,uploadId) as ArtifactRow | undefined;
        if (prior) {
          if (prior.sha256 !== hash || prior.project_id !== input.projectId || prior.mime_type !== attachment.mimeType || prior.file_name !== (attachment.fileName ?? "attachment")) throw error("CONFLICT","Scoped attachment identity conflicts.");
          result.push({ artifactId:prior.artifact_id }); continue;
        }
        const row: ArtifactRow = { artifact_id:randomUUID(), upload_id:uploadId, device_session_id:owner, project_id:input.projectId,
          file_name:attachment.fileName ?? "attachment", mime_type:attachment.mimeType, size_bytes:bytes.length, sha256:hash, storage_name:randomUUID(), created_at:Date.now() };
        let committed = false;
        try {
          await writeFileAtomic(storagePath(row),bytes,{ durable:true,mode:0o600 });
          database.prepare("INSERT INTO artifacts (artifact_id,upload_id,device_session_id,project_id,file_name,mime_type,size_bytes,sha256,storage_name,created_at) VALUES (@artifact_id,@upload_id,@device_session_id,@project_id,@file_name,@mime_type,@size_bytes,@sha256,@storage_name,@created_at)").run(row);
          committed = true; result.push({ artifactId:row.artifact_id });
        } finally { if (!committed) await rm(storagePath(row),{ force:true }); }
      }
      return result;
    },
    async attachmentsForInput(inputId) {
      const rows = database.prepare("SELECT a.* FROM artifacts a JOIN input_artifacts i ON i.artifact_id=a.artifact_id WHERE i.input_id=? ORDER BY a.artifact_id").all(inputId) as ArtifactRow[];
      return Promise.all(rows.map(async row => {
        const path = storagePath(row); const bytes = await readFile(path);
        if (bytes.length !== row.size_bytes || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw error("CONFLICT", "Pinned artifact bytes have changed.");
        const attachment: ConversationAttachment = row.mime_type.startsWith("image/")
          ? { type: "image", mimeType: row.mime_type, data: bytes.toString("base64"), fileName: row.file_name, filePath: path }
          : row.mime_type.startsWith("text/") && bytes.length > 0
            ? { type: "text", mimeType: row.mime_type, text: bytes.toString("utf8"), fileName: row.file_name, filePath: path }
            : { type: "binary", mimeType: row.mime_type, data: bytes.toString("base64"), fileName: row.file_name, filePath: path };
        return trustPersistedConversationAttachment(attachment);
      }));
    },
    async openDownload(input) {
      assertActive(input.principal, "session:read");
      const row = database.prepare("SELECT * FROM artifacts WHERE artifact_id=?").get(input.artifactId) as ArtifactRow | undefined;
      if (!row || !authorized(row, input.principal)) throw error("NOT_FOUND", "Artifact is unavailable.");
      const path = storagePath(row); const size = (await stat(path)).size;
      if (size !== row.size_bytes || size > MAX_FILE) throw error("CONFLICT", "Artifact size has changed.");
      let start = 0; let end = Math.max(0, size - 1);
      if (input.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(input.range);
        if (!match || (!match[1] && !match[2])) throw error("INVALID_INPUT", "Only one bounded byte range is supported.");
        if (!match[1]) { const count = Number(match[2]); start = Math.max(0, size - count); } else { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size || end >= size) throw error("INVALID_INPUT", "Artifact byte range is outside the file.");
      }
      input.signal?.throwIfAborted();
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stream = file.createReadStream({ start, end });
      const abort = () => stream.destroy(); input.signal?.addEventListener("abort", abort, { once: true });
      stream.once("close", () => input.signal?.removeEventListener("abort", abort));
      return { ref: ref(row), stream, start, end, sizeBytes: size ? end - start + 1 : 0, partial: Boolean(input.range) };
    },
    async sweep(now = Date.now()) {
      await mkdir(directory, { recursive: true }); const cutoff = now - 86_400_000;
      const rows = database.prepare("SELECT * FROM artifacts WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM input_artifacts WHERE artifact_id=artifacts.artifact_id)").all(cutoff) as ArtifactRow[];
      for (const row of rows) {
        const removed = database.prepare("DELETE FROM artifacts WHERE artifact_id=? AND NOT EXISTS (SELECT 1 FROM input_artifacts WHERE artifact_id=?)").run(row.artifact_id, row.artifact_id);
        if (removed.changes) await rm(storagePath(row), { force: true });
      }
      for (const name of await readdir(directory)) {
        if (!/^\.staging-[a-f0-9-]{36}$/.test(name) && !/^[a-f0-9-]{36}\.\d+-\d+-[a-f0-9]+\.tmp$/.test(name) && !/^[a-f0-9-]{36}$/.test(name)) continue;
        if (database.prepare("SELECT 1 FROM artifacts WHERE storage_name=?").get(name)) continue;
        const path = join(directory, name); if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      }
    },
  };
  return service;
}
