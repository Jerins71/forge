// Pairing runs the ordinary fixture backend, with env-c keeping its default hostname label.
process.env.FORGE_E2E_DEFAULT_LABEL = 'env-c';
await import('./backend-process.js');
