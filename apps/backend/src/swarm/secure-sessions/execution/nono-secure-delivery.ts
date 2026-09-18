import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecureExecutionDelivery } from "./secure-execution-backend.js";
import { SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER } from "./secure-execution-backend.js";
import { SECURE_RESERVED_GUEST_ENVIRONMENT_NAMES } from "./execution-frame.js";
import { SecureExecutionError } from "./secure-execution-error.js";

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Execution-local files are private, outside the workspace, and removed by the owner. */
export async function prepareNonoDelivery(root: string, delivery: SecureExecutionDelivery) {
  const environment: NodeJS.ProcessEnv = {};
  const filePaths = new Map<string, string>();
  const names = new Set<string>();
  const set = (name: string, value: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name) || names.has(name)
      || SECURE_RESERVED_GUEST_ENVIRONMENT_NAMES.includes(name as never)
      || ["TMP", "TEMP", "GIT_SSH_COMMAND", "FORGE_ASKPASS_HELPER"].includes(name)
      || /^(NONO_|XDG_|DYLD_|LD_)/.test(name) || value.includes("\0")) {
      throw new SecureExecutionError("INVALID_DELIVERY");
    }
    names.add(name);
    environment[name] = value;
  };
  const save = async (name: string, value: Uint8Array | string, mode = 0o400) => {
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, value, { flag: "wx", mode });
    return destination;
  };
  for (const item of delivery.environment ?? []) set(item.name, Buffer.from(item.value).toString("utf8"));
  for (const [index, item] of (delivery.ramFiles ?? []).entries()) {
    if (!item.targetPath.startsWith("/run/forge-secure/bindings/")
      || path.posix.normalize(item.targetPath) !== item.targetPath
      || item.targetPath.includes("\0") || filePaths.has(item.targetPath)
      || ![undefined, 0o400, 0o600].includes(item.fileMode)) {
      throw new SecureExecutionError("INVALID_DELIVERY");
    }
    const destination = await save(`bindings/${index}`, item.value, item.fileMode);
    filePaths.set(item.targetPath, destination);
    if (item.pathEnvironmentVariable) set(item.pathEnvironmentVariable, destination);
  }
  for (const [index, item] of (delivery.askpass ?? []).entries()) {
    const secret = await save(`askpass/${index}.value`, item.value);
    const helper = await save(`askpass/${index}.sh`, `#!/bin/sh\nexec /bin/cat ${shellQuote(secret)}\n`, 0o700);
    set(item.targetName, helper);
    if (item.targetName === "SSH_ASKPASS") {
      environment.SSH_ASKPASS_REQUIRE = "force";
      environment.DISPLAY = "forge-secure";
    }
  }
  const bin = path.join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const askpassHelper = await save("bin/forge-env-askpass", [
    "#!/bin/sh", 'case "$FORGE_ASKPASS_ENV" in ""|*[!A-Za-z0-9_]*) exit 1;; esac',
    'exec /usr/bin/printenv "$FORGE_ASKPASS_ENV"', "",
  ].join("\n"), 0o700);
  environment.FORGE_ASKPASS_HELPER = askpassHelper;
  filePaths.set("/usr/local/bin/forge-env-askpass", askpassHelper);
  if (delivery.sshTrust) {
    const knownHosts = await save("ssh/known_hosts", delivery.sshTrust.knownHosts);
    const config = await save("ssh/config", Buffer.from(delivery.sshTrust.config).toString("utf8")
      .replaceAll(SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER, knownHosts));
    for (const command of ["ssh", "scp", "sftp"]) {
      await save(`bin/${command}`, `#!/bin/sh\nexec /usr/bin/${command} -F ${shellQuote(config)} -o StrictHostKeyChecking=yes "$@"\n`, 0o700);
    }
    environment.GIT_SSH_COMMAND = `${shellQuote(path.join(bin, "ssh"))}`;
  }
  return { environment, filePaths, bin };
}
