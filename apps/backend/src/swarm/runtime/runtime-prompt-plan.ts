import type { InstructionBundle } from "@forge/protocol";
import { renderInstructionBundle } from "./instruction-bundle.js";

export interface PiRuntimePromptPlan {
  systemPrompt: string;
  appendSystemPromptOverride: (base: string[]) => string[];
}
export function planPiRuntimePrompt(options: {systemPrompt:string;instructionBundle?:InstructionBundle;cwd:string}):PiRuntimePromptPlan {
  return {systemPrompt:options.instructionBundle ? renderInstructionBundle(options.instructionBundle):options.systemPrompt,appendSystemPromptOverride:()=>[]};
}
export function planCursorSdkRuntimePrompt(options:{systemPrompt:string}):{systemPrompt:string} {
  return {systemPrompt:options.systemPrompt};
}
