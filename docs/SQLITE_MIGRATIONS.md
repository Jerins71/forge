# SQLite migration policy

Forge keeps structured state in SQLite and user-authored content (prompts, reference docs, specialists,
skills, memory) in files. These rules apply to every Forge SQLite database and its migrations.

- Run migrations automatically at startup.
- Prefer additive schema changes.
- Wrap each migration in a transaction.
- Make migrations idempotent and safe to rerun.
- Back up the database before non-trivial migrations, and preserve `${FORGE_DATA_DIR}/swarm/agents.json`
  whenever session identity could be affected.
- Fail cleanly without destructive partial state.
- Do not delete, overwrite, or normalize user-authored markdown or other file-backed content from a
  database migration.
- Do not silently drop references to missing user configuration; surface them as invalid or missing.
- Preserve semantic differences such as `NULL` versus `[]`.

If state is user-authored prose or reusable agent content, keep it file-backed unless a design explicitly
changes that boundary.
