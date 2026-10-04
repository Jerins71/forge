import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// Reuse the backend's existing WS dependency; no extra root runtime dependency.
const require = createRequire(fileURLToPath(new URL('../../../apps/backend/package.json', import.meta.url)));
const ws = require('ws') as typeof import('ws');
export const WebSocket = ws.WebSocket;
export const WebSocketServer = ws.WebSocketServer;
