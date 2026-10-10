import type { ClientCommand } from "@forge/protocol";
import { type RawData } from "ws";
import type { CommandParser, ParsedClientCommand } from "./commands/command-parse-helpers.js";
import { parseConversationCommand } from "./commands/parse-conversation-command.js";
import { parseManagerCommand } from "./commands/parse-manager-command.js";
import { parseSessionCommand } from "./commands/parse-session-command.js";
import { parseUtilityCommand } from "./commands/parse-utility-command.js";

const COMMAND_PARSERS: CommandParser[] = [
  parseUtilityCommand,
  parseManagerCommand,
  parseSessionCommand,
  parseConversationCommand
];

export type { ParsedClientCommand } from "./commands/command-parse-helpers.js";

export function parseClientCommand(raw: RawData): ParsedClientCommand {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Command must be valid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Command must be a JSON object" };
  }

  const maybe = parsed as Partial<ClientCommand> & { type?: unknown };

  for (const parser of COMMAND_PARSERS) {
    const result = parser(maybe);
    if (result) {
      return result;
    }
  }

  return { ok: false, error: "Unknown command type" };
}

export function extractRequestId(command: ClientCommand): string | undefined {
  switch (command.type) {
    case "subscribe_inventory":
    case "api_proxy":
    case "create_session":
    case "stop_session":
    case "resume_session":
    case "archive_session":
    case "restore_session":
    case "delete_session":
    case "clear_session":
    case "fork_session":
    case "get_session_workers":
    case "get_conversation_page":
    case "stop_all_agents":
      return command.requestId;

    case "subscribe":
    case "user_message":
    case "kill_agent":
    case "choice_response":
    case "choice_cancel":
    case "ping":
      return undefined;
  }
}
