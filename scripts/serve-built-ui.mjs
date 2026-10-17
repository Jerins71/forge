#!/usr/bin/env node
// Serves the production UI build for `pnpm dev:electron` with FORGE_UI_BUILD=true.
// Usage: node scripts/serve-built-ui.mjs <port>
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'ui', '.output', 'public')
const port = Number(process.argv[2])
const types = {
  '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
}

http.createServer(async (request, response) => {
  const requested = path.join(root, path.normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://ui').pathname)))
  // Unknown paths are app routes; the single-page shell handles them.
  const files = requested.startsWith(root + path.sep) && path.extname(requested) ? [requested] : [path.join(root, '_shell.html')]
  for (const file of files) {
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
      response.end(body)
      return
    } catch {}
  }
  response.writeHead(404).end()
}).listen(port, process.env.FORGE_HOST ?? '127.0.0.1')
