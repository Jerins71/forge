export const STREAM_DECK_SETUP_ENABLED_ENV = 'FORGE_STREAM_DECK_SETUP_ENABLED'

export function isStreamDeckSetupEnabled(environment = process.env) {
  return environment[STREAM_DECK_SETUP_ENABLED_ENV]?.trim().toLowerCase() === 'true'
}
