import type { RpcOutput } from "@forge/protocol/environment-v2";

/** Private physical-parent channel, separate from the Secure Sessions descriptor. */
export function installEnvironmentParentBootstrap(options: {
  authorizedPhysicalParent: boolean;
  createGrant(): Promise<RpcOutput<"access.grant.create">>;
}): () => void {
  if (!options.authorizedPhysicalParent || !process.send) return () => {};
  const handler = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const input = message as { type?: unknown; requestId?: unknown };
    if (
      input.type !== "forge:environment-bootstrap:request" ||
      typeof input.requestId !== "string" ||
      input.requestId.length > 128 ||
      !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|serve-\d+-\d+)$/.test(input.requestId)
    )
      return;
    void options.createGrant().then(
      (grant) => {
        process.send?.({ type: "forge:environment-bootstrap:result", requestId: input.requestId, grant });
      },
      () => {
        process.send?.({
          type: "forge:environment-bootstrap:result",
          requestId: input.requestId,
          error: { code: "UNAVAILABLE", message: "Environment bootstrap unavailable", retryable: false },
        });
      },
    );
  };
  process.on("message", handler);
  return () => {
    process.off("message", handler);
  };
}
