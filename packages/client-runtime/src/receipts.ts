import type { CommandReceipt } from '@forge/protocol/environment-v2'
/** Interrupted or delivery-unknown receipts are terminal: they are shown, never resubmitted automatically. */
export function isInterruptedReceipt(receipt: CommandReceipt): boolean {
  return receipt.state === 'interrupted' || receipt.delivery === 'unknown'
}
