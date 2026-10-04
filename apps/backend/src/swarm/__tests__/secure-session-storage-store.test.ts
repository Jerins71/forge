import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import { runSecureSessionMigrations, SECURE_SESSION_MIGRATIONS } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-23T12:00:00.000Z";

describe("SecureSessionStore", () => {
  it("persists a private catalog while returning material-free lists and atomic revisions", () => {
    const { database, store } = createMemoryStore();
    store.upsertProvider({
      providerId: "local",
      kind: "local_keychain",
      displayName: "Local keychain"
    });
    const result = store.createSecretWithBindings({
      secret: {
        secretId: "secret-1",
        providerId: "local",
        displayAlias: "deploy-token",
        displayName: "Deploy token",
        username: "deploy-user",
        note: "Used by the production deploy workflow.",
        scopeKind: "instance",
        retention: "saved",
        sourceLocator: "local:secret-1",
        encryptedMaterial: Buffer.from("safe-storage-ciphertext")
      },
      bindings: [
        { bindingId: "env", deliveryKind: "environment", targetName: "DEPLOY_TOKEN" },
        { bindingId: "stdin", deliveryKind: "stdin" }
      ]
    });

    expect(result.bindings.map(({ bindingId }) => bindingId)).toEqual(["env", "stdin"]);
    expect(store.getCatalogState().revision).toBe(4);
    expect(store.listSecrets()).toEqual([
      expect.objectContaining({
        secretId: "secret-1",
        displayAlias: "deploy-token",
        username: "deploy-user",
        note: "Used by the production deploy workflow.",
        retention: "saved"
      })
    ]);
    expect(store.listSecrets()[0]).not.toHaveProperty("encryptedMaterial");
    expect(store.getEncryptedSecret("secret-1")).toEqual(expect.objectContaining({
      sourceLocator: "local:secret-1",
      username: "deploy-user",
      note: "Used by the production deploy workflow.",
      encryptedMaterial: Buffer.from("safe-storage-ciphertext")
    }));

    const before = store.getCatalogState();
    expect(() => store.updateSecretWithBindings({
      secret: {
        secretId: "secret-1",
        providerId: "local",
        displayAlias: "changed-alias",
        scopeKind: "instance",
        retention: "saved",
        sourceLocator: "local:secret-1",
        encryptedMaterial: Buffer.from("new-ciphertext")
      },
      bindings: [
        { bindingId: "bad", deliveryKind: "file" }
      ]
    })).toThrow(/target path/);
    expect(store.getSecret("secret-1")?.displayAlias).toBe("deploy-token");
    expect(store.getCatalogState()).toEqual(before);
    database.close();
  });

  it("allows only one one-use claim across independent SQLite connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-store-cas-"));
    const dbPath = join(directory, "secure-sessions.db");
    const firstDatabase = new Database(dbPath);
    firstDatabase.pragma("journal_mode = WAL");
    firstDatabase.pragma("foreign_keys = ON");
    firstDatabase.pragma("busy_timeout = 5000");
    runSecureSessionMigrations(firstDatabase);
    const first = new SecureSessionStore(firstDatabase, undefined, () => new Date(NOW));
    seedLocalCatalog(first);
    first.getOrCreateSessionState("session", { profileId: "profile" });
    first.createLease({
      leaseId: "lease",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "one_use",
      baseRevision: 0
    });

    const secondDatabase = new Database(dbPath);
    secondDatabase.pragma("journal_mode = WAL");
    secondDatabase.pragma("foreign_keys = ON");
    secondDatabase.pragma("busy_timeout = 5000");
    runSecureSessionMigrations(secondDatabase);
    const second = new SecureSessionStore(secondDatabase, undefined, () => new Date(NOW));

    const attempts = await Promise.all([
      Promise.resolve().then(() => first.reserveLeaseUse({
        operationId: "operation-a",
        leaseId: "lease",
        sessionAgentId: "session"
      })),
      Promise.resolve().then(() => second.reserveLeaseUse({
        operationId: "operation-b",
        leaseId: "lease",
        sessionAgentId: "session"
      }))
    ]);
    expect(attempts.filter(({ reserved }) => reserved)).toHaveLength(1);
    expect(attempts.filter(({ reserved }) => !reserved)).toHaveLength(1);
    expect(firstDatabase.pragma("quick_check", { simple: true })).toBe("ok");
    secondDatabase.close();
    firstDatabase.close();
  });

  it("survives close/reopen with pending requests, snapshots, and quick_check intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-store-restart-"));
    const dbPath = join(directory, "secure-sessions.db");
    const options = { dbPath, loadDatabaseModule: async () => Database };
    const first = await SecureSessionStore.open(options, () => new Date(NOW));
    seedLocalCatalog(first);
    first.createSecret({
      secretId: "multi-project-secret",
      providerId: "local",
      displayAlias: "multi-project",
      note: "Persists across Forge restarts.",
      scopeKind: "profile",
      profileIds: ["profile-b", "profile-a"],
      retention: "saved",
      sourceLocator: "local:multi-project-secret",
      encryptedMaterial: Buffer.from("safe-storage-multi-project-ciphertext")
    });
    first.putProjectDefault({ profileId: "profile", secretId: "secret" });
    first.getOrCreateSessionState("session", { profileId: "profile" });
    first.createRequest({
      requestId: "request",
      sessionAgentId: "session",
      displayAlias: "missing-alias",
      requestedExposures: [{ deliveryKind: "stdin" }],
      requestedLeaseKind: "one_use",
      purposeSummary: "Authenticate the reviewed operation",
      requestedByAgentId: "session",
      requestedByDisplayName: "Worker"
    });
    first.createLease({
      leaseId: "project-default-lease",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      grantSource: "project_default",
      baseRevision: 1
    });
    await first.close();

    const second = await SecureSessionStore.open(options, () => new Date(NOW));
    expect(second.getSnapshot("session")).toEqual(expect.objectContaining({
      state: expect.objectContaining({ revision: 2, profileId: "profile" }),
      leases: [expect.objectContaining({
        leaseId: "project-default-lease",
        grantSource: "project_default"
      })],
      requests: [expect.objectContaining({
        requestId: "request",
        secretId: null,
        requestedExposures: [expect.objectContaining({ deliveryKind: "stdin" })]
      })]
    }));
    expect(second.listProjectDefaults("profile")).toEqual([
      expect.objectContaining({ secretId: "secret" })
    ]);
    expect(second.getSecret("multi-project-secret")).toEqual(
      expect.objectContaining({
        note: "Persists across Forge restarts.",
        profileId: "profile-a",
        profileIds: ["profile-a", "profile-b"]
      })
    );
    await second.close();

    const verification = new Database(dbPath, { readonly: true });
    expect(verification.pragma("quick_check", { simple: true })).toBe("ok");
    verification.close();
  });

  it("enforces project ownership, prunes invalid defaults on scope changes, and cleans up projects", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.createSecretWithBindings({
      secret: {
        secretId: "project-secret",
        providerId: "local",
        displayAlias: "project-token",
        scopeKind: "profile",
        profileId: "project-a",
        retention: "saved",
        sourceLocator: "local:project-secret",
        encryptedMaterial: Buffer.from("safe-storage-project-ciphertext")
      },
      bindings: [{
        bindingId: "project-binding",
        deliveryKind: "environment",
        targetName: "PROJECT_TOKEN"
      }]
    });
    store.putProjectDefault({ profileId: "project-a", secretId: "project-secret" });
    expect(() => store.putProjectDefault({
      profileId: "project-b",
      secretId: "project-secret"
    })).toThrow(/another project's secret/);

    store.updateSecret({
      secretId: "project-secret",
      providerId: "local",
      displayAlias: "project-token",
      scopeKind: "profile",
      profileId: "project-b",
      retention: "saved",
      sourceLocator: "local:project-secret",
      encryptedMaterial: Buffer.from("safe-storage-project-ciphertext")
    });
    expect(store.listProjectDefaults()).toEqual([]);
    store.putProjectDefault({ profileId: "project-b", secretId: "project-secret" });
    store.putProjectDefault({ profileId: "project-b", secretId: "secret" });
    expect(store.deleteProjectSecretState("project-b")).toEqual({
      projectDefaultsDeleted: 2,
      secretsDeleted: 1,
      secretsUpdated: 0,
      trustedSshHostsDeleted: 0
    });
    expect(store.getSecret("project-secret")).toBeNull();
    expect(store.getSecret("secret")).not.toBeNull();
    expect(store.listProjectDefaults("project-b")).toEqual([]);
    store.putProjectDefault({ profileId: "project-c", secretId: "secret" });
    expect(store.deleteSecret("secret")).toBe(true);
    expect(store.listProjectDefaults("project-c")).toEqual([]);

    store.createSecret({
      secretId: "session-secret",
      providerId: "local",
      displayAlias: "session-token",
      scopeKind: "profile",
      profileId: "project-b",
      retention: "session",
      sourceLocator: "local:session-secret",
      encryptedMaterial: Buffer.from("safe-storage-session-ciphertext")
    });
    expect(() => store.putProjectDefault({
      profileId: "project-b",
      secretId: "session-secret"
    })).toThrow(/Session-only secrets/);
    database.close();
  });

  it("preserves a populated v8 secure-session graph when migrating to the current schema and rerunning after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-v8-migration-"));
    onTestFinished(async () => await rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "secure.sqlite");
    let database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      runSecureSessionMigrationsThrough(database, 8);

      const providerCiphertext = Buffer.from("provider-ciphertext");
      const secretCiphertext = Buffer.from("secret-ciphertext");
      database.prepare(`
        INSERT INTO secure_session_provider (
          provider_id, kind, display_name, enabled, status, last_verified_at,
          last_status_code, server_origin, organization_id, project_id,
          encrypted_access_token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "bws", "bitwarden_secrets_manager", "Bitwarden", 1, "available", NOW,
        "ok", "https://vault.example.test", "org-1", "project-1",
        providerCiphertext, NOW, NOW
      );
      database.prepare(`
        INSERT INTO secure_session_secret (
          secret_id, provider_id, display_alias, display_name, scope_kind,
          profile_id, retention, source_locator, encrypted_material, created_at,
          updated_at, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "secret", "bws", "deploy-token", "Deploy token", "profile",
        "profile", "saved", "bitwarden:item-1", secretCiphertext, NOW, NOW,
        "Production deployment credential"
      );
      database.prepare(`
        INSERT INTO secure_session_secret_scope_profile (
          secret_id, profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
      `).run("secret", "profile", NOW, NOW);
      database.prepare(`
        INSERT INTO secure_session_binding (
          binding_id, secret_id, delivery_kind, target_name, target_path,
          file_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run("binding", "secret", "environment", "DEPLOY_TOKEN", NOW, NOW);
      database.prepare(`
        INSERT INTO secure_session_project_default (
          profile_id, secret_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
      `).run("profile", "secret", NOW, NOW);
      database.prepare(`
        INSERT INTO secure_session_state (
          session_agent_id, revision, forked_from_session_agent_id, profile_id,
          execution_mode, environment_status, created_at, updated_at,
          principal_kind, owner_manager_agent_id, worker_assignment_id
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run("manager", 1, "profile", "secure", "ready", NOW, NOW, "manager");
      database.prepare(`
        INSERT INTO secure_session_revision (
          session_agent_id, revision, event_type, lease_id, affected_count,
          occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run("manager", 1, "lease_created", "lease", 1, NOW);
      database.prepare(`
        INSERT INTO secure_session_lease (
          lease_id, session_agent_id, secret_id, request_id, lease_kind, state,
          issued_revision, updated_revision, expires_at, last_used_at,
          remaining_uses, revoked_at, revocation_reason, one_use_operation_id,
          created_at, updated_at, grant_source
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(
        "lease", "manager", "secret", "task", "active", 1, 1, NOW, NOW,
        "project_default"
      );
      database.prepare(`
        INSERT INTO secure_session_lease_binding (lease_id, binding_id)
        VALUES (?, ?)
      `).run("lease", "binding");
      database.prepare(`
        INSERT INTO secure_session_audit (
          event_type, session_agent_id, profile_id, principal_kind,
          owner_manager_agent_id, worker_assignment_id, provider_id, secret_id,
          binding_id, request_id, lease_id, operation_id, outcome, occurred_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?)
      `).run(
        "lease_created", "manager", "profile", "manager", "bws", "secret",
        "binding", "lease", "created", NOW
      );

      runSecureSessionMigrations(database);
      const assertGraph = () => {
        const store = new SecureSessionStore(database, undefined, () => new Date(NOW));

        expect(store.getProvider("bws")).toEqual(expect.objectContaining({
          providerId: "bws",
          kind: "bitwarden_secrets_manager",
          displayName: "Bitwarden"
        }));
        expect(store.getProviderBackendConfig("bws")).toEqual(expect.objectContaining({
          serverOrigin: "https://vault.example.test",
          organizationId: "org-1",
          projectId: "project-1",
          encryptedAccessToken: providerCiphertext
        }));
        expect(store.getEncryptedSecret("secret")).toEqual(expect.objectContaining({
          encryptedMaterial: secretCiphertext,
          note: "Production deployment credential"
        }));
        expect(database.prepare(
          "SELECT secret_id, profile_id FROM secure_session_secret_scope_profile"
        ).all()).toEqual([{ secret_id: "secret", profile_id: "profile" }]);
        expect(store.listBindings("secret")).toEqual([
          expect.objectContaining({ bindingId: "binding", targetName: "DEPLOY_TOKEN" })
        ]);
        expect(store.listEffectiveProjectDefaults("profile")).toEqual([
          expect.objectContaining({ secretId: "secret" })
        ]);
        expect(store.getSnapshot("manager").leases).toEqual([
          expect.objectContaining({
            leaseId: "lease",
            bindingIds: ["binding"],
            grantSource: "project_default",
            state: "active"
          })
        ]);
        expect(store.listAudit("manager")).toEqual([
          expect.objectContaining({
            eventType: "lease_created",
            providerId: "bws",
            secretId: "secret",
            bindingId: "binding",
            leaseId: "lease",
            outcome: "created"
          })
        ]);
        expect(database.pragma("foreign_key_check")).toEqual([]);
        expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(database.pragma("quick_check", { simple: true })).toBe("ok");
      };
      assertGraph();
      const ledger = database.prepare(
        "SELECT * FROM secure_session_schema_migrations ORDER BY version"
      ).all();
      expect(ledger).toEqual(SECURE_SESSION_MIGRATIONS.map(({ version, name }) =>
        expect.objectContaining({ version, name })
      ));
      const snapshot = new SecureSessionStore(database, undefined, () => new Date(NOW))
        .getSnapshot("manager");
      database.close();
      database = new Database(databasePath);
      database.pragma("foreign_keys = ON");
      assertGraph();
      runSecureSessionMigrations(database);
      assertGraph();
      expect(database.prepare(
        "SELECT * FROM secure_session_schema_migrations ORDER BY version"
      ).all()).toEqual(ledger);
      expect(new SecureSessionStore(database, undefined, () => new Date(NOW))
        .getSnapshot("manager")).toEqual(snapshot);
    } finally {
      database.close();
    }
  });
});

function runSecureSessionMigrationsThrough(
  database: Database.Database,
  targetVersion: number
): void {
  database.exec(`
    CREATE TABLE secure_session_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  for (const migration of SECURE_SESSION_MIGRATIONS) {
    if (migration.version > targetVersion) break;
    database.pragma(`foreign_keys = ${migration.requiresForeignKeysOff ? "OFF" : "ON"}`);
    database.transaction(() => {
      migration.up(database);
      database.prepare(`
        INSERT INTO secure_session_schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, NOW);
    })();
    database.pragma("foreign_keys = ON");
  }
}

function createMemoryStore(): {
  database: Database.Database;
  store: SecureSessionStore;
} {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  return {
    database,
    store: new SecureSessionStore(database, undefined, () => new Date(NOW))
  };
}

function seedLocalCatalog(store: SecureSessionStore): void {
  store.upsertProvider({
    providerId: "local",
    kind: "local_keychain",
    displayName: "Local"
  });
  store.createSecretWithBindings({
    secret: {
      secretId: "secret",
      providerId: "local",
      displayAlias: "deploy-token",
      scopeKind: "instance",
      retention: "saved",
      sourceLocator: "local:secret",
      encryptedMaterial: Buffer.from("safe-storage-ciphertext")
    },
    bindings: [{
      bindingId: "binding",
      deliveryKind: "environment",
      targetName: "TOKEN"
    }]
  });
}
