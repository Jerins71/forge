import { TypeCompiler } from "@sinclair/typebox/compiler";
import { RpcClientFrameSchema, RpcServerFrameSchema, RpcErrorSchema, rpcRegistry, type Method, type RpcError } from "@forge/protocol/environment-v2";
import { StreamFault } from "../../environment/streams/stream-budget.js";

export const clientFrameValidator = TypeCompiler.Compile(RpcClientFrameSchema);
export const serverFrameValidator = TypeCompiler.Compile(RpcServerFrameSchema);
const errorValidator = TypeCompiler.Compile(RpcErrorSchema);
export const compiledRegistry = Object.fromEntries(Object.entries(rpcRegistry).map(([method, entry]) => [method, {
  input: TypeCompiler.Compile(entry.input), output: TypeCompiler.Compile(entry.output),
  stream: entry.stream ? TypeCompiler.Compile(entry.stream) : undefined,
}])) as unknown as Record<Method, { input: ReturnType<typeof TypeCompiler.Compile>; output: ReturnType<typeof TypeCompiler.Compile>; stream?: ReturnType<typeof TypeCompiler.Compile> }>;

/** Maps a failure to its wire error; unexpected failures are logged, since the wire only says "Unable to complete request." */
export function rpcError(error: unknown, context = "request"): RpcError {
  if (errorValidator.Check(error)) return error;
  if (error instanceof StreamFault) return {
    code: error.code, message: error.message.slice(0, 1024), retryable: error.code === "RATE_LIMITED" || error.code === "UNAVAILABLE" || error.code === "RESYNC_REQUIRED",
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
  if (error && typeof error === "object" && "code" in error) {
    const candidate = { code: error.code, message: error instanceof Error ? error.message.slice(0, 1024) : "Request rejected.", retryable: "retryable" in error && typeof error.retryable === "boolean" ? error.retryable : false };
    if (errorValidator.Check(candidate)) return candidate;
  }
  console.error(`[rpc] ${context} failed unexpectedly`, error);
  return { code: "INTERNAL", message: "Unable to complete request.", retryable: false };
}
