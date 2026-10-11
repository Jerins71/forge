import type { Database } from "better-sqlite3";
import type { ProjectSummary, RpcError, RpcInput, WorkspaceStrategy } from "@forge/protocol/environment-v2";
import type { Principal, SwarmControlPort } from "./control-types.js";

export interface WorkspaceReservation {
  reservationId: string;
  repositoryRoot: string;
  repositoryCommonDir: string;
  kind: WorkspaceStrategy["kind"];
  path: string;
  pathKey: string;
  branch: string | null;
  baseCommit: string | null;
  owned: boolean;
}
export interface PreparedLaunch {
  project: ProjectSummary;
  revision: string;
  /** Frozen project CWD, including the project subpath of a new worktree. */
  cwd: string;
  model?: RpcInput<"session.launch">["model"];
  reservation: WorkspaceReservation;
}
export interface WorkspacePort {
  /** Git, realpath and model-default resolution occur before the acceptance transaction. */
  prepareLaunch(input: {
    commandId: string;
    projectId: string;
    workspaceStrategy: WorkspaceStrategy;
    model?: RpcInput<"session.launch">["model"];
  }): Promise<PreparedLaunch>;
  /** Synchronous profile revision check; must perform no I/O under the writer lock. */
  isLaunchCurrent(prepared: PreparedLaunch): boolean;
  /** Idempotent by reservation identity; never adopt a conflicting path or branch. */
  ensure(commandId: string): Promise<{ cwd: string; branch: string | null }>;
  reconcile(commandId: string): Promise<"ready" | "retry" | "interrupted">;
}
export interface InputArtifact {
  artifactId: string;
}
export interface ArtifactPort {
  /** Read-only ownership/project/existence checks, repeated inside acceptance. */
  validateInput(input: {
    principal: Principal;
    projectId: string;
    sessionId?: string;
    artifactIds: readonly string[];
  }): readonly InputArtifact[];
  /** Called synchronously inside the same acceptance transaction after inserting control_inputs. */
  pinInput(inputId: string, rows: readonly InputArtifact[]): void;
}
/** Routing eligibility is resolved before accepting an input into the durable queue. */
export interface InputRoutePort {
  preflight(
    input: ({ sessionId: string; projectId?: never } | { projectId: string; sessionId?: never }) & {
      message: RpcInput<"session.send">["message"];
    },
  ): Promise<{ ok: true } | { ok: false; error: RpcError & { code: "UNAVAILABLE" } }>;
}
export type ControlEffect =
  | import("./orchestration/types.js").CoreEffect
  | { kind: "workspace.ensure"; reservation: WorkspaceReservation }
  | { kind: "session.ensure"; input: Parameters<SwarmControlPort["ensureSession"]>[0] }
  | { kind: "choice.apply"; choiceId: string; runtimeGeneration: string; answers: RpcInput<"session.choose">["answers"] };
export interface EffectRow {
  effect_id: string;
  command_id: string;
  session_id: string;
  kind: ControlEffect["kind"];
  ordinal: number;
  depends_on: string | null;
  payload_json: string;
  state: "pending" | "claimed" | "done" | "failed" | "interrupted" | "cancelled";
  attempt: number;
  claimed_boot_id: string | null;
  not_before: number;
  last_error_json: string | null;
}
export interface ControlCoreOptions {
  databasePath?: string;
  /** Shared raw SQLite connection; the factory never opens a second connection when provided. */
  database?: Database;
  clock: () => number;
  random: () => string;
  swarm: SwarmControlPort;
  workspace: WorkspacePort;
  artifacts: ArtifactPort;
  /** Omission allows input routes; adapters reject routes without a durable dispatch boundary. */
  inputRoute?: InputRoutePort;
  policy?: import("./project-policy.js").PolicyPort;
  /** Must be synchronous so acceptance/claim/dispatch checks stay inside BEGIN IMMEDIATE. */
  isDeviceRevoked: (deviceSessionId: Principal["deviceSessionId"]) => boolean;
}
