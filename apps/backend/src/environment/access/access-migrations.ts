import type Database from 'better-sqlite3';

/** Additive, idempotent access migration in the shared control DB. Tickets are memory-only. */
export function applyAccessMigrations(db: Database.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_grants (
      grant_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('link','code','bootstrap')),
      credential_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, scopes_json TEXT NOT NULL,
      allowed_origin TEXT, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL,
      used_at INTEGER, revoked_at INTEGER, failed_attempts INTEGER NOT NULL DEFAULT 0, proof_thumbprint TEXT
    );
    CREATE TABLE IF NOT EXISTS pairing_challenges (
      challenge_id TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS device_sessions (
      device_session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, proof_thumbprint TEXT NOT NULL,
      device_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('browser','desktop','cli')),
      scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS access_grants_expiry ON pairing_grants(expires_at);
    CREATE INDEX IF NOT EXISTS access_sessions_expiry ON device_sessions(expires_at);
  `))();
}
