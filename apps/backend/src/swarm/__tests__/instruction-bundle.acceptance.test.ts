import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { InstructionBundleSchema } from "@forge/protocol";
import { renderInstructionBundle, renderProviderInstructions } from "../runtime/instruction-bundle.js";
import { createProviderBoundaryFixture } from "./provider-boundary-fixture.js";
import { saveWorkerPresetSettings } from "../specialists/worker-presets.js";

describe("production instruction bundle", () => {
  it.each(["codex-native", "claude-native", "cursor-sdk", "openai-codex"])("retains identity, composition and revision provenance for %s", async provider => {
    const fixture = await createProviderBoundaryFixture();
    try {
      const descriptor = fixture.descriptor(provider, "worker");
      descriptor.specialistId = "contract-specialist";
      fixture.descriptors.set(descriptor.agentId, descriptor);
      const legacy = fixture.service.injectWorkerIdentityContext(descriptor, await fixture.service.resolveSystemPromptForDescriptor(descriptor));
      const bundle = await fixture.service.buildInstructionBundle(descriptor);
      expect(renderInstructionBundle(bundle)).toBe(legacy);
      expect(Value.Check(InstructionBundleSchema, JSON.parse(JSON.stringify(bundle)))).toBe(true);
      expect(bundle.actor).toMatchObject({ agentId: "worker", role: "worker", managerId: "manager" });
      expect(bundle.project.cwd).toBe(fixture.root);
      expect(bundle.parts.flatMap(part => part.sources).some(source => source.kind === "specialist")).toBe(true);
      expect(bundle.memory?.sources.length).toBeGreaterThan(0);
      expect(bundle.skills.some(skill => skill.name === "contract-skill")).toBe(true);
      expect(bundle.references.some(reference => reference.path.endsWith("design.md"))).toBe(true);
      const firstRevision = bundle.revision;
      await fixture.registry.save("archetype", "worker", "# Updated archetype", "profile");
      descriptor.specialistId = undefined;
      const changed = await fixture.service.buildInstructionBundle(descriptor);
      expect(changed.revision).not.toBe(firstRevision);
      expect(changed.parts.flatMap(part => part.sources).every(source => source.revision.length > 0)).toBe(true);
    } finally { await fixture.cleanup(); }
  });
  it("lists the global presets and user-authored specialist files in the manager system prompt", async () => {
    const fixture = await createProviderBoundaryFixture();
    try {
      const manager = fixture.descriptor("openai-codex");
      const empty = await fixture.service.resolveSystemPromptForDescriptor(manager);
      expect(empty).toContain([
        "Worker presets (pass the name as preset to spawn_agent; omit it to use your own model):",
        "- contract-specialist: openai-codex/gpt-5.5, medium. Verify contracts",
      ].join("\n"));

      await saveWorkerPresetSettings(fixture.config.paths.dataDir, { version: 2, presets: [
        { name: "builder", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "high", note: "Bounded work." },
        // The specialist file of the same name wins.
        { name: "contract-specialist", provider: "anthropic", modelId: "other", reasoningLevel: "low" },
      ] }, () => true);
      // A prompt override saved before worker presets still carries the old placeholders.
      await fixture.registry.save("archetype", "manager", "# Legacy override\n${MANAGER_POSTURE}\n${SPECIALIST_ROSTER}\nAfter.", "profile"); // eslint-disable-line no-template-curly-in-string
      const prompt = await fixture.service.resolveSystemPromptForDescriptor(manager);
      expect(prompt).toContain([
        "Worker presets (pass the name as preset to spawn_agent; omit it to use your own model):",
        "- builder: openai-codex/gpt-5.5, high. Bounded work.",
        "- contract-specialist: openai-codex/gpt-5.5, medium. Verify contracts",
      ].join("\n"));
      expect(prompt).not.toMatch(/\$\{[A-Z_]+\}/);
      expect(prompt.indexOf("Worker presets")).toBeLessThan(prompt.indexOf("After."));
    } finally { await fixture.cleanup(); }
  });
  it("places Codex in developerInstructions and Claude in its native preset append", async () => {
    const fixture = await createProviderBoundaryFixture();
    try {
      const bundle = await fixture.service.buildInstructionBundle(fixture.descriptor("codex-native"));
      expect(renderProviderInstructions(bundle, "codex")).toEqual({ developerInstructions: renderInstructionBundle(bundle) });
      expect(renderProviderInstructions(bundle, "claude")).toEqual({ systemPrompt: { type: "preset", preset: "claude_code", append: renderInstructionBundle(bundle) } });
    } finally { await fixture.cleanup(); }
  });
});
