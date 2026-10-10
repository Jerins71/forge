import { Value } from "@sinclair/typebox/value";
import { ProjectAgentReferenceWriteSchema, ProjectAgentReferenceDeleteSchema, ProjectAgentReferenceMutationResultSchema } from "@forge/protocol";
import { ENVIRONMENT_PROTOCOL_HEADER, ENVIRONMENT_PROTOCOL_VERSION } from "@forge/protocol/environment-v2";
import type { EnvironmentAccessPort } from "../../../environment/control/control-types.js";
import type { EnvironmentHttpRoute } from "../../../environment/access/http-policy.js";
import type { ProjectAgentRpc } from "../../rpc/project-agent-rpc.js";
import { rpcError } from "../../rpc/rpc-dispatcher.js";
import { readJsonBody, sendJson } from "../../http-utils.js";
import { StreamFault } from "../../../environment/streams/stream-budget.js";

export function createProjectAgentReferenceRoutes(access: EnvironmentAccessPort, owner: ProjectAgentRpc): EnvironmentHttpRoute[] {
  return ["PUT", "DELETE"].map(method => ({
    methods: method, matches: path => path === "/api/v2/project-agents/reference", access: { scopes: ["workspace:write"] },
    async handle(request, response) {
      try {
        if (request.headers[ENVIRONMENT_PROTOCOL_HEADER] !== String(ENVIRONMENT_PROTOCOL_VERSION)) throw new StreamFault("PROTOCOL_MISMATCH", "Environment protocol must match");
        const principal = await access.authenticateHttp(request, "workspace:write", true);
        const input = await readJsonBody(request, 600000);
        const schema = method === "PUT" ? ProjectAgentReferenceWriteSchema : ProjectAgentReferenceDeleteSchema;
        if (!Value.Check(schema, input)) throw new StreamFault("INVALID_INPUT", "Invalid reference mutation");
        const output = await owner.mutateReference(principal, input);
        if (!Value.Check(ProjectAgentReferenceMutationResultSchema, output)) throw new Error("Invalid reference output");
        sendJson(response, 200, output);
      } catch (caught) {
        const error = rpcError(caught);
        const statuses: Record<string, number> = { INVALID_INPUT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PROTOCOL_MISMATCH: 409, PAYLOAD_TOO_LARGE: 413 };
        const status = statuses[error.code];
        sendJson(response, status ?? 500, { error });
      }
    },
  }));
}
