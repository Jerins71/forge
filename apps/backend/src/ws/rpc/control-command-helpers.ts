import { createHash, randomUUID } from "node:crypto";
import type { CommandReceipt } from "@forge/protocol/environment-v2";
import type { ControlService, Principal } from "../../environment/control/control-types.js";
import { StreamFault } from "../../environment/streams/stream-budget.js";

export function controlCommandId(principal: Principal, method: string, requestId?: string): string {
  if (!requestId) return randomUUID();
  const hex = createHash("sha256").update(`${principal.deviceSessionId}\0${method}\0${requestId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Callers requiring materialized results wait for dispatch; accepted intent remains retryable after timeout. */
export async function awaitCommandReceipt(control: ControlService, principal: Principal, receipt: CommandReceipt): Promise<CommandReceipt> {
  const deadline = Date.now() + 30_000;
  while (receipt.state === "accepted" || receipt.state === "running") {
    if (Date.now() >= deadline) throw new StreamFault("UNAVAILABLE", `Command ${receipt.commandId} was accepted and is still pending.`);
    await new Promise(resolve => setTimeout(resolve, 25));
    receipt = await control.getReceipt(principal, receipt.commandId);
  }
  if (receipt.state !== "succeeded") throw new StreamFault(receipt.error?.code ?? "UNAVAILABLE", receipt.error?.message ?? `Command ${receipt.commandId} was interrupted.`);
  return receipt;
}

