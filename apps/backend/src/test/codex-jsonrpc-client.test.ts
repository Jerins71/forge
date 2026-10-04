import { afterEach, describe, expect, it } from 'vitest'
import { StdioJsonRpcClient, type JsonRpcRequestMessage } from '../swarm/stdio-jsonrpc-client.js'

const activeClients = new Set<StdioJsonRpcClient>()

function createClient(options: {
  script: string
  onRequest?: (request: JsonRpcRequestMessage) => Promise<unknown>
  onExit?: (error: Error) => void
}): StdioJsonRpcClient {
  const client = new StdioJsonRpcClient({
    command: process.execPath,
    args: ['-e', options.script],
    onRequest: options.onRequest,
    onExit: options.onExit,
  })

  activeClients.add(client)
  return client
}

afterEach(() => {
  for (const client of activeClients) {
    client.dispose()
  }
  activeClients.clear()
})

describe('StdioJsonRpcClient', () => {
  it('resolves request/response happy-path results', async () => {
    const client = createClient({
      script: String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'sum') {
    const numbers = Array.isArray(message.params?.numbers) ? message.params.numbers : [];
    const total = numbers.reduce((acc, value) => acc + Number(value || 0), 0);
    send({ id: message.id, result: { total } });
  }
});
`,
    })

    const result = await client.request<{ total: number }>('sum', { numbers: [1, 2, 3, 4] })
    expect(result).toEqual({ total: 10 })
  })
})
