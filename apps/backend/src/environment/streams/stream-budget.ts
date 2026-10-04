import { V2_LIMITS, type RpcError } from "@forge/protocol/environment-v2";

export const SNAPSHOT_BYTES = 512 * 1024;
export const EVENT_BYTES = 64 * 1024;
export const LEASE_BYTES = 8 * 1024 * 1024;

export class StreamFault extends Error {
  constructor(readonly code: RpcError["code"], message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The same cap bounds live buffering while a snapshot is being paged. */
export class StreamQueue<T> implements AsyncIterable<T> {
  private items: { item: T; bytes: number }[] = [];
  private bytes = 0;
  private wake: (() => void) | undefined;
  private ended = false;
  private error: Error | undefined;

  constructor(private readonly onFailure?: (error: unknown) => void) {}

  push(item: T): void {
    if (this.ended) return;
    const bytes = encodedBytes(item);
    if (this.items.length >= V2_LIMITS.socketQueueFrames || this.bytes + bytes > V2_LIMITS.socketQueueBytes) {
      this.fail(new StreamFault("RESYNC_REQUIRED", "Stream buffer exceeded its budget."));
      return;
    }
    this.items.push({ item, bytes });
    this.bytes += bytes;
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error : new Error("Stream failed.");
    this.items = [];
    this.bytes = 0;
    this.end();
    this.onFailure?.(error);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.error) throw this.error;
      const entry = this.items.shift();
      if (entry) {
        this.bytes -= entry.bytes;
        yield entry.item;
      } else if (this.ended) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
