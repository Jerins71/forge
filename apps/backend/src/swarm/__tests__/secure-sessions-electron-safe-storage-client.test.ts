import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ElectronSafeStorageClient } from "../secure-sessions/sources/electron-safe-storage-client.js";
import { SecureSourceError } from "../secure-sessions/sources/host-only-secret.js";

class FakeTransport extends EventEmitter {
  sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }
}

describe("ElectronSafeStorageClient", () => {
  it("round trips encrypted bytes without exposing a serializable HostOnlySecret", async () => {
    const transport = new FakeTransport();
    const client = new ElectronSafeStorageClient(transport as never, 100);
    const encrypt = client.encrypt(Buffer.from("opaque"), "encrypt-1");
    transport.emit("message", {
      type: "secure_vault_response",
      requestId: "encrypt-1",
      ok: true,
      result: { payload: Buffer.from("cipher").toString("base64") },
    });
    await expect(encrypt).resolves.toEqual(Buffer.from("cipher"));

    const decrypt = client.decrypt(Buffer.from("cipher"), "decrypt-1");
    transport.emit("message", {
      type: "secure_vault_response",
      requestId: "decrypt-1",
      ok: true,
      result: { payload: Buffer.from("opaque").toString("base64") },
    });
    const decrypted = await decrypt;
    await expect(
      decrypted.material.withBytes((bytes) => bytes.toString("utf8")),
    ).resolves.toBe("opaque");
    expect(() => JSON.stringify(decrypted.material)).toThrow(
      "SECURE_SECRET_SERIALIZATION_BLOCKED",
    );
    decrypted.material.release();
    await expect(
      decrypted.material.withBytes(() => undefined),
    ).rejects.toThrow("SECURE_SECRET_RELEASED");
    client.dispose();
  });

  it("maps insecure storage to a value-free unavailable error", async () => {
    const transport = new FakeTransport();
    const client = new ElectronSafeStorageClient(transport as never, 100);
    const request = client.status();
    transport.emit("message", {
      type: "secure_vault_response",
      requestId: (transport.sent[0] as { requestId: string }).requestId,
      ok: false,
      errorCode: "SECURE_VAULT_INSECURE_STORAGE",
    });
    await expect(request).rejects.toMatchObject<Partial<SecureSourceError>>({
      code: "SECURE_SOURCE_UNAVAILABLE",
    });
    client.dispose();
  });
});
