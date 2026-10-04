import { afterEach, describe, expect, it } from "vitest";
import { createCodexAppServerClient } from "../codex-app-server/codex-app-server-client.js";
import type { CodexAppServerClientPort } from "../codex-app-server/types.js";

const activeClients = new Set<CodexAppServerClientPort>();

function createFakeAppServerClientScript(): string {
  return String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const pendingByProbe = new Map();

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: { experimentalApi: true } } });
    return;
  }

  if (message.method === 'initialized') {
    return;
  }

  if (message.method === 'probe-server-request') {
    pendingByProbe.set('elicitation', message.id);
    send({
      id: 'server-elicitation',
      method: 'mcpServer/elicitation/request',
      params: { prompt: 'Allow access?' }
    });
    return;
  }

  if (message.id === 'server-elicitation') {
    const originalId = pendingByProbe.get('elicitation');
    send({ id: originalId, result: message });
    return;
  }

  if (message.method === 'slow') {
    setTimeout(() => send({ id: message.id, result: { slow: true } }), 80);
    return;
  }

  if (message.method === 'plugin/list') {
    send({ id: message.id, result: { plugins: [] } });
  }
});
`;
}

function trackClient(client: CodexAppServerClientPort): CodexAppServerClientPort {
  activeClients.add(client);
  return client;
}

afterEach(() => {
  for (const client of activeClients) {
    client.dispose();
  }
  activeClients.clear();
});

describe("CodexAppServerClient", () => {
  it("responds to server elicitation requests with fail-closed decline", async () => {
    const client = trackClient(
      createCodexAppServerClient({}, {
        command: process.execPath,
        args: ["-e", createFakeAppServerClientScript()],
      }),
    );

    await client.connect();
    const result = await client.request<{ result: { action: string } }>("probe-server-request");
    expect(result.result).toEqual({
      action: "decline",
    });
  });

  it("includes sanitized stderr context when Codex exits during initialization", async () => {
    const client = trackClient(
      createCodexAppServerClient(
        {},
        {
          command: process.execPath,
          args: [
            "-e",
            String.raw`
process.stderr.write('Codex vendor executable spawn failed: Bearer sk-testsecret1234567890\\n');
process.exit(1);
`,
          ],
        },
      ),
    );

    const error = await client.connect().catch((error: unknown) => error as Error);
    expect(error.message).toContain("Codex vendor executable spawn failed: Bearer [redacted-api-key]");
    expect(error.message).not.toContain("sk-testsecret");
  });
});
