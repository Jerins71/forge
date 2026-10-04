import { CLI_PROTOCOL_VERSION, type CliCapabilities } from "@forge/protocol";

export const CLI_SERVER_VERSION = "1.0.0";

export function buildCliCapabilities(): CliCapabilities {
  const available = true;
  return {
    protocolVersion: CLI_PROTOCOL_VERSION,
    minCliVersion: "0.1.0",
    available,
    runtimeTarget: "builder",
    features: {
      bearerAuth: available,
      headlessWs: available,
      cliSourceContext: available,
      cliSessionMetadata: available,
      choiceOwnerLookup: available,
      activeToolSnapshot: available,
      projectAgentRunTarget: available,
      sessionTranscript: available,
      sessionCompaction: available,
      builderRuntimeOnly: true,
    },
  };
}
