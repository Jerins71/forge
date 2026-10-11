import type { ProviderCapabilities } from "@forge/protocol";
import { codexProviderCapabilities } from "./codex/codex-provider-adapter.js";
import { claudeProviderCapabilities } from "./claude/claude-provider-adapter.js";
import { cursorProviderCapabilities } from "./cursor-sdk/cursor-sdk-provider-adapter.js";
import { piProviderCapabilities } from "./pi/pi-provider-adapter.js";

/** The factory and context planner share one policy; inspecting it provisions no provider or grants. */
export function runtimeProviderCapabilities(provider:string):ProviderCapabilities {
  if(provider==="codex-native") return codexProviderCapabilities();
  if(provider==="claude-native") return claudeProviderCapabilities();
  if(provider.trim().toLowerCase()==="cursor-sdk") return cursorProviderCapabilities();
  return piProviderCapabilities();
}
