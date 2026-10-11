import { createHash } from "node:crypto";
import type { InstructionBundle, InstructionPart, InstructionSource } from "@forge/protocol";
import type { AgentDescriptor } from "../types.js";

export function instructionRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function instructionSource(kind: string, id: string, content: string, path?: string): InstructionSource {
  return { kind, id, revision: instructionRevision(content), ...(path ? { path } : {}) };
}

export function createInstructionBundle(
  descriptor: Pick<AgentDescriptor, "agentId" | "role" | "managerId" | "profileId" | "cwd">,
  text: string,
  sources: InstructionSource[] = [instructionSource("resolved_prompt", descriptor.agentId, text)],
): InstructionBundle {
  return reviseInstructionBundle({ version: 1, revision: "pending",
    actor: { agentId: descriptor.agentId, role: descriptor.role, managerId: descriptor.managerId,
      ...(descriptor.profileId ? { profileId: descriptor.profileId } : {}) },
    project: { cwd: descriptor.cwd }, parts: [{ kind: "forge_prompt", text, separator: "", sources }],
    skills: [], references: [], pins: [],
  });
}

/** Revision covers both exact rendered bytes and the context/inventory provenance. */
export function reviseInstructionBundle(bundle: InstructionBundle): InstructionBundle {
  const { revision: _revision, ...content } = bundle;
  return { ...content, revision: instructionRevision(JSON.stringify(content)) };
}

export function appendInstructionParts(bundle: InstructionBundle, parts: InstructionPart[]): InstructionBundle {
  return reviseInstructionBundle({ ...bundle, parts: [...bundle.parts, ...parts] });
}

export function renderInstructionBundle(bundle: InstructionBundle): string {
  return bundle.parts.map(part => part.separator + part.text).join("");
}

/** Keep the provider-owned native base, including Claude's coding preset. */
export function renderProviderInstructions(bundle: InstructionBundle, provider: "codex"): { developerInstructions: string };
export function renderProviderInstructions(bundle: InstructionBundle, provider: "claude"): { systemPrompt: { type: "preset"; preset: "claude_code"; append: string } };
export function renderProviderInstructions(bundle: InstructionBundle, provider: "cursor-sdk" | "pi"): { systemPrompt: string };
export function renderProviderInstructions(bundle: InstructionBundle, provider: "codex" | "claude" | "cursor-sdk" | "pi") {
  const text = renderInstructionBundle(bundle);
  if (provider === "codex") return { developerInstructions: text };
  if (provider === "claude") return { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: text } };
  return { systemPrompt: text };
}
