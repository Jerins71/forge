import { isChoiceAnswer, type ClientCommand } from "@forge/protocol";

export type ParsedClientCommand =
  | { ok: true; command: ClientCommand }
  | { ok: false; error: string; requestId?: string };

export type ClientCommandCandidate = Partial<ClientCommand> & { type?: unknown };

export type CommandParser = (command: ClientCommandCandidate) => ParsedClientCommand | undefined;

export function ok(command: ClientCommand): ParsedClientCommand {
  return { ok: true, command };
}

export function fail(error: string, requestId?: string): ParsedClientCommand {
  return { ok: false, error, ...(requestId ? { requestId } : {}) };
}

export function isApiProxyMethod(value: unknown): value is "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE";
}

export function isSafeMessageCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  );
}

export function normalizeMessageCount(value: unknown): number | undefined {
  if (!isSafeMessageCount(value)) {
    return undefined;
  }

  return value;
}

export const isValidChoiceAnswer = isChoiceAnswer;
