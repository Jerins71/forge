import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  SECURE_SESSION_MIGRATIONS,
  runSecureSessionMigrations
} from "../secure-sessions/storage/secure-session-migrations.js";

describe("secure session migrations", () => {
  it("applies transactionally, reruns idempotently, and passes integrity checks", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runSecureSessionMigrations(database);
    runSecureSessionMigrations(database);

    expect(database.prepare(
      "SELECT version, name FROM secure_session_schema_migrations ORDER BY version"
    ).all()).toEqual(
      SECURE_SESSION_MIGRATIONS.map(({ version, name }) => ({ version, name }))
    );
    expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.prepare(
      "SELECT revision FROM secure_session_catalog_state WHERE id = 1"
    ).get()).toEqual({ revision: 0 });
    expect(database.pragma("table_info('secure_session_secret')"))
      .toContainEqual(expect.objectContaining({ name: "username", notnull: 0 }));
    expect(database.pragma("table_info('secure_session_request')"))
      .toContainEqual(expect.objectContaining({ name: "username", notnull: 0 }));
    database.close();
  });

  it("rejects migration ledger tampering and unknown migrations", () => {
    const database = new Database(":memory:");
    runSecureSessionMigrations(database);
    database.prepare(`
      UPDATE secure_session_schema_migrations SET name = 'tampered' WHERE version = 1
    `).run();
    expect(() => runSecureSessionMigrations(database)).toThrow(/ledger mismatch/);

    database.prepare(`
      UPDATE secure_session_schema_migrations SET name = ? WHERE version = 1
    `).run(SECURE_SESSION_MIGRATIONS[0]?.name);
    database.prepare(`
      INSERT INTO secure_session_schema_migrations (version, name, applied_at)
      VALUES (999, 'unknown', ?)
    `).run(new Date().toISOString());
    expect(() => runSecureSessionMigrations(database)).toThrow(/ledger mismatch/);
    database.close();
  });
});
