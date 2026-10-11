import { readFile } from "node:fs/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { InstructionBundle, InstructionSource } from "@forge/protocol";
import type { ForgePreparedRuntimeBindings } from "../../forge-extension-types.js";
import { instructionSource, reviseInstructionBundle } from "../instruction-bundle.js";

/** Provenance only: AgentSession's native assembler still injects/wraps these resources exactly once. */
export async function capturePiInstructionResources(
  bundle: InstructionBundle, session: AgentSession, forgeBindings?: ForgePreparedRuntimeBindings | null,
): Promise<InstructionBundle> {
  const loader = session.resourceLoader;
  const sources: InstructionSource[] = loader.getAgentsFiles().agentsFiles.map(file =>
    instructionSource("pi_context_file", file.path, file.content, file.path));
  const extensions = loader.getExtensions().extensions;
  for (const extension of extensions) {
    const path = extension.resolvedPath || extension.path;
    const description = JSON.stringify({ events: [...extension.handlers.keys()], tools: [...extension.tools.keys()] });
    const content = path.startsWith("<inline") ? description : await readFile(path, "utf8").catch(() => description);
    sources.push(instructionSource("pi_extension", path, content, path));
  }
  for (const extension of forgeBindings?.extensions ?? []) {
    const path = extension.module.discovered.path;
    sources.push(instructionSource("forge_extension", path, await readFile(path, "utf8"), path));
  }
  const skills = [...bundle.skills];
  for (const skill of loader.getSkills().skills) {
    const source = instructionSource("pi_skill", skill.name, await readFile(skill.filePath, "utf8"), skill.filePath);
    sources.push(source);
    if (!skills.some(entry => entry.path === skill.filePath)) skills.push({ name: skill.name, path: skill.filePath, description: skill.description, source });
  }
  return reviseInstructionBundle({ ...bundle, skills,
    parts: [...bundle.parts.filter(part => part.kind !== "pi_resource_loader"),
      ...(sources.length ? [{ kind: "pi_resource_loader", text: "", separator: "", sources }] : [])],
  });
}
