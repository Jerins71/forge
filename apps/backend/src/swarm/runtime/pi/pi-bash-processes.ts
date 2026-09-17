import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type BashTool = ToolDefinition<any, any, any>;
type Result = Awaited<ReturnType<BashTool["execute"]>>;
type OutputMode = "full" | "summary";

const DEFAULT_YIELD_MS = 10_000;
const MAX_YIELD_MS = 30_000;
const MAX_RUNNING = 8;
const MAX_RETAINED = 32;
const SUMMARY_CHARS = 6_000;

interface BashProcess {
  id: string;
  toolName: string;
  command: string;
  controller: AbortController;
  startedAt: number;
  updatedAt: number;
  result: Result;
  error?: string;
  completedAt?: number;
  settled: Promise<void>;
}

/** Owns only this Pi runtime's commands; Pi still owns spawning, guards and process-tree termination. */
export class PiBashProcesses {
  private readonly processes = new Map<string, BashProcess>();

  wrap(tool: BashTool): BashTool {
    return {
      ...tool,
      parameters: Type.Object({
        ...(tool.parameters as { properties: Record<string, any> }).properties,
        yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_YIELD_MS,
          description: "Return control after this many milliseconds; default 10000. The command keeps running. This is separate from timeout (seconds)." })),
        output_mode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("summary")], {
          description: "Use summary for builds/tests: status and a bounded output tail. Full retained output remains available through bash_process. Default full.",
        })),
      }),
      description: `${tool.description} Commands yield after 10 seconds by default. When a process_id is returned as running, use bash_process to wait or stop that command; do not start it again. Finish or stop owned commands before reporting completion.`,
      execute: async (toolCallId, rawParams, signal, onUpdate, ctx) => {
        const params = rawParams as Record<string, unknown>;
        if (signal?.aborted) throw new Error("Command aborted before start");
        if ([...this.processes.values()].filter(p => p.completedAt === undefined).length >= MAX_RUNNING) {
          throw new Error("Too many running commands. Wait for or stop an owned command with bash_process before starting another.");
        }
        this.prune();
        const { yield_ms, output_mode, ...args } = params;
        const waitMs = yieldMs(yield_ms);
        const outputMode = mode(output_mode);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const process: BashProcess = {
          id: randomUUID(), toolName: tool.name, command: String(args.command ?? "").slice(0, 300),
          controller, startedAt: Date.now(), updatedAt: Date.now(),
          result: { content: [], details: undefined }, settled: Promise.resolve(),
        };
        this.processes.set(process.id, process);
        let foregroundUpdate = onUpdate;
        // Attach both outcomes immediately: a yielded command must never reject unobserved.
        process.settled = Promise.resolve().then(() => tool.execute(toolCallId, args, controller.signal, update => {
          process.result = update;
          process.updatedAt = Date.now();
          foregroundUpdate?.(update);
        }, ctx)).then(result => {
          process.result = result;
        }, error => {
          process.error = error instanceof Error ? error.message : String(error);
          process.result = { content: [{ type: "text", text: process.error }], details: undefined };
        }).finally(() => {
          process.completedAt = Date.now();
          signal?.removeEventListener("abort", abort);
        });
        try {
          await waitForProcess(process, waitMs, signal);
        } finally {
          // Tool-execution updates must not arrive after its running receipt.
          foregroundUpdate = undefined;
        }
        return this.receipt(process, outputMode);
      },
    };
  }

  readonly tool: BashTool = {
    name: "bash_process",
    label: "Bash process",
    description: "Inspect, wait for, or stop a command started by bash or secure_bash in this runtime. Handles survive context rollover, not runtime replacement/restart. Use list after losing a handle. Wait up to 30 seconds; continue independent work between waits, avoid rapid status polling. Stop requests cancellation only for the selected command; a stopping receipt requires another wait to confirm termination. Full returns retained output (Pi's full-output file holds overflow). A running receipt is not completion or success.",
    parameters: Type.Object({
      op: Type.Union([Type.Literal("list"), Type.Literal("wait"), Type.Literal("stop")]),
      process_id: Type.Optional(Type.String()),
      yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_YIELD_MS })),
      output_mode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("summary")])),
    }),
    execute: async (_id, rawParams, signal) => {
      const params = rawParams as Record<string, unknown>;
      if (params.op === "list") {
        return { content: [{ type: "text", text: JSON.stringify([...this.processes.values()].map(p => ({
          process_id: p.id, tool: p.toolName, command: p.command, status: status(p), elapsed_seconds: elapsedSeconds(p),
        }))) }], details: undefined };
      }
      if (params.op !== "wait" && params.op !== "stop") throw new Error("op must be list, wait or stop");
      const process = typeof params.process_id === "string" ? this.processes.get(params.process_id) : undefined;
      if (!process) throw new Error("Unknown or expired process_id for this runtime. Inspect current state before rerunning a command; handles do not survive runtime replacement.");
      const waitMs = yieldMs(params.yield_ms);
      const outputMode = mode(params.output_mode ?? "summary");
      if (params.op === "stop" && process.completedAt === undefined) process.controller.abort();
      await waitForProcess(process, waitMs, signal);
      return this.receipt(process, outputMode);
    },
  };

  /** Call before releasing runtime ownership. A caller's existing shutdown deadline bounds this wait. */
  async stopAll(): Promise<void> {
    const processes = [...this.processes.values()];
    for (const process of processes) if (process.completedAt === undefined) process.controller.abort();
    await Promise.all(processes.map(process => process.settled));
  }

  private receipt(process: BashProcess, outputMode: OutputMode): Result {
    const state = status(process);
    const header = `process_id: ${process.id}\nstatus: ${state}\nelapsed_seconds: ${elapsedSeconds(process)}\nseconds_since_output: ${Math.round((Date.now() - process.updatedAt) / 1000)}`;
    const content = outputMode === "full" ? process.result.content : process.result.content.map(block => {
      if (block.type !== "text") return block;
      const tail = block.text.split("\n").slice(-50).join("\n").slice(-SUMMARY_CHARS);
      return { ...block, text: tail === block.text ? tail : `[Output tail; use bash_process with output_mode=full for retained output.]\n${tail}` };
    });
    const result: Result = {
      content: [{ type: "text", text: header }, ...content],
      details: { ...process.result.details, process_id: process.id, status: state },
    };
    // Preserve Pi's normal isError path, including nonzero exit, timeout and guard rejection.
    if (process.completedAt !== undefined && process.error !== undefined) throw new Error(result.content.filter(b => b.type === "text").map(b => b.text).join("\n"));
    return result;
  }

  private prune(): void {
    for (const [id, process] of this.processes) {
      if (this.processes.size < MAX_RETAINED) break;
      if (process.completedAt !== undefined) this.processes.delete(id);
    }
  }
}

function status(process: BashProcess): string {
  if (process.completedAt === undefined) return process.controller.signal.aborted ? "stopping" : "running";
  return process.error !== undefined ? "failed" : "completed";
}

function elapsedSeconds(process: BashProcess): number {
  return Math.round(((process.completedAt ?? Date.now()) - process.startedAt) / 1000);
}

function yieldMs(value: unknown): number {
  if (value === undefined) return DEFAULT_YIELD_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_YIELD_MS) {
    throw new Error(`yield_ms must be an integer from 0 to ${MAX_YIELD_MS}`);
  }
  return value;
}

function mode(value: unknown): OutputMode {
  if (value === undefined || value === "full") return "full";
  if (value === "summary") return "summary";
  throw new Error("output_mode must be full or summary");
}

async function waitForProcess(process: BashProcess, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Process wait interrupted");
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([process.settled, new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      onAbort = () => reject(new Error("Process wait interrupted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
