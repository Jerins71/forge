import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
export interface RestartRecoveryCoordinatorOptions { onDecisionResolved?:()=>void; }

/** Presentation adapter. The control kernel owns recovery. */
export interface CoreRecoveryPort {
  getSnapshot(): RecoverySnapshot | null;
  decide(action: "resume" | "dismiss"): Promise<void>;
}
export class RestartRecoveryCoordinator {
  private core?: CoreRecoveryPort;
  constructor(private readonly options: RestartRecoveryCoordinatorOptions) {}
  installCore(port: CoreRecoveryPort): void { this.core = port; }
  async reconcileForBoot(): Promise<void> {}
  getSnapshot(): RecoverySnapshot | null { return this.core?.getSnapshot() ?? null; }
  isDecisionPending(): boolean { const snapshot = this.getSnapshot(); return Boolean(snapshot && !snapshot.resumedAt && !snapshot.dismissedAt); }
  async dismiss(): Promise<RecoverySnapshot | null> { await this.core?.decide("dismiss"); this.options.onDecisionResolved?.(); return this.getSnapshot(); }
  async resume(): Promise<RecoverySnapshot | null> { await this.core?.decide("resume"); this.options.onDecisionResolved?.(); return this.getSnapshot(); }

}
