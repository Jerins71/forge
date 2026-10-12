// Lineage runs on the Claude fixture, with env-c advertising no context transfers.
process.env.FORGE_E2E_LINEAGE = '1';
await import('./claude-backend-process.js');
