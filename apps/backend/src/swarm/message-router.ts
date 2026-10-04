import type { MessageSourceContext } from "./types.js";

export type MessageRouteOrigin = "user" | "internal" | "scheduled" | "worker_result";

export type MessageRouteInternalDeliveryKind =
  | "bootstrap"
  | "agent_creator_bootstrap"
  | "codex_plugin_bootstrap"
  | "worker_health";

export type MessageRouteTargetKind =
  | "session_transcript"
  | "explicit_tool_required"
  | "peer_agent"
  | "external_channel"
  | "internal_only";

export type MessageRouteRole = "manager" | "worker";

export type MessageRouteReasonCode =
  | "render:user_web"
  | "render:scheduled_web"
  | "render:worker_result_closeout"
  | "route:retired_external_channel"
  | "route:cli"
  | "route:external_channel"
  | "route:peer_agent"
  | "route:worker_result_all_view"
  | "route:internal_origin"
  | "deny:target_not_manager"
  | "deny:project_agent_exchange"
  | "deny:project_agent_worker_result"
  | "deny:system_profile"
  | "deny:bootstrap"
  | "deny:agent_creator_bootstrap"
  | "deny:codex_operational_guidance"
  | "deny:internal_only";

export interface MessageRouteProvenance {
  origin: MessageRouteOrigin;
  internalDeliveryKind?: MessageRouteInternalDeliveryKind;
  sourceContext?: MessageSourceContext;
  targetKind: MessageRouteTargetKind;
  role: MessageRouteRole;
  senderRole?: MessageRouteRole;
  senderAgentId?: string;
  targetAgentId?: string;
  targetProjectAgent?: boolean;
  targetCreatorAgentId?: string;
  targetProfileSystem?: boolean;
  projectAgentContext?: unknown;
}

export interface MessageRouteDecision {
  visible: boolean;
  decision: "render" | "route" | "drop";
  channel?: "web" | "cli";
  reasonCode: MessageRouteReasonCode;
  targetKind: MessageRouteTargetKind;
}

export class MessageRouter {
  resolve(input: MessageRouteProvenance): MessageRouteDecision {
    const targetKind = input.targetKind;

    if (input.role !== "manager") {
      return drop(targetKind, "deny:target_not_manager");
    }

    if (
      input.senderRole === "manager" &&
      input.senderAgentId !== undefined &&
      input.targetAgentId !== undefined &&
      input.senderAgentId !== input.targetAgentId &&
      (input.targetProjectAgent || input.targetCreatorAgentId === input.senderAgentId)
    ) {
      return drop(targetKind, "deny:project_agent_exchange");
    }

    if (input.senderRole === "worker" && (input.targetProjectAgent || input.targetCreatorAgentId !== undefined)) {
      return drop(targetKind, "deny:project_agent_worker_result");
    }

    if (input.targetProfileSystem) {
      return drop(targetKind, "deny:system_profile");
    }

    if (input.internalDeliveryKind === "bootstrap") {
      return drop(targetKind, "deny:bootstrap");
    }

    if (input.internalDeliveryKind === "agent_creator_bootstrap") {
      return drop(targetKind, "deny:agent_creator_bootstrap");
    }

    if (input.internalDeliveryKind === "codex_plugin_bootstrap") {
      return drop(targetKind, "deny:codex_operational_guidance");
    }

    if (targetKind === "peer_agent") {
      return route(targetKind, "route:peer_agent");
    }

    if (targetKind === "external_channel") {
      const channel = input.sourceContext?.channel;
      return channel === "telegram"
        ? route(targetKind, "route:retired_external_channel")
        : route(targetKind, "route:external_channel", channel);
    }

    const channel = input.sourceContext?.channel;
    if (channel === "telegram") {
      return route(targetKind, "route:retired_external_channel");
    }

    if (channel === "cli") {
      return route(targetKind, "route:cli", "cli");
    }

    if (input.origin === "internal") {
      return route(targetKind, "route:internal_origin");
    }

    if (targetKind === "internal_only") {
      return drop(targetKind, "deny:internal_only");
    }

    if (input.origin === "scheduled") {
      return render(targetKind, "render:scheduled_web");
    }

    if (input.origin === "worker_result") {
      return targetKind === "session_transcript"
        ? render(targetKind, "render:worker_result_closeout")
        : route(targetKind, "route:worker_result_all_view");
    }

    return render(targetKind, "render:user_web");
  }
}

function render(targetKind: MessageRouteTargetKind, reasonCode: MessageRouteReasonCode): MessageRouteDecision {
  return {
    visible: true,
    decision: "render",
    channel: "web",
    reasonCode,
    targetKind,
  };
}

function route(
  targetKind: MessageRouteTargetKind,
  reasonCode: MessageRouteReasonCode,
  channel?: MessageRouteDecision["channel"],
): MessageRouteDecision {
  return {
    visible: false,
    decision: "route",
    ...(channel ? { channel } : {}),
    reasonCode,
    targetKind,
  };
}

function drop(targetKind: MessageRouteTargetKind, reasonCode: MessageRouteReasonCode): MessageRouteDecision {
  return {
    visible: false,
    decision: "drop",
    reasonCode,
    targetKind,
  };
}
