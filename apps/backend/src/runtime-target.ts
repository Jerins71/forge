export const RUNTIME_TARGETS = ["builder", "collaboration-server"] as const;

export type RuntimeTarget = (typeof RUNTIME_TARGETS)[number];

export function isRuntimeTarget(value: string): value is RuntimeTarget {
  return (RUNTIME_TARGETS as readonly string[]).includes(value);
}

export function isBuilderRuntimeTarget(target: RuntimeTarget): boolean {
  return target === "builder";
}

export function isCollaborationServerRuntimeTarget(target: RuntimeTarget): boolean {
  return target === "collaboration-server";
}

export function resolveRuntimeTargetFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeTarget {
  const explicitValue = env.FORGE_RUNTIME_TARGET ?? env.MIDDLEMAN_RUNTIME_TARGET;
  const normalizedExplicitValue = explicitValue?.trim();
  const legacyCollaborationEnabled = parseOptionalBooleanEnv(
    env.FORGE_COLLABORATION_ENABLED ?? env.MIDDLEMAN_COLLABORATION_ENABLED,
  );

  // Fail closed: the collaboration server (and its authentication) was removed.
  // Never silently boot the unauthenticated Builder surface on a host that was
  // configured as a collaboration server, and never accept an unknown target.
  if (
    (normalizedExplicitValue && normalizedExplicitValue !== "builder")
    || (!normalizedExplicitValue && legacyCollaborationEnabled === true)
  ) {
    throw new Error(
      `Unsupported runtime target configuration (FORGE_RUNTIME_TARGET=${JSON.stringify(explicitValue ?? "")}). ` +
        "The Forge collaboration server was removed in Forge V2; only the local Builder is supported. " +
        "Unset FORGE_RUNTIME_TARGET and FORGE_COLLABORATION_ENABLED to start the Builder.",
    );
  }

  return "builder";
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}
