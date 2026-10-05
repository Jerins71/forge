import type Database from "better-sqlite3";
import type { Scope, DeviceSession } from "@forge/protocol/environment-v2";
export interface GrantRow {
  grant_id: string;
  kind: "link" | "code" | "bootstrap";
  credential_hash: string;
  label: string;
  scopes_json: string;
  allowed_origin: string | null;
  created_by: string;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  failed_attempts: number;
  proof_thumbprint: string | null;
}
export interface ChallengeRow {
  challenge_id: string;
  nonce_hash: string;
  expires_at: number;
  used_at: number | null;
}
export interface DeviceRow {
  device_session_id: string;
  token_hash: string;
  proof_thumbprint: string;
  device_name: string;
  kind: "browser" | "desktop" | "cli";
  scopes_json: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}
export const deviceView = (row: DeviceRow, current: string): DeviceSession => ({
  deviceSessionId: row.device_session_id,
  deviceName: row.device_name,
  kind: row.kind,
  scopes: JSON.parse(row.scopes_json) as Scope[],
  createdAt: new Date(row.created_at).toISOString(),
  lastSeenAt: new Date(row.last_seen_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
  revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  isCurrent: row.device_session_id === current,
});
export class AccessStore {
  constructor(readonly database: Database.Database) {}
  device(id: string): DeviceRow | undefined {
    return this.database.prepare("SELECT * FROM device_sessions WHERE device_session_id = ?").get(id) as DeviceRow | undefined;
  }
  token(hash: string): DeviceRow | undefined {
    return this.database.prepare("SELECT * FROM device_sessions WHERE token_hash = ?").get(hash) as DeviceRow | undefined;
  }
  grant(id: string): GrantRow | undefined {
    return this.database.prepare("SELECT * FROM pairing_grants WHERE grant_id = ?").get(id) as GrantRow | undefined;
  }
  code(hash: string): GrantRow | undefined {
    return this.database.prepare("SELECT * FROM pairing_grants WHERE credential_hash = ? AND kind = 'code'").get(hash) as
      GrantRow | undefined;
  }
  challenge(id: string): ChallengeRow | undefined {
    return this.database.prepare("SELECT * FROM pairing_challenges WHERE challenge_id = ?").get(id) as ChallengeRow | undefined;
  }
  prune(now: number): void {
    this.database.prepare("DELETE FROM pairing_challenges WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
    this.database.prepare("DELETE FROM pairing_grants WHERE expires_at <= ?").run(now);
  }
}
