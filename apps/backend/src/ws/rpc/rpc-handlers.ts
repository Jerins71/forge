import type { ProjectAgentRpc, ProjectAgentMethod } from "./project-agent-rpc.js";
import type { EnvironmentDescriptor, Method, RpcInput } from "@forge/protocol/environment-v2";
import type { ControlService, EnvironmentAccessPort, EnvironmentStreamPort, Principal } from "../../environment/control/control-types.js";
import type { TerminalRpcTransport } from "../../terminal/terminal-rpc-transport.js";
import type { LegacyBuilderAdapter } from "./legacy-builder-adapter.js";
import type { BrowserHostRpc } from "./browser-host-rpc.js";
import { StreamFault } from "../../environment/streams/stream-budget.js";

export interface RpcDependencies {
  detailFeatures?: ReturnType<typeof import("./detail-feature-rpc.js").createDetailFeatureRpc>;
  featureStream?: { subscribe(principal: Principal, input: RpcInput<"session.features.subscribe">, signal: AbortSignal): AsyncIterable<import("@forge/protocol/environment-v2").DetailFeatureStreamItem> };
  projectAgents?: Pick<ProjectAgentRpc, "execute">;
  access: EnvironmentAccessPort;
  control: ControlService;
  shellStream: Pick<EnvironmentStreamPort, "shell" | "shellPage"> & { descriptor(): EnvironmentDescriptor };
  detailStream: Pick<EnvironmentStreamPort, "detail" | "history" | "workers" | "content">;
  legacyAdapter: LegacyBuilderAdapter;
  browserHost: Pick<BrowserHostRpc, "attach" | "send">;
  terminalTransport: TerminalRpcTransport;
}

export function requestHandler(deps: RpcDependencies, principal: Principal, method: Method, input: unknown, signal: AbortSignal): Promise<unknown> | unknown {
  if (method.startsWith("projectAgent.")) {
    if (!deps.projectAgents) throw new StreamFault("UNAVAILABLE", "Project Agent service is unavailable");
    return deps.projectAgents.execute(principal, method as ProjectAgentMethod, input);
  }
  switch (method) {
    case "recovery.get": case "recovery.decide": case "session.goal.control": case "session.compact": case "session.elicitation.respond": case "session.elicitation.url":
      if (!deps.detailFeatures) throw new StreamFault("UNAVAILABLE", "Detail features are not composed");
      return deps.detailFeatures.execute(principal, method, input);
    case "environment.get": return deps.shellStream.descriptor();
    case "shell.page": return deps.shellStream.shellPage(principal, input as RpcInput<"shell.page">);
    case "session.history": return deps.detailStream.history(principal, input as RpcInput<"session.history">);
    case "session.workers": return deps.detailStream.workers(principal, input as RpcInput<"session.workers">);
    case "session.content": return deps.detailStream.content(principal, input as RpcInput<"session.content">);
    case "session.launch": return deps.control.execute(principal, method, input as RpcInput<typeof method>);
    case "session.send": return deps.control.execute(principal, method, input as RpcInput<typeof method>);
    case "session.choose": return deps.control.execute(principal, method, input as RpcInput<typeof method>);
    case "session.stop": return deps.control.execute(principal, method, input as RpcInput<typeof method>);
    case "project.create": case "project.update": case "project.archive": case "project.restore": case "project.delete": case "project.reorder": case "session.configure": case "settings.recommendedDefaults.apply": case "workspace.directories.create": return deps.control.execute(principal, method, input as RpcInput<typeof method>);
    case "workspace.directories.list": case "workspace.directories.validate":
      if (!deps.control.readWorkspace) throw new StreamFault("UNAVAILABLE", "Workspace reads are not composed");
      return deps.control.readWorkspace(principal, method, input as RpcInput<typeof method>);
    case "command.get": return deps.control.getReceipt(principal, (input as RpcInput<"command.get">).commandId);
    case "access.grant.create": return deps.access.createGrant(principal, input as RpcInput<typeof method>);
    case "access.devices.list": return deps.access.listDevices(principal);
    case "access.devices.revoke": return deps.access.revokeDevice(principal, input as RpcInput<typeof method>);
    case "terminal.input": return deps.terminalTransport.input(principal, input as RpcInput<typeof method>);
    case "terminal.resize": return deps.terminalTransport.resize(principal, input as RpcInput<typeof method>);
    case "browser.host.send": return deps.browserHost.send(principal, input as RpcInput<typeof method>);
    case "legacy.session.read": case "legacy.session.operate": case "legacy.workspace.read": case "legacy.workspace.write": case "legacy.settings.admin":
      return deps.legacyAdapter.execute(principal, method, input as RpcInput<typeof method>, signal);
    default: throw new StreamFault("INVALID_INPUT", "Method requires subscription dispatch.");
  }
}
