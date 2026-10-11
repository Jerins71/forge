import { lifecycleMethods, type SessionLifecycleMethod } from "./session-lifecycle-rpc.js";
import type { ProjectAgentRpc, ProjectAgentMethod } from "./project-agent-rpc.js";
import type { EnvironmentDescriptor, Method, RpcInput } from "@forge/protocol/environment-v2";
import type { ControlService, EnvironmentAccessPort, EnvironmentStreamPort, Principal } from "../../environment/control/control-types.js";
import type { TerminalRpcTransport } from "../../terminal/terminal-rpc-transport.js";
import type { BrowserHostRpc } from "./browser-host-rpc.js";
import { StreamFault } from "../../environment/streams/stream-budget.js";

export interface RpcDependencies {
  lifecycle?: ReturnType<typeof import("./session-lifecycle-rpc.js").createSessionLifecycleRpc>;
  browser?: ReturnType<typeof import('./browser-workspace-rpc.js').createBrowserWorkspaceRpc>;
  sessionState?: ReturnType<typeof import("./session-state-rpc.js").createSessionStateRpc>;
  detailFeatures?: ReturnType<typeof import("./detail-feature-rpc.js").createDetailFeatureRpc>;
  featureStream?: { subscribe(principal: Principal, input: RpcInput<"session.features.subscribe">, signal: AbortSignal): AsyncIterable<import("@forge/protocol/environment-v2").DetailFeatureStreamItem> };
  projectAgents?: Pick<ProjectAgentRpc, "execute">;
  access: EnvironmentAccessPort;
  control: ControlService;
  shellStream: Pick<EnvironmentStreamPort, "shell" | "shellPage"> & { descriptor(): EnvironmentDescriptor };
  detailStream: Pick<EnvironmentStreamPort, "detail" | "history" | "workers" | "content">;
  browserHost: Pick<BrowserHostRpc, "attach" | "send" | "execute">;
  terminalTransport: TerminalRpcTransport;
}

export function requestHandler(deps: RpcDependencies, principal: Principal, method: Method, input: unknown, _signal: AbortSignal): Promise<unknown> | unknown {
  if ((lifecycleMethods as readonly string[]).includes(method)) {
    if (!deps.lifecycle) throw new StreamFault("UNAVAILABLE", "Lifecycle service is unavailable");
    return deps.lifecycle.execute(principal, method as SessionLifecycleMethod, input);
  }
  if (method.startsWith("projectAgent.")) {
    if (!deps.projectAgents) throw new StreamFault("UNAVAILABLE", "Project Agent service is unavailable");
    return deps.projectAgents.execute(principal, method as ProjectAgentMethod, input);
  }
  if (method === 'browser.host.register' || method === 'browser.host.hydrate' || method === 'browser.host.focus' || method === 'browser.host.reveal') return deps.browserHost.execute(principal, method, input as RpcInput<typeof method>);
  if (method === 'browser.get' || method === 'browser.tab.open' || method === 'browser.tab.activate' || method === 'browser.tab.close' || method === 'browser.tab.resize' || method === 'browser.recording.start' || method === 'browser.recording.stop') {
    if (!deps.browser) throw new StreamFault('UNAVAILABLE', 'Browser workspace is unavailable');
    return deps.browser.execute(principal, method, input as RpcInput<typeof method>);
  }
  switch (method) {
    case "session.update": case "session.message.pin": case "session.pins.clear": case "session.readState.set": case "project.readState.clear": case "session.attention.dismiss":
      if (!deps.sessionState) throw new StreamFault("UNAVAILABLE", "Session state controls are not composed");
      return deps.sessionState.execute(principal, method, input);
    case "recovery.get": case "recovery.decide": case "session.goal.control": case "session.compact": case "session.elicitation.respond": case "session.elicitation.url":
      if (!deps.detailFeatures) throw new StreamFault("UNAVAILABLE", "Detail features are not composed");
      return deps.detailFeatures.execute(principal, method, input);
    case "environment.get": return deps.shellStream.descriptor();
    case "shell.page": return deps.shellStream.shellPage(principal, input as RpcInput<"shell.page">);
    case "session.history": return deps.detailStream.history(principal, input as RpcInput<"session.history">);
    case "session.workers": return deps.detailStream.workers(principal, input as RpcInput<"session.workers">);
    case "session.content": return deps.detailStream.content(principal, input as RpcInput<"session.content">);
    case "session.lineage.get":
      if(!deps.control.readLineage) throw new StreamFault("UNAVAILABLE","Lineage read service is unavailable");
      return deps.control.readLineage(principal,input as RpcInput<"session.lineage.get">);
    case "session.fork": case "session.provider.switch": case "session.mergeBack": case "worker.continue": return deps.control.execute(principal,method,input as RpcInput<typeof method>);
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

    default: throw new StreamFault("INVALID_INPUT", "Method requires subscription dispatch.");
  }
}
