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
  let response: ServerResponse | undefined;
  createInterface({ input: socket }).on("line", line => {
    const message = JSON.parse(line) as { exit?: number; frame?: { chunk?: unknown; end?: boolean } };
    if (message.exit !== undefined) { response?.destroy(); return; }
    if (message.frame?.chunk !== undefined) response?.write(`data: ${JSON.stringify(message.frame.chunk)}\n\n`);
    if (message.frame?.end) { response?.write("data: [DONE]\n\n"); response?.end(); response = undefined; }
  });
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    response = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    socket.write(JSON.stringify({ frame: { method: req.method, path: req.url, body } }) + "\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { ...harness, requests, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    async close() {
      response?.destroy(); socket.destroy(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await harness.close();
    },
  };
}
