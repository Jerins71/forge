import { createServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { createReplayHarness, type ReplayTranscript } from "../../replay/replay-harness.js";

/** HTTP/SSE peer only. Pi's real SDK parses the frames and owns its agent loop. */
export async function createPiModelPeer(transcript: ReplayTranscript) {
  const harness = await createReplayHarness(() => transcript);
  const socket = connect(harness.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(JSON.stringify({ hello: true }) + "\n");
  const responses: ServerResponse[] = [];
  createInterface({ input: socket }).on("line", line => {
    const message = JSON.parse(line) as { exit?: number; frame?: { chunk?: unknown; end?: boolean; status?: number; body?: unknown } };
    if (message.exit !== undefined) { responses[0]?.destroy(); return; }
    // An HTTP error instead of a stream, as a router answers a refused key or a rate limit.
    if (message.frame?.status !== undefined) { responses.shift()?.writeHead(message.frame.status, { "content-type": "application/json" }).end(JSON.stringify(message.frame.body ?? {})); return; }
    if (responses[0] && !responses[0].headersSent) { responses[0].writeHead(200, { "content-type": "text/event-stream" }); responses[0].flushHeaders(); }
    if (message.frame?.chunk !== undefined) responses[0]?.write(`data: ${JSON.stringify(message.frame.chunk)}\n\n`);
    if (message.frame?.end) { responses[0]?.write("data: [DONE]\n\n"); responses.shift()?.end(); }
  });
  socket.on("close", () => responses[0]?.destroy());
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    responses.push(res);
    socket.write(JSON.stringify({ frame: { method: req.method, path: req.url, body } }) + "\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { ...harness, requests, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    async close() {
      for (const response of responses) response.destroy(); socket.destroy(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await harness.close();
    },
  };
}
