# AOM Phase 10B.2 — Integration-Generation Schema Foundation

## Scope and status

This implementation is limited to the inert AOM-owned `integrations` schema
foundation. It adds no delegation table, issuer, delegation request path,
epoch runtime, quota runtime, edge role, public write, worker dispatch,
Gateway change, or `codex_decide` change.

Parent checkpoint:

- `659d9c73b31371f1d64e5658a7e060f5497bc53e`
- tree `86199b4daf4f6590674d5ca4d46d4163f11ab822`

Implementation branch: `codex/phase10b2-integration-foundation`

## Schema v8

Migration `008_integration_generation_foundation.sql` creates exactly one new
table:

```text
integrations(
  integration_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

`integration_id` is an independent opaque AOM-owned identity. It is not a
Gateway client ID, OAuth client ID, ChatGPT session ID, actor ID, token ID,
hostname, network identity, or Tailscale identity. Migration v8 seeds zero
rows, and no production integration-create API exists.

The database enforces:

- non-empty integration identity and timestamps;
- canonical `enabled` values `0`/`1`;
- non-negative generation with default `0`;
- immutable `integration_id` and `created_at`;
- non-decreasing generation;
- rejection of replacement inserts for an existing identity.

`enabled` has no current runtime consumer and never grants authority.
Generation changes are not automatically coupled to `enabled` changes.

## Schema version guard changes

The v7 assumptions were expanded mechanically to the canonical v8 schema:

- `src/store/migrations.ts`: the exact migration allow-list is now `1..8`.
- `src/store/schemaDefinitions.ts`: canonical v8 table and trigger
  fingerprints were added; v1..v7 fingerprints were preserved.
- `src/store/integrity.ts`: table/column expectations are version-specific;
  v8 requires 14 tables and 33 triggers while v7 still requires its original
  13 tables and 30 triggers. Unknown or future versions remain rejected.
- `src/authority/runtime.ts`: the existing exact startup requirement changed
  from schema `7` to schema `8` so the normal migration path can serve the
  canonical v8 store.
- `src/store/init.ts`: the result type and exact Phase 4 bootstrap guard now
  recognize schema `8`.

These changes only recognize and verify the new canonical schema. They do not
change actor roles, capabilities, authentication, AuthorizationContext,
policy behavior, principal semantics, observer semantics, worker semantics,
or authority validation.

## Delegation boundary

There is no `delegations` table and no delegation authority in v8. The future
opaque presentation handle will be at least 256-bit CSPRNG material, with
only a lookup digest persisted; a future `delegation_ref` must never authorize
by itself. Operation/tool duplication, request hashing, resource scope, tier,
epoch, quota, revocation, and consumption remain deferred to later reviewed
stages.

## Validation

The implementation snapshot was tested in a disposable clean worktree with no
copied `node_modules`:

- `npm ci`: PASS
- `npm run ci`: PASS
- `npm run build`: PASS
- `npm audit --omit=dev`: PASS, `0 vulnerabilities`
- Tests: `62` files, `575` passed, `7` skipped

The fresh `1..8` migration and v7-to-v8 migration produced equivalent
canonical schema objects. SQLite `quick_check` returned `ok`,
`foreign_key_check` returned zero rows, and the v7 data-preservation fixture
was unchanged. Adversarial tests cover default/negative/increasing/decreasing
generation, identity and creation-time immutability, malformed fields,
duplicate/replacement inserts, future schema rejection, rollback, close/reopen
persistence, no delegation table, zero seed rows, and unchanged bootstrap
authority semantics.

## Live v7 backup and migration

Before applying v8, the live v7 database was checked with
`integrity_check=ok`, `quick_check=ok`, and zero foreign-key violations. AOM
actor checks passed and the integrations table was absent.

SQLite online backup:

- directory: `C:\Users\kingm\AppData\Local\AOM-Recovery-Backups\phase10b2-v7-20260903-113416354`
- database: `orchestrator.db`
- SHA-256: `661B791F6604937CBCAAD857A7F269A9936FA202E4E88A7DCF958098B882B848`
- size: `221184` bytes
- WAL/SHM were present; consistency was provided by SQLite online backup.

The migration was applied through the supported AOM startup path. Post-
migration checks passed:

- schema migrations: `1..8`;
- schema version: `8`;
- canonical integrity and audit-chain verification: PASS;
- `quick_check`: `ok`;
- `foreign_key_check`: zero violations;
- integrations rows: `0`;
- delegations table: absent;
- existing v7 data: preserved;
- AOM restart persistence: PASS.

The existing Gateway was not changed or restarted. Its downstream credential
still resolves to `chatgpt_edge_reader` with role `observer` and capability
`job:read`; no principal match occurred. Gateway downstream `ping` and
`job_list` both returned HTTP 200, and the configured public surface remains
exactly `ping`, `job_list`, `job_get`, and `run_status`.

No secret, token, digest, or DPAPI value was printed or persisted in the
repository. No live write, worker dispatch, authority operation, or ChatGPT
public-write test was performed.

## Next gate

Stop after the local implementation commit and submit the exact commit for an
independent schema/security implementation review. Phase 10B.3 remains
separately unauthorized. M-1 remains deferred to 10B.4.
