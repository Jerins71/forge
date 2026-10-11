import type { Database } from "better-sqlite3";

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS environment_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  environment_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  high_water_sequence INTEGER NOT NULL DEFAULT 0,
  retained_after_sequence INTEGER NOT NULL DEFAULT 0,
  descriptor_version INTEGER NOT NULL DEFAULT 2
);
CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  device_session_id TEXT NOT NULL,
  method TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  command_id TEXT REFERENCES commands(command_id),
  topic TEXT NOT NULL CHECK (topic IN ('shell','detail','receipt')),
  session_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  source_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_topic_sequence ON events(topic, sequence);
CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id, sequence);
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY REFERENCES commands(command_id),
  state TEXT NOT NULL CHECK (state IN ('accepted','running','succeeded','failed','interrupted')),
  accepted_sequence INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL,
  receipt_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_projects (
  project_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL,
  profile_version INTEGER NOT NULL DEFAULT 1,
  profile_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS control_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  launch_command_id TEXT UNIQUE REFERENCES commands(command_id),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running','stopped')),
  run_generation INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL,
  descriptor_version INTEGER NOT NULL DEFAULT 2,
  descriptor_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS control_inputs (
  input_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  session_id TEXT NOT NULL REFERENCES control_sessions(session_id),
  message_json TEXT NOT NULL,
  canonical_entry_id TEXT,
  append_state TEXT NOT NULL CHECK (append_state IN ('pending','recorded')),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending','dispatching','dispatched','unknown')),
  run_generation INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS control_choices (
  choice_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  runtime_generation TEXT NOT NULL,
  state TEXT NOT NULL,
  choice_json TEXT NOT NULL,
  answer_command_id TEXT UNIQUE REFERENCES commands(command_id),
  updated_sequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS detail_items (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  user_turn_id TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  item_json TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_id)
);
CREATE TABLE IF NOT EXISTS control_workers (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  worker_json TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL,
  descriptor_version INTEGER NOT NULL DEFAULT 2,
  descriptor_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE IF NOT EXISTS effects (
  effect_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(command_id),
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  depends_on TEXT REFERENCES effects(effect_id),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','done','failed','interrupted','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  claimed_boot_id TEXT,
  not_before INTEGER NOT NULL DEFAULT 0,
  last_error_json TEXT,
  UNIQUE(command_id, ordinal)
);
CREATE INDEX IF NOT EXISTS effects_ready ON effects(state, not_before);
CREATE TABLE IF NOT EXISTS workspace_reservations (
  reservation_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  session_id TEXT NOT NULL UNIQUE,
  repository_root TEXT NOT NULL,
  repository_common_dir TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  branch TEXT,
  base_commit TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved','ready','failed','interrupted')),
  owned INTEGER NOT NULL CHECK (owned IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS worktree_owned_path ON workspace_reservations(path_key) WHERE owned = 1;
CREATE UNIQUE INDEX IF NOT EXISTS worktree_owned_branch ON workspace_reservations(repository_common_dir, branch) WHERE owned = 1;
CREATE TABLE IF NOT EXISTS mirror_sources (
  source_key TEXT PRIMARY KEY,
  file_generation TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  last_entry_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  device_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE(device_session_id, upload_id)
);
CREATE TABLE IF NOT EXISTS input_artifacts (
  input_id TEXT NOT NULL REFERENCES control_inputs(input_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  PRIMARY KEY(input_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS control_turns (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  agent_id TEXT,
  role TEXT,
  inbound_kind TEXT,
  inbound_id TEXT,
  dispatched_at TEXT,
  terminal_outcome TEXT,
  terminal_at TEXT,
  stalled_tier INTEGER,
  stalled_at TEXT,
  recovery_note TEXT,
  recovery_at TEXT,
  recovery_id TEXT,
  PRIMARY KEY(session_id, turn_id)
);
CREATE TABLE IF NOT EXISTS control_recovery (
  recovery_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decision_applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing_grants (
  grant_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('link','code','bootstrap')),
  credential_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  allowed_origin TEXT,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  proof_thumbprint TEXT
);
CREATE TABLE IF NOT EXISTS pairing_challenges (
  challenge_id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS device_sessions (
  device_session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  proof_thumbprint TEXT NOT NULL,
  device_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('browser','desktop','cli')),
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`;

/** A fresh versioned schema: incompatible databases are preserved and rejected. */
export function migrateControlDatabase(database: Database, identity: { environmentId: string; streamEpoch: string }): void {
  const existing = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  if (existing.length) {
    if (!existing.some(row => row.name === "environment_meta")) throw new Error("Incompatible environment control database; select a fresh data root");
    const meta = database.prepare("SELECT schema_version FROM environment_meta WHERE singleton=1").get() as { schema_version: number } | undefined;
    if (meta?.schema_version !== 3 || !["orchestration_assignments", "orchestration_transfers"].every(name => existing.some(row => row.name === name))) throw new Error("Incompatible environment control schema; select a fresh data root");
    return;
  }
  database.transaction(() => {
    database.exec(INITIAL_SCHEMA);
    database.exec(LIFECYCLE_SCHEMA);
    database.prepare("INSERT INTO environment_meta (singleton,schema_version,environment_id,stream_epoch) VALUES (1,3,?,?)").run(identity.environmentId, identity.streamEpoch);
  }).immediate();
}

const LIFECYCLE_SCHEMA = `
CREATE TABLE lifecycle_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  thread_id TEXT,
  generation INTEGER,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX lifecycle_thread_sequence ON lifecycle_events(thread_id,sequence);
CREATE TABLE orchestration_threads (thread_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
CREATE TABLE orchestration_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, input_id TEXT NOT NULL UNIQUE, state_json TEXT NOT NULL);
CREATE INDEX orchestration_runs_thread ON orchestration_runs(thread_id);
CREATE TABLE orchestration_attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL, state_json TEXT NOT NULL);
CREATE TABLE orchestration_bindings (binding_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation INTEGER NOT NULL, state_json TEXT NOT NULL);
CREATE TABLE orchestration_requests (request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state_json TEXT NOT NULL);
CREATE TABLE orchestration_assignments (assignment_id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL, parent_run_id TEXT NOT NULL, worker_thread_id TEXT NOT NULL, state_json TEXT NOT NULL);
CREATE INDEX orchestration_assignments_parent ON orchestration_assignments(parent_thread_id,parent_run_id);
CREATE INDEX orchestration_assignments_worker ON orchestration_assignments(worker_thread_id);
CREATE TABLE orchestration_transfers (transfer_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('worker_input','worker_result')), source_thread_id TEXT NOT NULL, target_thread_id TEXT NOT NULL, state_json TEXT NOT NULL);
CREATE INDEX orchestration_transfers_target ON orchestration_transfers(target_thread_id);
CREATE TABLE orchestration_recovery (singleton INTEGER PRIMARY KEY CHECK(singleton=1), snapshot_json TEXT NOT NULL);
`;
