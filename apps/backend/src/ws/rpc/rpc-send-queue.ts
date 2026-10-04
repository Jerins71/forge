import { WebSocket } from "ws";
import { V2_LIMITS, type RpcServerFrame } from "@forge/protocol/environment-v2";
import { serverFrameValidator } from "./rpc-dispatcher.js";

interface QueuedFrame { json: string; bytes: number; priority: number; subscriptionId?: string }

/** Bounded scheduling preserves each subscription's receive order across priorities. */
export class RpcSendQueue {
  private frames: QueuedFrame[] = [];
  private bytes = 0;
  private sending = false;
  private inFlightBytes = 0;
  private sendTimeout: NodeJS.Timeout | undefined;
  private stopped = false;
  private blocked: NodeJS.Timeout | undefined;
  private stalledAt: number | undefined;

  constructor(private readonly socket: WebSocket, private readonly overflow: (subscriptionId: string) => void) {}

  enqueue(frame: RpcServerFrame, priority = 0): boolean {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) return false;
    if (!serverFrameValidator.Check(frame)) throw new Error("Invalid RPC server envelope");
    const json = JSON.stringify(frame);
    const bytes = Buffer.byteLength(json);
    const subscriptionId = frame.type === "stream" ? frame.subscriptionId : undefined;
    const owned = subscriptionId ? this.frames.filter(item => item.subscriptionId === subscriptionId) : [];
    if (bytes > V2_LIMITS.frameBytes || this.frames.length + Number(this.sending) >= V2_LIMITS.socketQueueFrames ||
      this.bytes + bytes + Math.max(this.inFlightBytes, this.socket.bufferedAmount) > V2_LIMITS.socketQueueBytes ||
      owned.length >= V2_LIMITS.socketQueueFrames || owned.reduce((sum, item) => sum + item.bytes, bytes) > V2_LIMITS.socketQueueBytes) {
      if (subscriptionId) {
        this.discard(subscriptionId);
        this.overflow(subscriptionId);
      } else this.closeOverloaded();
      return false;
    }
    this.frames.push({ json, bytes, priority, subscriptionId });
    this.bytes += bytes;
    this.drain();
    return true;
  }

  discard(subscriptionId: string): void {
    this.frames = this.frames.filter(frame => {
      if (frame.subscriptionId !== subscriptionId) return true;
      this.bytes -= frame.bytes;
      return false;
    });
  }

  stop(): void {
    this.stopped = true;
    this.frames = [];
    this.bytes = 0;
    if (this.blocked) clearTimeout(this.blocked);
    if (this.sendTimeout) clearTimeout(this.sendTimeout);
  }

  private closeOverloaded(): void { this.stop(); this.socket.close(1013, "RPC connection is overloaded"); }

  private drain(): void {
    if (this.sending || this.stopped || !this.frames.length) return;
    if (this.socket.bufferedAmount > V2_LIMITS.socketQueueBytes / 2) {
      this.stalledAt ??= Date.now();
      if (Date.now() - this.stalledAt > 5000) { this.closeOverloaded(); return; }
      if (!this.blocked) this.blocked = setTimeout(() => { this.blocked = undefined; this.drain(); }, 10);
      return;
    }
    this.stalledAt = undefined;
    let best = 0;
    const seen = new Set<string>();
    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i];
      if (frame.subscriptionId && seen.has(frame.subscriptionId)) continue;
      if (frame.subscriptionId) seen.add(frame.subscriptionId);
      if (frame.priority < this.frames[best].priority) best = i;
    }
    const [frame] = this.frames.splice(best, 1);
    this.bytes -= frame.bytes;
    this.sending = true;
    this.inFlightBytes = frame.bytes;
    this.sendTimeout = setTimeout(() => this.closeOverloaded(), 5000);
    this.sendTimeout.unref();
    this.socket.send(frame.json, error => {
      if (this.sendTimeout) clearTimeout(this.sendTimeout);
      this.inFlightBytes = 0;
      this.sending = false;
      if (error) { this.stop(); this.socket.terminate(); return; }
      this.drain();
    });
  }
}
