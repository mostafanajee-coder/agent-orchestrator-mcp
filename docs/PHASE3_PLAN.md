# Phase 3 Plan — Store & Database Authority

> **IMPLEMENTED — PHASE 3 STORE & DATABASE AUTHORITY — REVISION 7 F-1 REMEDIATION**
>
> Phase 3 is implemented on the implementation branch. Phase 4 authority/auth,
> job, worker, and later runtime behavior remains unimplemented.

Date: 2026-08-30
Authoritative repository: `C:\AgentProjects\agent-orchestrator-mcp`
Authoritative implementation base: `d255a5b2062f38c475cfb83c080e6bd98754505c`
External benchmark: `C:\AgentProjects\aom-benchmark\AOM_EXTERNAL_BENCHMARK.md`
Implementation status: **REVISION 7 F-1 REMEDIATION IMPLEMENTED — READY FOR FINAL RE-REVIEW**

## 1. Phase 3 objectives

Phase 3 is **STORE & DATABASE AUTHORITY**. Its purpose is to create the one
durable, local SQLite source of truth on which the later authority, job, worker,
evidence, artifact, audit, and recovery phases can rely.

The Phase 3 implementation provides the following within this separately
authorized change:

1. the direct `better-sqlite3` store dependency;
2. deterministic numbered migrations and schema-version refusal;
3. the complete approved V1 table model;
4. reference seeds for decision grants and authoritative-status ranks;
5. `actors` and `actor_tokens` schema persistence without bearer plaintext,
   without activating production authentication;
6. thin table-oriented repositories and transaction primitives;
7. the exact T1–T8 database authority protections;
8. canonical startup database/schema integrity checks;
9. raw-SQL adversarial tests that bypass TypeScript repositories;
10. a documented Phase 4 hand-off for principal bootstrap and the transition
    from the Phase 2 environment resolver to the persistent `actor_tokens`
    resolver; the hand-off is not implemented here.

Phase 3 will not implement the job API, worker execution, MCP tool expansion,
or later resilience behavior. It may provide repository primitives and schema
fixtures required to prove that those later operations can be atomic.

## 2. Authoritative inputs and decision precedence

### 2.1 Inputs

| Input | Authority/use |
|---|---|
| `docs/ARCHITECTURE.md` Revision 7 | Design of record. Exact table names, state/status meanings, T1–T8 trigger semantics, canonical schema definitions, paths, phase boundaries, and the doctor/init/serve ownership split come from this document. Revisions 5 and 6 remain historical context. |
| `docs/PHASE2_PROTOCOL.md` | Historical Phase 2 protocol/API observation; confirms the installed SDK and observed Codex legacy era. It does not redefine Phase 3 schema authority. |
| `README.md` | Current Phase 3 operational behavior, Phase 2 transport contract, and state-root/security user contract. |
| `C:\AgentProjects\aom-benchmark\AOM_EXTERNAL_BENCHMARK.md` | Advisory external evidence. It may strengthen an implementation choice, but cannot silently change the architecture. |
| Authoritative Phase 3 implementation base `d255a5b2062f38c475cfb83c080e6bd98754505c` | Starting source tree for the reviewed implementation and remediation; no old backup clone or rewritten pre-Phase-3 history is used. |

### 2.1.1 Revision 6 remediation authority

The principal-approved Revision 6 correction is narrow and additive. T1–T6,
the approved `001`/`002` SQL semantics, the Phase 2 MCP spine, and the Phase 4
design hand-off remain unchanged. Migration `003_job_row_integrity_and_schema_verification.sql`
adds T7: jobs are durable ledger roots, must be inserted with NULL authority
columns and a non-authoritative state, and cannot be deleted at runtime. Init
and serve additionally verify canonical normalized SQL definitions for every
approved table, security-sensitive index, and physical T1–T7 trigger. Failed
fresh initialization closes SQLite before removing only its own DB/WAL/SHM
artifacts; the original failure is preserved. The migration copy step clears
its exact destination, the transaction callback is synchronous-only, and the
implemented repository inventory is the single `src/store/repositories.ts`
module.

### 2.1.2 Revision 7 F-1 remediation authority

The independent F-1 reproduction is accepted. On the real migrated schema,
with `recursive_triggers=OFF`, SQLite `INSERT OR REPLACE` and bare `REPLACE`
can remove a conflicting row without firing a `BEFORE DELETE` trigger. This
made Revision 6's DELETE-only durability claim incomplete for `jobs`,
`decisions`, and `audit_log`. Revision 7 therefore adds migration
`004_row_replacement_integrity.sql` with three INSERT-side identity-existence
guards. It also enables and verifies `recursive_triggers=ON` on AOM-owned
connections as defense in depth, while the schema guards must independently
reject replacement from arbitrary external connections with that setting OFF.
No historical migration is rewritten and no Phase 4 behavior is activated.

### 2.2 Architecture-versus-benchmark reconciliation

| ARCHITECTURE_REQUIREMENT | BENCHMARK_RECOMMENDATION | CONFLICT | RECOMMENDED_RESOLUTION |
|---|---|---|---|
| One SQLite database is the source of truth for all projects and all V1 persistence. | Do not add JSON registries, Redis, MongoDB, Postgres, cloud stores, or a second lease store. | None. | Use only `<state root>\data\orchestrator.db`; treat caches as disposable and non-authoritative. |
| `actor_tokens` is many-to-one to actors; only token hashes are stored; one principal supports multiple Codex sessions. | Preserve the exact fields: `token_id`, `actor_id`, `token_sha256`, `label`, `disabled`, `expires_at`, `last_used_at`, and `created_at`; do not add token scopes. | None after this correction. | Keep the exact `actor_tokens` name and columns from §9. Future `AuthInfo.scopes` derives from `actors.capabilities_json`, not token rows. |
| Leases are single-use and bound to `(job_id, cycle, run_id)` and an actor. | Make every lease lookup identity- and target-scoped; a raw lease/session hint cannot establish authority. | The approved SQL redundantly stores `job_id`/`cycle` beside the `run_id` FK without showing a composite FK. | The approved Phase 3 structural guard is unconditional: add `UNIQUE worker_runs(run_id, job_id, cycle)` and the matching composite FK from `leases`, while retaining the approved `run_id` UNIQUE/FK. Present it as a supporting integrity measure, not a replacement for T1–T6. |
| Capabilities are a fixed catalogue validated at load; worker verdicts never become authority. | Use strict schemas and keep worker evidence as data. | No capability table is present in the approved schema. | Do not invent a `capabilities` table. Validate `actors.capabilities_json` against the static catalogue at the config/actor boundary; T1–T4 remain the final authority barrier. |
| T1–T6 and their exact error semantics are the DB authority boundary; T7 owns job-row lifecycle integrity. | Add raw-SQL tests and freeze security-relevant reference data after seeding. | None. | Copy T1–T6 unchanged and add the two approved T7 triggers. Any supporting CHECK/FK or lease/token binding guard must not weaken or replace them. |
| Workspace roots and worker registry are configuration/runtime boundaries, not the Phase 3 authority schema. | Add strict URL/ID and boundary validation only where relevant. | There is no approved workspace/config table or remote URL feature. | Keep config in the approved config file and `jobs.workspace`; use application/Phase 1 path validation. Do not add remote egress or a registry table. |
| Phase 3 owns persistence but later phases own active workflows/tools. | Define process/runtime contracts before implementation, but defer them. | None. | Create no `job_create`, `qa_dispatch`, `run_report`, worker runtime, or new MCP registration in this phase. |
| AOM’s local ACL/print-once secret model remains V1. | Do not add keytar, PM2, Pino, OpenTelemetry, Cockatiel, Python, or Rust dependencies in Phase 3. | None. | Add only the already-approved `better-sqlite3` dependency when implementation is explicitly authorized; add nothing now. |

### 2.3 Benchmark P0 traceability

Every benchmark P0 item is accounted for:

| Benchmark P0 item | Classification | Where incorporated |
|---|---|---|
| Preserve PR #4 startup gate | ALREADY IN ARCHITECTURE / INCORPORATED | §4, §11, §12; Phase 3 opens the DB only after the existing Phase 1 gate. |
| SQLite-only durable authority | INCORPORATED | §4, §5, §6, §11. |
| Many-to-one `actor_tokens`, hash-only, unique digest, expiry/disabled | INCORPORATED (schema only; activation is Phase 4) | §7, §8, §10, §13. |
| Actor/job/cycle/run-scoped leases | INCORPORATED (schema/structural binding only; active use is Phase 6) | §6, §8, §9, §10, §13. |
| Strict boundary schemas with existing Zod v4 | INCORPORATED | §5, §6, §10, §14. |
| Atomic repository primitives for later workflows | INCORPORATED | §6, §12, §15. |
| No remote/cloud/dynamic loading in Phase 3 | INCORPORATED / DEFERRED WITH REASON | §3, §15, §16. |

No P0 item is omitted. The benchmark’s P1/P2 process, retry, Windows Job
Object, remote-egress, and observability recommendations are explicitly
deferred to the phases that own those behaviors; see §16.

### 2.4 Architecture section traceability

The plan was checked against the complete architecture document by section and
requirement family. The following map records where each design-of-record
section is preserved:

| Architecture section | Preserved requirement | Plan coverage |
|---|---|---|
| Revision Delta / Context / §§1–3 | Codex-only authority, local-first V1, TypeScript/Node, one global state root, official MCP SDK, no browser dependency in core | §§2–4, §16 |
| §4 Codex Authority Model | Five layers, semantic grants, T1–T8, worker-verdict separation, and the principal/system hand-off | §§5, 7, 9, 10, 13; invariant 16 is Phase 3 and exactly-one-enabled activation is Phase 4 |
| §5 Worker Trust Model | Worker evidence is untrusted data; capability grants and leases are narrow/expiring | §§3, 10, 16 |
| §6 Job State Machine | Exact workflow/authoritative states and transition ownership; no Phase 3 active tools | §§5, 16 |
| §7 MCP Transport Decision | Loopback HTTP, authenticated stdio, dual-era official SDK, MCP control plane versus NDJSON execution plane | §§3, 4, 14, 16 |
| §8 MCP Tool Surface | Exact later tool names and capabilities remain excluded from Phase 3 | §§3, 16 |
| §9 Data Model / SQLite Schema | All 13 exact tables, columns, keys, indexes, PRAGMAs, one DB | §§4–6, 8 |
| §§10–12 Worker/Gemini/Browser design | Process adapter and external integrations remain later hand-offs | §§3, 16, 17 |
| §13 Artifact & Evidence Model | Metadata-only files, path jail, hashes, trust/size boundaries | §5 and Phase 7 hand-off in §16 |
| §14 Audit Model | Append-only hash chain, verified session attribution, redaction | §§5, 7, 11, 12, 15 |
| §15 Security Threat Model | Startup, path, token, worker, authority, concurrency, and secret invariants | §§4, 6, 7, 9, 12, 13 |
| §16 Failure & Recovery | Startup DB integrity and later recovery/reaper ownership | §12 and §16 |
| §17 Concurrency / Locking / Idempotency | `BEGIN IMMEDIATE`, atomic dispatch/report primitives, CAS/idempotency contracts | §§6, 11, 13, 15 |
| §18 Repository Structure & Runtime Paths | Exact state path and future store/repository placement | §§4, 11 |
| §19 Testing Strategy | Named invariants, raw-SQL bypass, migration/ACL/secret boundaries | §§13, 15 |
| §20 V1 Scope | Must-have store versus later/never items | §§3, 16 |
| §21 Implementation Phases | Phase 3 deliverable and hand-off order | §§1, 8, 17 |
| §§22–23 Open Questions / Recommendation | Only remaining questions are documented; Phase 3 follows principal review | §§2, 9, 18 |

## 3. Exact Phase 3 scope

### 3.1 In scope

- SQLite persistence at the architecture-designated path.
- Direct `better-sqlite3` use; no ORM, DI framework, or generic repository layer.
- Migrations, schema-version tracking, startup integrity, and migration refusal.
- All 13 approved V1 tables, including tables needed by later phases.
- Approved reference seeds and immutable reference-data protection.
- Actor/actor-token tables, structural repositories, and a design-only Phase 4
  auth hand-off. Phase 3 does not bootstrap production actors/tokens or activate
  DB-backed authentication.
- Thin repositories and transaction primitives.
- T1–T8 and raw-SQL bypass tests, including SQLite REPLACE coverage.
- DB-level checks that do not change the approved state/authority model.
- Documentation of bootstrap, failure, and recovery behavior.

### 3.2 Explicitly out of scope

Phase 3 will not add active behavior for:

- `job_create`, `job_get`, `job_list`;
- `qa_dispatch`, `run_report`, `run_status`;
- `evidence_add`, `artifact_register`;
- `codex_decide`, `audit_query`;
- worker subprocesses, `ProcessRuntime`, NDJSON parsing, or fixture workers;
- Windows Job Objects, process trees, reapers, retries, circuit breakers, or queue schedulers;
- Gemini/`agy`, browser/CDP, dynamic MCP registry, remote egress, or cloud stores;
- Pino, OpenTelemetry, metrics backends, keytar, DPAPI, PM2, or Python/Rust runtimes;
- production `codex`/`system` bootstrap, first-token issuance/printing, token
  administration, persistent-auth activation, session attribution semantics, or
  the exactly-one-enabled-principal `serve` gate;
- any change to the already merged Phase 2 MCP transport behavior.

The Phase 3 schema may contain the rows and columns required by those future
features. The tools and behaviors that act on them remain later-phase work.

### 3.3 Transitional runtime state after Phase 3 and before Phase 4

The expected post-Phase-3/pre-Phase-4 repository state is explicit:

- the trusted schema-v4 DB exists at the approved path;
- all 13 tables exist;
- the exact reference rows are seeded and frozen;
- T1–T8, structural constraints, migration, store, repository, and integrity
  mechanics exist;
- Phase 3 raw-SQL DB-authority tests pass, including invariant 16 (at most one
  principal);
- production `ping` remains the only MCP tool;
- Phase 2 HTTP/stdio transport behavior remains unchanged;
- production authentication remains the already-approved Phase 2
  environment/in-memory mechanism;
- persistent `actor_tokens` authentication is not activated;
- no production `codex` principal, production `system` actor, or production
  bearer token is bootstrapped by Phase 3;
- no authority tool is exposed and no exactly-one-enabled-principal `serve`
  gate is active yet.

Throwaway DB fixtures may insert principal/system/token rows directly when
needed to exercise T1–T8. Fixture rows are test data, not production bootstrap
behavior.

## 4. Database path and secure opening policy

### 4.1 Exact path

The only database path is:

```text
<OS profile>\.agent-orchestrator-mcp\data\orchestrator.db
```

On this Windows host the resolved form is:

```text
C:\Users\kingm\.agent-orchestrator-mcp\data\orchestrator.db
```

POSIX follows the existing architecture path under
`$XDG_STATE_HOME/agent-orchestrator-mcp`, defaulting to
`~/.local/state/agent-orchestrator-mcp`.

There is no database-path flag, environment override, cloud-sync fallback,
workspace-local database, project-local database, or legacy-root migration.

### 4.2 Explicit database open modes

The implementation must expose explicit mode contracts rather than a boolean
whose meaning changes by caller:

| Contract | File existence | Writable? | May migrate? | May create WAL/SHM? | Production rows/behavior |
|---|---|---:|---:|---:|---|
| `openDatabaseForInit(...)` | Missing or valid existing exact file | Yes | Yes | Yes, after file security is proven | Phase 3 schema only; no principal/system/token bootstrap. |
| `openExistingDatabaseForServe(...)` | **Must already exist** as the exact trusted regular file | Yes | Yes, only approved pending migrations | Yes, after pre-open security checks | Keeps Phase 2 auth/`ping` behavior; does not require Phase 4 rows. |
| `inspectDatabaseFilesForDoctor(...)` | Existing file only; absent is reported, never created | No SQLite open | No | No | Reports filesystem/security state and explicit SQL-not-checked status; never bootstraps or repairs. |

`better-sqlite3` options/APIs for `readonly` and `fileMustExist`
were empirically checked in the disposable spike recorded in §4.5. The mode
distinction must be represented in the function contract and tests, not inferred
from a caller flag. The approved architecture forbids opening the authoritative
DB from doctor, so the spike is evidence for the prohibition rather than an
implementation option.

#### Init/migration mode

`openDatabaseForInit` may create
`<state root>\data\orchestrator.db`, but only after Phase 1 has verified the
state root and hardened/verified the parent `data` directory. It may apply the
numbered schema migrations. If the file already exists, it is treated as an
existing DB and must pass the existing-file checks below; only a path observed
absent before the explicit create is a fresh DB.

Phase 3 init initializes the **database schema only**. It does not create the
production `codex` principal, production `system` actor, first bearer token, or
DB-backed authentication. Those are the explicit Phase 4 hand-off in §10. A
  throwaway test fixture may insert such rows to exercise T1–T8.

#### Serve mode

`openExistingDatabaseForServe` is existing-only. If the exact database file is
absent, `serve` fails closed; the `better-sqlite3` default that creates a file
must not be used. An existing DB may receive approved pending migrations if
that is required by the architecture’s startup-migration rule, but an absent,
corrupt, or unknown DB is never an auto-repair opportunity.

During the Phase 3 transitional runtime, `serve` continues to use the already
approved Phase 2 environment/in-memory authentication and the `ping`-only
surface. It checks structural DB health, but does not require Phase 4’s
principal/token activation rows or exactly-one-enabled-principal service gate.

#### Doctor mode

`inspectDatabaseFilesForDoctor` is an existing-path filesystem/security
diagnostic only. It must not invoke `better-sqlite3` for the authoritative
DB, run any SQL/PRAGMA, run migrations, change `schema_migrations`, or
create/delete/modify `orchestrator.db`,
`orchestrator.db-wal`, or `orchestrator.db-shm`.

Doctor checks the exact trusted path, existence, `lstat`/realpath safety,
object type, DACL/POSIX mode, reparse/symlink/junction/hard-link safety, size,
and non-secret metadata for the DB and any existing sidecars. When its owned
checks pass, it reports `DB_FILE_SECURITY=PASS` and
`DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`. The latter is not a PASS and
must explicitly explain that deep SQLite integrity is owned by init and serve
startup.

`PRAGMA journal_mode` and all other SQL integrity checks belong to
init/serve after their security checks. Doctor reports absence or unsafe
filesystem state without repairing it.

#### Doctor exit semantics

The absence of SQL inspection is intentional and is not itself a doctor error.
When every doctor-owned filesystem/security check succeeds, doctor may succeed
with `DB_FILE_SECURITY=PASS` and
`DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`. An unsafe DB file, path, DACL,
reparse point, hard-link boundary, or sidecar remains a doctor failure. A
missing DB is reported accurately as absent/not initialized for the phase
context, without creating it.

### 4.3 Security order and durability

For an **existing** database, the order is mandatory:

1. derive the exact trusted path from the Phase 1 layout;
2. `lstat`/path-safety check the DB and any pre-existing sidecars before
   any init/serve writable open; doctor performs the check itself and then
   stops without opening SQLite;
3. reject symlink, junction, NTFS reparse, hard-link redirection, wrong object
   type, UNC, device, or escaped path;
4. verify the database file’s Windows DACL/POSIX mode;
5. only then open read-write through `openExistingDatabaseForServe` or
   `openDatabaseForInit`; doctor stops after its filesystem/security
   checks and never opens SQLite;
6. only after that writable open may the init/serve implementation set WAL/other
   write-affecting PRAGMAs or apply migrations.

For a **new** database created by init:

1. verify/harden the parent `data` directory;
2. create only the exact trusted file path;
3. immediately harden and verify the newly created DB file;
4. only then configure PRAGMAs and perform migration writes.

No migration or journal-mode change is allowed against a file whose security
has not been proven. The orchestrator remains one local writer; the fixed HTTP
port is the single-instance guard, and multiple Codex sessions are clients.
Every future authority/workflow mutation uses `BEGIN IMMEDIATE`; Phase 3
provides the primitive without exposing later tools. `close()` is idempotent,
and failed migration paths close the connection rather than leaving it usable
as if the migration had committed.

### 4.4 WAL and SHM sidecar policy

Because WAL is the approved default, the implementation must account for:

```text
orchestrator.db-wal
orchestrator.db-shm
```

- Sidecars must remain directly inside the protected `data` directory; they
  must not be relocated or represented by a custom file format.
- Existing sidecars are checked with `lstat`/platform path safety before any
  writable open. A symlink, junction, reparse point, hard-link escape, or wrong
  object type fails closed; doctor performs the same check without opening SQLite.
- Existing sidecars must not have a broader access boundary than the database
  directory. Windows relies on the verified owner-only `data` DACL and verifies
  sidecar security where the platform permits; POSIX checks owner-only access
  and does not accept readable sidecars outside the intended boundary.
- Newly created sidecars are allowed only after the protected parent and DB
  file checks. Their resulting security is verified where practical; an
  unexpectedly broad sidecar fails the operation rather than being ignored.
- Doctor never opens SQLite or assigns WAL. Its filesystem/security result is
  the complete doctor result for the authoritative DB; SQL integrity is
  deliberately reported as `NOT_CHECKED_BY_DESIGN`.
- Init/serve do not manually delete or rewrite sidecars; SQLite owns their
  lifecycle. A failed/unsafe sidecar is a startup failure requiring operator
  recovery, not silent relocation.

### 4.5 Empirical doctor feasibility spike (2026-08-30)

The disposable Windows spike is recorded outside the AOM repository at
`C:\AgentProjects\aom-benchmark\sqlite-doctor-spike\results.json` and
`C:\AgentProjects\aom-benchmark\sqlite-doctor-spike\uri-enabled-results.json`.
It changed no AOM source, dependency, branch, commit, or PR.

- The current candidate is `better-sqlite3@13.0.3` on Node
  `v22.22.0`/npm `11.6.4`. Its declared engine is
  `>=22` and its license is MIT.
- With `readonly: true`, a missing file failed with
  `unable to open database file` whether `fileMustExist` was
  omitted, `true`, or `false`. Both values opened an
  existing file. The installed native source selects
  `SQLITE_OPEN_READONLY` whenever readonly is true, so
  `fileMustExist` cannot be treated as the noncreation guarantee.
  Doctor therefore requires explicit pre-open existence/lstat/path-security
  checks.
- The native build reports `USE_URI` and
  `sqlite_compileoption_used('SQLITE_USE_URI') = 1`. A normal stock
  `new Database(fileUri, { readonly: true, fileMustExist: true })`
  invocation did not activate URI parsing: the default-process result is
  `IMMUTABLE_NOT_AVAILABLE`. Setting the stock
  `SQLITE_USE_URI=1` process environment before loading the addon made
  `file:///...?...immutable=1` usable without changing the package.
- Case 1, a healthy WAL database with pre-existing `-wal` and
  `-shm`, opened and passed `quick_check`/foreign-key checks,
  but the readonly doctor query changed the `-shm` hash at the same
  size. It was not zero-side-effect.
- Case 2, a cleanly closed healthy WAL database with no sidecars, opened and
  passed the same checks, but the full query set created both sidecars; the
  resulting WAL was zero bytes. An open/close-only control did not create
  sidecars, while the first `sqlite_schema` query did. The sidecar
  creation is therefore a real query-path effect, not merely a writable
  constructor effect.
- Case 3 was not manufactured: no legitimate healthy Windows transition
  produced a WAL file without its SHM companion, and no sidecar was deleted to
  fake that state. Case 4 independently confirmed the pre-existing safe
  WAL/SHM combination and the same readonly-sidecar mutation.
- URI `immutable=1` with the environment hook enabled opened clean
  rollback and clean-WAL files without changing them. It also opened a live
  uncheckpointed-WAL file without changing it, but saw zero schema rows because
  immutable mode ignored the WAL. It is therefore not a general doctor
  solution for an active WAL database.

**Approved architecture decision:** the stock candidate evidence is retained,
but Phase 3 selects **FAIL-CLOSED / NO-DIRECT-SQL DOCTOR**. The authoritative
DB is never opened through SQLite by doctor. Snapshot/quiescence, database
copying, `immutable=1`, URI environment tricks, VSS, alternate engines,
and external snapshot services are rejected for the Phase 3 doctor.

The final ownership contract is:

`DOCTOR_SQLITE_DIRECT_OPEN = FORBIDDEN`
`DOCTOR_AUTHORITATIVE_STATE_MUTATION = FORBIDDEN`
`DOCTOR_DB_FILESYSTEM_CHECKS = REQUIRED`
`INIT_SQL_INTEGRITY = REQUIRED`
`SERVE_SQL_INTEGRITY = REQUIRED`

Doctor reports filesystem/security diagnostics and
`DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`. Init and serve startup own
deep SQLite integrity and fail closed on migration/schema/PRAGMA/check failures.

## 5. Complete approved table inventory

The approved model contains **13 tables**. There is no separate `cycles` table:
cycle identity is the `cycle` column on `jobs` and the related rows. There is no
`capabilities` table: capabilities are validated against the static catalogue
and stored on `actors.capabilities_json`. There is no workspace/config table in
the approved DB model: config remains file-backed and `jobs.workspace` stores
the validated job workspace.

| # | Exact table | Purpose | Primary key | Foreign keys | Unique/CHECK constraints | Immutable/append-only behavior | Approved indexes | Seed/reference data | Actor/authority relevance | Active phase |
|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | `schema_migrations` | Applied migration ledger and schema-version gate. | `version INTEGER` | None. | PK on `version`; `applied_at` required. | Migration records are append-only in normal operation; no destructive down-migration. | PK index. | None. | Prevents a binary from serving an unknown schema. | Phase 3 |
| 2 | `actors` | One row per identity/authority actor. | `actor_id TEXT` | None in approved SQL. | `role` must be `principal`, `worker`, `observer`, or `system`; `disabled` is `0/1`; `ux_actors_single_principal` is unique on `role` where `role='principal'`. | Phase 3 creates the table and structural domains only. Production role/capability administration and principal/system row lifecycle are Phase 4. No T1–T6 append-only trigger is specified for the actor table. | `ux_actors_single_principal`. | No production actor rows are bootstrapped in Phase 3; throwaway fixtures may insert `codex`, `system`, and worker rows to exercise DB invariants. | Proves invariant 16 (at most one principal); active role/capability semantics are Phase 4. | Phase 3 schema / Phase 4 activation |
| 3 | `actor_tokens` | Many session credentials mapped to actors; digest-only schema for future persistent auth. | `token_id TEXT` | `actor_id → actors(actor_id)`. | `token_sha256` UNIQUE; `disabled` is `0/1`; digest is a 64-hex SHA-256 value; label required; expiry nullable. | Phase 3 creates and structurally validates rows only. Persistent token lifecycle, binding immutability, revocation, and `last_used_at` semantics are Phase 4/auth work. No plaintext token column. | `ix_actor_tokens_actor`. | No production token is issued in Phase 3; throwaway fixtures may insert digest-only rows. | Provides the future schema for verified sessions; persistent auth and capability derivation are Phase 4. | Phase 3 schema / Phase 4 activation |
| 4 | `decision_grants` | Immutable verb→authoritative-status allowlist read by T2. | `(decision, authoritative_status)` | None explicitly stated in §4 SQL. | Composite PK. | Frozen after seed by T5; no runtime insert/update/delete. | Composite PK. | `APPROVE→APPROVED`, `DELIVER→READY_FOR_DELIVERY`, `COMPLETE→JOB_COMPLETED`, `REJECT→REJECTED`, `CANCEL→JOB_CANCELLED`; FIX/RETEST/VERIFY_SELF/IGNORE_FALSE_POSITIVE/STOP/PACKAGE grant nothing. | The DB-level semantic authority map. | Phase 3/4 |
| 5 | `authoritative_statuses` | Immutable rank/terminal reference data read by T3. | `authoritative_status TEXT` | None explicitly stated in §4 SQL. | PK; `rank` required; `terminal` is a boolean domain. | Frozen after seed by T6; no runtime insert/update/delete. | PK. | `APPROVED(10,0)`, `READY_FOR_DELIVERY(20,0)`, `JOB_COMPLETED(30,1)`, `REJECTED(90,1)`, `JOB_CANCELLED(91,1)`. | Makes terminality absolute and status rank monotonic. | Phase 3/4 |
| 6 | `jobs` | One durable job record and workflow/authority projection. | `job_id TEXT` | `authoritative_status → authoritative_statuses`; `deciding_decision_id → decisions`; `owner_actor_id → actors`. | `workspace`, title, spec, state, timestamps required; `cycle >= 0`; `max_cycles` bounded by application/hard maximum; `version >= 1`; `stale_after_s` required. | `job_id`, owner, workspace, creation metadata are stable; state/status/cycle/version/deadline are changed only by later domain transactions. T2–T4 protect authority fields. | `ix_jobs_state_updated`, `ix_jobs_workspace`, `ix_jobs_auth_status`. | None. | Only later principal/system domain operations may change authority projection. Worker verdicts have no FK/path to authoritative status. | Phase 3/4/5 |
| 7 | `decisions` | Append-only record of a proposed/actual decision and its target. | `decision_id TEXT` | `job_id → jobs`; `actor_id → actors`; `session_token_id → actor_tokens` nullable. | Required job/cycle/actor/request/decision/rationale/from/to fields; decision is from the approved enum. | T5 rejects UPDATE and DELETE. Inserts by disabled/non-principal actors are rejected by T1. | `ix_decisions_job`, `ix_decisions_session`. | None. | Carries verified token/session attribution; T2 joins it to grants and exact job/cycle/state. | Phase 3/4 |
| 8 | `worker_runs` | Advisory worker execution/attempt ledger. | `run_id TEXT` | `job_id → jobs`. `worker_id` is a config registry ID, not a DB table. | Status enum: PENDING/RUNNING/SUCCEEDED/FAILED/TIMEOUT/CANCELLED/MALFORMED/ORPHANED; verdict enum PASS/FAIL/INCONCLUSIVE/NONE; failure-class enum from §9; `attempt >= 1`; supporting UNIQUE `(run_id, job_id, cycle)` for the lease composite FK. | Attempt rows remain visible; later runtime updates operational fields, but `worker_verdict` never writes authority. | `ix_runs_job_cycle`; supporting composite UNIQUE index. | None. | Explicitly advisory. A worker run cannot author a decision or status. | Phase 3 schema / Phase 6/8 use |
| 9 | `evidence` | Bounded, trust-labelled observations from Codex/system/workers. | `evidence_id TEXT` | `job_id → jobs`; `run_id → worker_runs` nullable; `source_actor → actors`; `artifact_id → artifacts` nullable. | `trust` is deterministic/untrusted/principal; summary ≤2 KiB; detail bounded and overflow goes to an artifact. | Evidence is append-only by repository policy; V1 does not delete it. | `ix_evidence_job_cycle`. | None. | Trust is derived from caller role; never accepted as an authoritative input field. | Phase 3/7 |
| 10 | `artifacts` | Metadata for files outside SQLite. | `artifact_id TEXT` | `job_id → jobs`; `run_id → worker_runs` nullable; `created_by → actors`. | UNIQUE `(job_id, rel_path)`; bytes/hash/path metadata required; SHA-256 computed by orchestrator. | Metadata is retained on completion/cancellation; file deletion/prune is later and must not erase the ledger row. | Unique `(job_id, rel_path)` index. | None. | Worker/Codex artifact attribution; no blob or worker-supplied hash is authoritative. | Phase 3/7 |
| 11 | `leases` | Single-use, expiring worker-report/dispatch schema for later runtime use. | `lease_id TEXT` | `run_id → worker_runs`; `actor_id → actors`; supporting composite `(run_id, job_id, cycle) → worker_runs(run_id, job_id, cycle)`. | `run_id` UNIQUE; job/cycle/actor/nonce/expiry required; consumed timestamp nullable. | Phase 3 creates structural columns/FKs only; active issue/consume, expiry, and single-use behavior are Phase 6. | Unique `run_id` index and supporting composite-FK parent index. | No production lease is issued in Phase 3; fixtures may insert rows for structural tests. | Provides the future actor/job/cycle/run binding; no raw session hint is authority. | Phase 3 schema / Phase 6 use |
| 12 | `idempotency` | Actor-scoped replay record for later mutating requests. | `(actor_id, key)` | `actor_id → actors`. | Composite PK; key/request hash/response/created timestamp required; key format is UUID per §17. | Phase 3 creates structural storage only; replay/conflict semantics are later domain behavior. | Composite PK. | None. | Future duplicate authority/workflow protection; no active tool uses it in Phase 3. | Phase 3 schema / Phase 4–6 use |
| 13 | `audit_log` | Append-only ledger schema for later attribution and hash-chain semantics. | `seq INTEGER PRIMARY KEY AUTOINCREMENT` | None explicitly stated; `actor_id` remains text so rejected/early auth events can be represented. | Required timestamps/actor/action/result/hash fields; result is `ok`, `denied`, or `error`; detail is bounded/redacted. | T5 rejects UPDATE and DELETE. Hash-chain construction, verified session attribution, and active audit semantics are Phase 4/8; Phase 3 proves append-only structure. | `ix_audit_job`, `ix_audit_session`. | No ordinary production rows in Phase 3; genesis/first hash is defined when Phase 4 activates the chain. | Durable future audit surface; not an alternative authority writer. | Phase 3 schema / Phase 4/8 activation |

### 5.1 Table-model rules

- The names above are exact. A later implementation must not rename `jobs`,
  `worker_runs`, `leases`, `decisions`, `decision_grants`, or
  `authoritative_statuses` to fit a generic ORM model.
- `actor_tokens` is not a second actor table. It is many-to-one session
  material for rows in `actors`.
- `worker_runs.worker_verdict` is advisory metadata. There must be no repository
  method that treats it as a grant or writes `jobs.authoritative_status` from it.
- Workspace/config validation remains outside SQLite’s ability to resolve
  realpaths. The application must validate the workspace before insert; the DB
  stores the validated string and required structural checks only.
- Time-dependent expiry (`expires_at <= now`) is a verifier/transaction check,
  not a static SQLite CHECK. An expired token row is inert and must never
  authenticate; it is not silently deleted or rewritten by a migration.

## 6. Constraints, indexes, and transaction primitives

### 6.1 Approved constraints

The implementation must include the constraints shown in §9 and §4 of the
architecture. It may add non-conflicting structural checks for the domains the
architecture already names:

- all foreign keys from the inventory, with `PRAGMA foreign_keys=ON` verified;
- exact actor role and boolean domains;
- 64-hex token digests and unique digest enforcement;
- non-negative cycle/byte/attempt/version domains;
- the approved state/status/decision/status/verdict/failure/result enums;
- required non-empty identifiers/rationale/labels where the schema says
  `NOT NULL` and the tool contracts require a value;
- bounded evidence/detail, stderr, and response fields at the appropriate
  application boundary;
- artifact hash shape and `(job_id, rel_path)` uniqueness;
- UUID-form idempotency keys, as required by §17.

These checks are validation aids. They do not replace the authority triggers,
transactional state guards, or Phase 1 filesystem security.

### 6.2 Supporting-guard classification

The exact T1–T6 semantics below remain mandatory and unchanged. Revision 6 adds
T7 as a required job-row lifecycle guard, and Revision 7 adds T8 for SQLite
row-replacement integrity. The five additional guards requested by principal
review are resolved as follows; the lease dimension guard is unconditional, and
none is a replacement for T1–T8.

| Guard | Classification | Phase 3 action | Later owner/reason |
|---|---|---|---|
| Actor identity/role/capabilities immutability | **DEFERRED TO PHASE 4** | Create the exact `actors` columns, role/boolean structural CHECKs, primary key, and invariant-16 partial unique index. Do not add an actor-admin or active capability-mutation trigger. | Phase 4 owns active roles/capabilities, actor administration, and the decision-capability rule. This preserves future actor/token administration instead of freezing behavior prematurely. |
| `actor_tokens` actor/digest binding immutability | **DEFERRED TO PHASE 4** | Create the exact `actor_tokens` columns, actor FK, unique digest, and digest/boolean structural checks. Do not activate persistent auth or token lifecycle administration. | Phase 4 owns production token issuance/revocation and decides any binding-immutability trigger without adding a token-scopes column. |
| Lease `(run_id, job_id, cycle)` consistency | **PHASE 3 REQUIRED** as a pure structural constraint | Add a composite parent uniqueness key on `worker_runs(run_id, job_id, cycle)` and a matching composite FK from `leases(run_id, job_id, cycle)`, while retaining the approved `run_id` UNIQUE/FK. This uses the existing tables and preserves every valid future lease. | Phase 6 owns active lease issue/consume/report behavior. The structural relation can be proven now without consuming a lease or dispatching a worker. |
| Job-row lifecycle integrity | **PHASE 3 REQUIRED** as T7 | Add `trg_jobs_unstamped_on_insert` and `trg_jobs_no_delete` in migration 003. New jobs must have NULL `authoritative_status`/`deciding_decision_id` and a non-authoritative state; every runtime DELETE is rejected, including with foreign keys disabled. | Phase 5/4 may advance an existing job through the reviewed authority transaction; no later phase may delete the durable job ledger root. |
| Durable-row replacement integrity | **PHASE 3 REQUIRED** as T8 | Add INSERT-side identity-existence guards for `jobs.job_id`, `decisions.decision_id`, and `audit_log.seq` in migration 004. Genuine new rows remain insertable; `INSERT OR REPLACE` and bare `REPLACE` cannot replace existing durable identities. | This is a schema boundary, not an application-repository rule. AOM-owned `recursive_triggers=ON` is defense in depth; external connections with it OFF must still be rejected. |
| Lease single-consumption immutability | **DEFERRED TO PHASE 6** | Create `consumed_at` with its approved nullable shape; do not add active consumption/replay behavior or a lifecycle trigger in Phase 3. | Phase 6 owns `UPDATE … WHERE consumed_at IS NULL`, duplicate reports, expiry, and cleanup. |
| Non-principal `job:decide` capability guard | **DEFERRED TO PHASE 4** | Validate only the approved actor role/boolean/schema domains and prove T1/T2 with fixture actors. Do not activate capability semantics or a production capability administrator. | Phase 4 owns the static catalogue, active role/capability checks, and `codex_decide` visibility/authorization. T1/T2 remain independent DB barriers. |

No guard is rejected and no architecture change is required. The Phase 3
supporting guards implemented in the schema are the safe composite FK/UNIQUE
relationship for lease dimensions, T7 job-row lifecycle integrity, and T8
row-replacement integrity; all active actor identity, capability,
token-lifecycle, and lease-consumption behavior remains with its assigned later
phase.

### 6.3 Atomic transaction API

The store layer will expose a very small transaction surface:

```text
openDatabase(path, options) -> DatabaseHandle
runMigrations(db) -> SchemaState
withImmediateTransaction(db, callback) -> result
quickCheck(db) -> IntegrityReport
closeDatabase(db) -> void
```

Repositories receive a transaction-bound handle rather than a global singleton
or a DI container. A later workflow can therefore perform, in one
`BEGIN IMMEDIATE` transaction:

- job/version/expected-state checks;
- run inserts;
- lease inserts or atomic lease consumption;
- decision/audit writes;
- state changes;
- idempotency read/write.

The callback is synchronous-only: a thenable result is rejected and rolled back
before `COMMIT`, so async work cannot escape the transaction boundary. Phase 3
defines and tests these mechanics without registering the later tools or
implementing their state-machine behavior.

## 7. T1–T8 trigger matrix

T1–T6 below preserve the exact trigger definitions and error strings from
`docs/ARCHITECTURE.md` §4. T5 and T6 are logical groups containing several
physical triggers. T7 is two physical job-row triggers added by migration 003;
T8 is three physical row-replacement triggers added by migration 004. The
reference freeze triggers must be created **after** all required reference seed
rows are inserted, in the same migration transaction.

| Group | Exact trigger/event | Invariant protected | Expected SQLite behavior | Legitimate operation | Raw-SQL bypass that must fail | Test IDs |
|---|---|---|---|---|---|---|
| T1 | `trg_decisions_principal_only BEFORE INSERT ON decisions`; abort when no matching enabled `role='principal'` actor exists. | Only an enabled principal may author a decision. | `RAISE(ABORT, 'decisions require an enabled principal actor')`. The insert is rolled back. | Insert a decision whose actor is the enabled sole principal. | Insert with a worker actor; insert with a disabled principal actor. | SQL-14, SQL-15 |
| T2 | `trg_auth_status_requires_granting_decision BEFORE UPDATE OF authoritative_status ON jobs`, only when the value changes. | A status write must be semantically granted by the referenced enabled-principal decision for the same job, cycle, and `to_state`. NULL status or missing decision is forbidden. | `RAISE(ABORT, 'authoritative_status requires a granting principal decision')`. | In one later domain transaction, insert a valid granting decision first, then update the job with matching status/decision/job/cycle/state. | RETEST→APPROVED; APPROVE→JOB_COMPLETED; other job; other cycle; wrong `to_state`; disabled principal; NULL status; missing decision; worker verdict with no granting decision. | SQL-16 through SQL-24 |
| T3 | `trg_auth_status_monotonic BEFORE UPDATE OF authoritative_status ON jobs`; if old status exists and new status changes, reject old terminal or new rank ≤ old rank. | Milestones cannot regress and terminal outcomes cannot reopen. | `RAISE(ABORT, 'authoritative_status is terminal or would regress')`. | Advance a non-terminal status to a strictly higher-rank non-terminal/terminal status through a matching T2 decision. | `JOB_COMPLETED→APPROVED`; any move off `REJECTED`/`JOB_CANCELLED`/`JOB_COMPLETED`; rank regression. | SQL-28, SQL-29 |
| T4 | `trg_state_matches_auth_status BEFORE UPDATE OF state ON jobs`; when new state is an authoritative state, it must equal `authoritative_status`. | Workflow state and authoritative projection cannot disagree on authoritative states. | `RAISE(ABORT, 'authoritative state requires the matching authoritative_status')`. | A later valid transition changes both fields consistently in one transaction. | Set `state='APPROVED'` while status is NULL or another value; set any authoritative state with mismatch. | SQL-27 |
| T5 | `trg_decisions_no_update`, `trg_decisions_no_delete`, `trg_audit_no_update`, `trg_audit_no_delete`, `trg_grants_frozen_i`, `trg_grants_frozen_u`, and `trg_grants_frozen_d`. | Decisions and audit rows are append-only; the semantic grant map cannot be widened or rewritten. | `RAISE(ABORT, 'decisions are append-only')`, `RAISE(ABORT, 'audit_log is append-only')`, or `RAISE(ABORT, 'decision_grants is immutable')` as specified. | Insert a decision/audit row through the later repository; seed grant rows only before freeze triggers exist in the migration. | Update/delete a decision; update/delete an audit row; insert/update/delete a grant row; insert a new grant after seed. | SQL-12, SQL-13, SQL-25, SQL-26, SQL-30 |
| T6 | `trg_auth_statuses_frozen_i`, `trg_auth_statuses_frozen_u`, and `trg_auth_statuses_frozen_d`. | Rank and terminality reference data cannot be edited to disarm T3. | `RAISE(ABORT, 'authoritative_statuses is immutable')`. | Seed the exact five rows before T6 is installed; changes require a reviewed, numbered migration. | Set `JOB_COMPLETED.terminal=0`; reorder/lower ranks; insert `UNAPPROVED`; delete `REJECTED`. | SQL-09, SQL-10, SQL-11 |
| T7 | `trg_jobs_unstamped_on_insert BEFORE INSERT ON jobs` and `trg_jobs_no_delete BEFORE DELETE ON jobs`. | Jobs are durable ledger roots and cannot enter the ledger already authoritative. | `RAISE(ABORT, 'jobs must begin without authoritative state')` or `RAISE(ABORT, 'jobs are durable and cannot be deleted')`. | Insert a non-authoritative job with both authority columns NULL; later reviewed authority code may stamp it. | Insert with non-NULL status, non-NULL deciding decision, or an authoritative initial state; delete an unstamped or stamped job, including from a foreign-key-off second connection. | SQL-39 through SQL-45 |
| T8 | `trg_jobs_no_replace`, `trg_decisions_no_replace`, and `trg_audit_no_replace`, all `BEFORE INSERT` identity-existence guards. | SQLite `REPLACE` cannot erase and recreate a durable `jobs`, `decisions`, or `audit_log` primary-key row. | `RAISE(ABORT, 'jobs are durable and cannot be replaced')`, `RAISE(ABORT, 'decisions are append-only and cannot be replaced')`, or `RAISE(ABORT, 'audit_log is append-only and cannot be replaced')`. | Insert a genuinely new job/decision/audit row; omit `audit_log.seq` for normal AUTOINCREMENT. | Duplicate ordinary INSERT, `INSERT OR REPLACE`, or bare `REPLACE` for an existing identity, with `recursive_triggers=OFF`. | SQL-46 through SQL-53 |

### 7.1 T2/T3/T4 ordering and transaction rule

Later domain code must write a granting decision before the job status update in
the same `BEGIN IMMEDIATE` transaction. The DB trigger sees the decision row
and independently verifies its actor, grant, job, cycle, and state. A failed
statement aborts the transaction; no partial decision/status pair is accepted.

The application transition table remains the owner of allowed workflow
transitions. T1–T4 are not a replacement for `applyTransition`; they are the
independent DB barrier against direct SQL and repository mistakes.

## 8. Numbered migration sequence

**Four migrations are approved and implemented.** The original `001`, `002`,
and `003` semantics are unchanged; `004` is the narrow Revision 7 F-1
addition. Each file is executed by the runner in its own transaction.

### Migration 001 — `001_base_schema.sql`

Creates, in one transaction:

- `schema_migrations`;
- `actors`, `actor_tokens`;
- `decision_grants`, `authoritative_statuses` as empty reference tables;
- `jobs`, `decisions`, `worker_runs`, `evidence`, `artifacts`, `leases`;
- `idempotency`, `audit_log`;
- all approved indexes and structural CHECK/FK constraints;
- the approved structural lease/run binding: UNIQUE
  `worker_runs(run_id, job_id, cycle)` plus the matching composite FK
  from `leases`, while retaining the approved `run_id`
  UNIQUE/FK; no active lease-consumption trigger.

It inserts no decision-grant/status seed rows until the tables and all dependent
tables exist. It creates no actor, principal, system row, or token
automatically; production bootstrap is a Phase 4 operation, not a migration
side effect.

### Migration 002 — `002_authority_reference_seed_and_triggers.sql`

Runs in one transaction:

1. insert the five exact `decision_grants` rows;
2. insert the five exact `authoritative_statuses` rows;
3. verify the expected seed counts/values inside the migration;
4. create T1–T6, including T5/T6 freeze triggers, **after** those inserts;
5. verify the trigger names exist before recording the migration.

The seed inserts succeed because the freeze triggers do not exist yet. Once the
transaction commits, runtime grant/status reference data is immutable: no
runtime insert/update/delete is allowed. Any later change requires a separately
reviewed, numbered migration. Such a migration may, inside one runner-owned
transaction, temporarily drop/recreate the relevant freeze triggers, change only
the reviewed exact reference rows, verify the exact set and invariants, reinstall
the freeze triggers, verify them, and commit atomically. It must never leave
reference data mutable after commit or continue after a partial failure.

### Migration 003 — `003_job_row_integrity_and_schema_verification.sql`

Adds exactly two physical T7 triggers:

1. `trg_jobs_unstamped_on_insert` rejects a new job with a non-NULL
   `authoritative_status`, a non-NULL `deciding_decision_id`, or an
   authoritative initial state (`APPROVED`, `READY_FOR_DELIVERY`,
   `JOB_COMPLETED`, `REJECTED`, or `JOB_CANCELLED`), using the fixed message
   `jobs must begin without authoritative state`;
2. `trg_jobs_no_delete` rejects every DELETE from `jobs`, using the fixed
   message `jobs are durable and cannot be deleted`.

The migration records version 3 only after both triggers exist. It changes no
table or reference-seed semantics. Startup then verifies the canonical SQL
definitions for every approved table, security-sensitive index, and physical
T1–T7 trigger.

### Migration 004 — `004_row_replacement_integrity.sql`

Adds the three physical T8 INSERT-side identity guards:

1. `trg_jobs_no_replace` rejects an existing `job_id` with
   `jobs are durable and cannot be replaced`;
2. `trg_decisions_no_replace` rejects an existing `decision_id` with
   `decisions are append-only and cannot be replaced`;
3. `trg_audit_no_replace` rejects an existing explicit `seq` with
   `audit_log is append-only and cannot be replaced`.

The guard permits genuinely new rows. An omitted `audit_log.seq` remains a
normal AUTOINCREMENT insert; the implementation tests the current SQLite
`NEW.seq` behavior directly. T8 is independent of both `foreign_keys` and
`recursive_triggers`, so `INSERT OR REPLACE` and bare `REPLACE` cannot reset a
durable identity from an external connection.

### 8.1 Migration runner contract and edge cases

- Discover migration files by numeric prefix and sort numerically, not by
  filesystem enumeration order.
- The runner owns the transaction. Migration SQL files contain no independent
  `BEGIN`/`COMMIT`, so a `better-sqlite3` transaction wrapper cannot conflict
  with nested transaction statements.
- A **fresh DB** is version 0 only when the explicit init path observed the
  exact file absent, created it after parent security checks, and is now
  initializing that file. `schema_migrations` may not yet exist in this one
  path.
- An **existing DB** with a missing, malformed, or corrupt `schema_migrations`
  table fails closed. An arbitrary existing SQLite file is never reclassified
  as a fresh AOM DB merely because a ledger query returns no rows.
- The known ordered migration set is `[1, 2, 3, 4]`. Read the complete applied
  set, not a maximum-version shortcut, and require it to be an exact contiguous
  prefix of that known set. `{}` is valid only for the explicitly-created
  fresh init file before its first migration; `{1}`, `{1, 2}`, and `{1, 2, 3}`
  are valid existing prefixes with pending migrations; and `{1, 2, 3, 4}` is
  current. An existing ledger containing `{}`, `{2}`, `{1, 3}`, `{1, 2, 4}`,
  `{1, 2, 3, 5}`,
  duplicate rows, malformed rows, gaps, unknown versions,
  or a version newer than the binary knows fails closed.
- Inside the runner-owned `BEGIN IMMEDIATE` transaction, reread and
  revalidate the complete ledger after acquiring the write lock and before
  deciding which migrations are pending. Never decide from a pre-lock read or
  from a single-version summary alone.
- Apply each missing migration once and insert its version only after every
  statement and in-transaction verification succeeds.
- Migration 002 verifies both exact seed sets inside its transaction and then
  installs T5/T6 freeze triggers after the seed inserts and before commit.
- Migration 003 installs the two T7 job-row lifecycle triggers before recording
  version 3; it never changes the approved `001`/`002` semantics.
- Migration 004 installs the three T8 identity-existence triggers before
  recording version 4; it never changes the approved `001`/`002`/`003`
  semantics.
- AOM-owned writable SQLite connections set and verify
  `recursive_triggers=ON` as defense in depth. External connections with
  `recursive_triggers=OFF` must still be rejected by T8.
- A fresh-init migration failure closes the SQLite handle before removing only
  the DB/WAL/SHM files created by that fresh attempt. The original initialization
  error remains the primary failure, and the known failed-init artifact can be
  retried normally; an arbitrary existing DB with no ledger is still rejected.
- The build step clears the exact `dist/store/migrations` destination before
  copying the source set, so stale numbered or unnumbered files cannot survive.
- Roll back the entire migration transaction on any error. Do not mark a
  partially executed migration as applied or continue after a failed one.
- Run `PRAGMA quick_check`, `foreign_key_check`, and required
  table/index/trigger/reference-set verification after the sequence. A failed
  check refuses service.
- There is no destructive auto-repair, implicit table drop, or automatic
  downgrade. Recovery is restore/backup/operator work outside this plan.
- A future `migrate`/init command may invoke the runner; Phase 3 does not add
  job or worker commands and does not bootstrap production authority rows.

## 9. Seed and bootstrap design

### 9.1 Reference seeds

The exact immutable reference rows are:

```text
decision_grants:
  APPROVE  -> APPROVED
  DELIVER  -> READY_FOR_DELIVERY
  COMPLETE -> JOB_COMPLETED
  REJECT   -> REJECTED
  CANCEL   -> JOB_CANCELLED

authoritative_statuses:
  APPROVED            rank 10, terminal 0
  READY_FOR_DELIVERY  rank 20, terminal 0
  JOB_COMPLETED       rank 30, terminal 1
  REJECTED            rank 90, terminal 1
  JOB_CANCELLED       rank 91, terminal 1
```

FIX, RETEST, VERIFY_SELF, IGNORE_FALSE_POSITIVE, STOP, and PACKAGE receive no
grant row.

### 9.2 Phase 3 schema initialization only

Phase 3 may initialize the **database schema** through the explicit init mode in
§4. It does not bootstrap the production `codex` principal, the production
`system` actor, a first bearer token, or persistent authentication. It does not
print a production token and it does not replace the Phase 2 resolver.

The Phase 3 implementation extends the existing Phase 2 state-root/lease-key
bootstrap with trusted schema initialization. It creates the empty trusted DB
only on explicit init, applies migrations, runs structural/integrity checks, and
does not silently create authority rows merely because the schema is empty.

### 9.3 Fixture-only rows

The raw-SQL and trigger tests may insert fixture rows for `codex`, `system`,
workers, and `actor_tokens` inside a throwaway DB. Those rows exist only to
exercise T1–T8 and invariant 16. Fixture setup is not production bootstrap,
does not alter the Phase 3 transitional runtime, and must not be reused by the
CLI.

## 10. PHASE 4 HAND-OFF — production authority/auth activation

This section designs the next-phase hand-off; it is **not a Phase 3 work
package** and is not authorized for implementation in this document.

Phase 4 owns:

1. creating/bootstrapping the sole production `codex` principal and internal
   `system` actor according to the approved §16 bootstrap rule;
2. issuing the first production bearer token print-once and adding later token
   administration;
3. activating persistent `actor_tokens` lookup while preserving the exact
   Phase 2 HTTP/stdio wire contracts;
4. deriving `AuthInfo.scopes`/capabilities from the verified actor’s approved
   `actors.capabilities_json`, not from a token-scopes column;
5. enforcing exactly one enabled principal in the production `serve` startup
   invariant;
6. activating verified `session_token_id` attribution and keeping
   `session_hint` as untrusted metadata only;
7. activating capability/role semantics, the static transition table,
   `applyTransition`, `codex_decide`, and active audit-chain semantics;
8. ensuring no worker token/session can acquire principal authority.

The planned hand-off is:

```text
Phase 3: trusted schema v4 + T1–T8 + structural stores + Phase 2 runtime
    -> principal review / Phase 4 authorization
Phase 4: production codex/system bootstrap + token issue + persistent auth
    -> later Phase 5/6 workflow and lease use
```

Until Phase 4 explicitly activates this hand-off, `ORCHESTRATOR_ACTOR_TOKEN`
continues to be handled by the approved Phase 2 mechanism. It is not migrated
into a production token row by Phase 3, and no DB-backed fallback is added.

## 11. Store/repository boundary

### 11.1 Concrete modules required by Phase 3

The store layer should be table-oriented and explicit:

- `db.ts`: secure open, PRAGMAs, transaction wrapper, close, and safe SQL
  error mapping;
- `migrations.ts`: discovery, version checks, per-migration transactions,
  integrity verification;
- `integrity.ts`: required schema/trigger/reference checks, invariant-16
  at-most-one-principal check, and quick-check/foreign-key results. It must not
  enforce Phase 4’s exactly-one-enabled-principal serve gate;
- `schemaDefinitions.ts`: canonical normalized-SQL fingerprints for every
  approved table, security-sensitive index, and physical T1–T8 trigger. It
  intentionally collapses whitespace only: SQL case and comments remain part
  of the reviewed fingerprint, so approved DDL changes require regeneration;
- `repositories.ts`: the single implemented structural repository module. It
  exposes actor/token/reference reads and inserts for fixtures and the later
  hand-off, plus a synchronous `BEGIN IMMEDIATE` transaction primitive. It
  contains no production bootstrap, persistent-auth activation, active token
  lifecycle, job authority setter, or later MCP tool;
- `migrations/*.sql`: the exact numbered source set `001`, `002`, `003`, and `004`.

The implementation must keep these responsibilities explicit in the actual
single-file repository inventory. No ORM, dependency-injection container,
active-record layer, generic repository framework, or per-interface file tree
is authorized by this plan.

### 11.2 Separation from future domain authority

The store layer persists and constrains data. It does not decide whether a job
may transition. That belongs to the later domain layer:

```text
Phase 3 store:      SQL rows, FK/CHECK, transactions, T1–T8, canonical integrity, invariant 16
Phase 4 domain:     actors/capabilities, TRANSITIONS, applyTransition, codex_decide, audit semantics
Phase 5 lifecycle:   job tools, cycles, CAS/idempotency orchestration
Phase 6 runtime:    workers, leases in use, reports, NDJSON
```

The DB still independently refuses unjustified authoritative writes even when
called outside the future domain code. Phase 3 does not activate the
production actor/token/auth domain that later supplies the normal caller
context.

## 12. Startup integrity checks by phase

### 12.1 Phase 3 structural DB checks

Phase 3 structural ownership is split. Doctor performs only the required
filesystem/security diagnosis and never opens the authoritative DB with SQLite.
Init and serve startup own the deep SQLite checks below and may refuse to
continue before the first MCP request when one fails. These checks must not
require Phase 4 data that Phase 3 is not allowed to bootstrap:

1. Phase 1 state-root/data-directory security and cloud-sync checks pass.
2. The exact database path and any existing WAL/SHM sidecars pass path safety
   and file-security checks before any writable open; doctor stops after this
   filesystem/security diagnosis and does not open SQLite.
3. `serve` finds an existing DB; an absent DB is a fail-closed startup error.
   Only explicit init mode may create the DB.
4. Init/serve SQLite opens use the approved WAL, foreign-key, busy-timeout, and
  synchronous and `recursive_triggers=ON` policy after file security is proven.
5. Init/serve verify that the DB is not newer than the binary and that the
   exact expected migration set `[1, 2, 3, 4]` has no gaps, unknown versions, or
   duplicates.
6. Init/serve run `PRAGMA quick_check` and `foreign_key_check`; both are clean.
7. Init/serve verify all 13 tables, approved indexes, structural constraints,
   canonical normalized SQL definitions, all physical T1–T8 triggers, and
   exact frozen reference rows.
8. Init/serve verify invariant 16: the unique partial index and raw-SQL test prove **at most
   one** principal actor. Phase 3 does not require an enabled principal.
9. Init/serve verify any actor/token rows present are structurally valid, FK-valid, and digest
   unique; the schema has no token-scopes column. Production actor/token
   activation is not a Phase 3 check.
10. Init/serve verify the approved structural lease/run binding is present and tested:
    `worker_runs(run_id, job_id, cycle)` is UNIQUE and the matching
    composite FK is present in `leases`; active lease issue/consume is
    not checked here.
11. Init/serve verify the lease key remains present/protected/readable under the existing Phase 1
     gate.

12. Failed fresh initialization closes SQLite before removing only the DB,
    WAL, and SHM files created by that attempt; the original failure remains
    visible and a normal retry succeeds. The build copy step clears stale files
    from `dist/store/migrations`. The transaction callback rejects a Promise or
    thenable before commit and rolls back.

Init/serve structural failures are actionable and fail closed without printing DB
rows, token material, lease key material, or unbounded SQL details. Doctor may
report existence, path/object/security metadata, and pass/fail metadata, but
must report `DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN` rather than a migration
version, schema contents, principal count from SQL, or deep-integrity PASS.

### 12.2 Phase 4 activation checks — hand-off only

The following are intentionally **not** Phase 3 acceptance gates and move to
the §10 Phase 4 hand-off:

- exactly one enabled principal;
- required production `system` actor;
- production `actor_tokens` availability and persistent-auth lookup;
- expiry/disabled/revoked token behavior in the active verifier;
- capability catalogue and role activation, including non-principal
  `job:decide` denial;
- verified `session_token_id` attribution and session semantics;
- active authority/audit startup invariants.

Workspace/config lifecycle enforcement remains with the architecture phase that
owns the corresponding job/worker behavior. Phase 3 must not make a server
fail because Phase 4 data has not yet been authorized or bootstrapped.

## 13. Raw-SQL adversarial test matrix

The SQL test suite will create a throwaway DB, apply the real migrations, seed
fixture actors/rows where needed, and issue direct SQL without application
repositories. Fixture rows are not production bootstrap. Every case records its
owner phase, enforcement layer, and whether it is executable as part of Phase
3. The suite will assert the exact error class/message where specified and that
protected rows remain unchanged.

There are **53 total traceable attack cases**:

- `PHASE_3_CASE_COUNT = 48`: executable before Phase 4 and required for Phase 3
  completion;
- `FUTURE_HANDOFF_CASE_COUNT = 5`: documented now, but not Phase 3 gates.

“SQLite ABORT/constraint” means the DB itself must reject the statement.
“Application/startup owner” means the architecture intentionally assigns the
rule to a later verifier, config boundary, or CAS transaction; Phase 3 must
not falsely claim a direct SQLite rejection.

### 13.1 PHASE 3 EXECUTABLE ADVERSARIAL MATRIX

| ID | Direct SQL attempt | OWNER_PHASE | ENFORCEMENT_LAYER | PHASE_3_EXECUTABLE | Expected result / responsible guard |
|---|---|---|---|---|---|
| SQL-01 | Insert a second `actors` row with `role='principal'`. | Phase 3 | SQLite unique index | YES | Reject via `ux_actors_single_principal`; proves invariant 16 at-most-one principal. |
| SQL-02 | Change an existing worker’s `role` to `principal` while the Codex principal exists. | Phase 3 | SQLite unique index | YES | Reject via `ux_actors_single_principal`; any active role semantics remain Phase 4. |
| SQL-04 | Insert an actor with an unknown role or invalid disabled value. | Phase 3 | SQLite CHECK | YES | Reject via actor role/boolean structural CHECKs. |
| SQL-05 | Insert `actor_tokens` for a nonexistent actor. | Phase 3 | SQLite FK | YES | Reject via `actor_tokens.actor_id` FK with foreign keys ON. |
| SQL-07 | Insert two tokens with the same `token_sha256`. | Phase 3 | SQLite UNIQUE | YES | Reject via UNIQUE `actor_tokens.token_sha256`. |
| SQL-08 | Insert a malformed/non-64-hex digest or invalid disabled value. | Phase 3 | SQLite CHECK | YES | Reject via token digest/boolean structural CHECKs. |
| SQL-09 | `UPDATE authoritative_statuses SET terminal=0 WHERE authoritative_status='JOB_COMPLETED'`. | Phase 3 | T6 | YES | ABORT; rows unchanged via `trg_auth_statuses_frozen_u`. |
| SQL-10 | Change `APPROVED.rank` to 99 or lower a terminal rank. | Phase 3 | T6 | YES | ABORT; rows unchanged via `trg_auth_statuses_frozen_u`. |
| SQL-11 | Insert `UNAPPROVED` status or delete `REJECTED`. | Phase 3 | T6 | YES | ABORT; rows unchanged via `trg_auth_statuses_frozen_i/d`. |
| SQL-12 | Insert a new `decision_grants` row widening authority. | Phase 3 | T5 | YES | ABORT via `trg_grants_frozen_i`. |
| SQL-13 | Update/delete any `decision_grants` row. | Phase 3 | T5 | YES | ABORT via `trg_grants_frozen_u/d`. |
| SQL-14 | Insert a decision authored by a worker actor. | Phase 3 | T1 | YES | ABORT via `trg_decisions_principal_only`. |
| SQL-15 | Insert a decision authored by a disabled principal. | Phase 3 | T1 | YES | ABORT via `trg_decisions_principal_only`. |
| SQL-16 | Reference a principal RETEST decision while setting `APPROVED`. | Phase 3 | T2 | YES | ABORT; RETEST has no `decision_grants` row. |
| SQL-17 | Reference APPROVE while setting `JOB_COMPLETED`. | Phase 3 | T2 | YES | ABORT; semantic grant is APPROVE→APPROVED only. |
| SQL-18 | Use a granting decision from another job. | Phase 3 | T2 | YES | ABORT via `d.job_id = NEW.job_id`. |
| SQL-19 | Use a granting decision from another cycle. | Phase 3 | T2 | YES | ABORT via `d.cycle = NEW.cycle`. |
| SQL-20 | Use a decision whose `to_state` does not equal the job’s new state. | Phase 3 | T2 | YES | ABORT via exact `d.to_state = NEW.state` predicate. |
| SQL-21 | Use a previously valid decision after disabling its principal actor. | Phase 3 | T2 | YES | ABORT via enabled-principal join. |
| SQL-22 | Set a new authoritative status with `deciding_decision_id=NULL`. | Phase 3 | T2 | YES | ABORT via required decision condition. |
| SQL-23 | Clear a previously set `authoritative_status` to NULL. | Phase 3 | T2 | YES | ABORT via `NEW.authoritative_status IS NULL`. |
| SQL-24 | Stamp a status using only `worker_runs.worker_verdict='PASS'`, with no granting decision. | Phase 3 | T2 | YES | ABORT; worker verdict has no authority path. |
| SQL-25 | Update any `decisions` column. | Phase 3 | T5 | YES | ABORT via `trg_decisions_no_update`. |
| SQL-26 | Delete any `decisions` row. | Phase 3 | T5 | YES | ABORT via `trg_decisions_no_delete`. |
| SQL-27 | Set `state='APPROVED'` while `authoritative_status` is NULL or mismatched. | Phase 3 | T4 | YES | ABORT via `trg_state_matches_auth_status`. |
| SQL-28 | Move `JOB_COMPLETED` to `APPROVED` with a syntactically matching attempt. | Phase 3 | T3/T2 | YES | ABORT via terminality/rank and granting-decision checks. |
| SQL-29 | Move any terminal status to another status or lower a non-terminal rank. | Phase 3 | T3 | YES | ABORT via `trg_auth_status_monotonic`. |
| SQL-30 | Update/delete any `audit_log` row. | Phase 3 | T5 | YES | ABORT via `trg_audit_no_update`/`trg_audit_no_delete`. |
| SQL-31 | Insert a job with an unknown `owner_actor_id` or unknown referenced status. | Phase 3 | SQLite FK | YES | Reject with foreign keys ON. |
| SQL-32 | Insert a decision/run/evidence/artifact/lease/idempotency row with an unknown FK. | Phase 3 | SQLite FK | YES | Reject via the corresponding approved FK. |
| SQL-33 | Insert a duplicate artifact `(job_id, rel_path)`. | Phase 3 | SQLite UNIQUE | YES | Reject via the artifact UNIQUE constraint. |
| SQL-34 | Insert invalid worker status/verdict/failure/attempt, invalid evidence trust, invalid audit result, or negative bytes/cycle/version. | Phase 3 | SQLite CHECK | YES | Reject via structural CHECK constraints and approved domains. |
| SQL-35 | Create a lease whose `job_id`/`cycle` disagree with its referenced run. | Phase 3 | Structural composite FK/UNIQUE | YES | ABORT via the approved Phase 3 composite relation: `worker_runs(run_id, job_id, cycle)` is UNIQUE and referenced by `leases`. |
| SQL-39 | Insert a job with a non-NULL `authoritative_status`. | Phase 3 | T7 | YES | ABORT via `trg_jobs_unstamped_on_insert`; the job row is absent. |
| SQL-40 | Insert a job already in a terminal authoritative state. | Phase 3 | T7 | YES | ABORT via `trg_jobs_unstamped_on_insert`; the job row is absent. |
| SQL-41 | Insert a job in an authoritative workflow state with NULL status. | Phase 3 | T7 | YES | ABORT via `trg_jobs_unstamped_on_insert`; the job row is absent. |
| SQL-42 | Insert a job with a non-NULL `deciding_decision_id`. | Phase 3 | T7 | YES | ABORT via `trg_jobs_unstamped_on_insert`; the job row is absent. |
| SQL-43 | Delete an unstamped job row. | Phase 3 | T7 | YES | ABORT via `trg_jobs_no_delete`; the complete job row is unchanged. |
| SQL-44 | Delete a stamped terminal job row. | Phase 3 | T7 | YES | ABORT via `trg_jobs_no_delete`; the complete job row is unchanged. |
| SQL-45 | Disable foreign keys on a second connection, delete a stamped job, and reinsert it as authoritative. | Phase 3 | T7 | YES | The DELETE aborts before the laundering INSERT; job/status/decision rows remain unchanged. |
| SQL-46 | Duplicate ordinary INSERT into an existing `jobs.job_id`. | Phase 3 | T8 | YES | ABORT via `trg_jobs_no_replace`; the original job remains unchanged. |
| SQL-47 | `INSERT OR REPLACE` an existing job with an unstamped row. | Phase 3 | T8 | YES | ABORT with `recursive_triggers=OFF`; terminal/state/status/decision data remains unchanged. |
| SQL-48 | Bare `REPLACE` an existing job with an unstamped row. | Phase 3 | T8 | YES | ABORT with `recursive_triggers=OFF`; the durable job identity cannot be reset. |
| SQL-49 | `INSERT OR REPLACE` an existing decision with different contents. | Phase 3 | T8 | YES | ABORT; T2 continues to evaluate the original decision row. |
| SQL-50 | Bare `REPLACE` an existing decision with different contents. | Phase 3 | T8 | YES | ABORT; the append-only decision ledger remains unchanged. |
| SQL-51 | `INSERT OR REPLACE` an existing `audit_log.seq` with forged contents. | Phase 3 | T8 | YES | ABORT; the original audit row/hash remains unchanged. |
| SQL-52 | Bare `REPLACE` an existing `audit_log.seq` with forged contents. | Phase 3 | T8 | YES | ABORT; the original audit row/hash remains unchanged. |
| SQL-53 | Use an UPSERT conflict path against an existing job. | Phase 3 | T8 | YES | ABORT as a durable-row replacement; ordinary new inserts remain valid. |

These cases include architecture raw-SQL invariants 7–15 and 15a–15j, plus
the F-1 replacement cases, invariant 16, and the required FK/UNIQUE/CHECK/
migration protections. SQL-09
through SQL-11 also rerun live T3 attempts after each rejected reference-data
mutation to prove the protected behavior, not merely the ABORT. SQL-39 through
SQL-45 prove the T7 job-row lifecycle independently of application repositories;
SQL-46 through SQL-53 prove T8 against all replacement forms.

### 13.2 FUTURE HAND-OFF ADVERSARIAL MATRIX

| ID | Direct SQL attempt | OWNER_PHASE | ENFORCEMENT_LAYER | PHASE_3_EXECUTABLE | Required later result |
|---|---|---|---|---|---|
| SQL-03 | Mutate actor identity/role/`capabilities_json` after creation, or otherwise attempt active capability administration. | Phase 4 | Authority/auth administration | NO | Phase 4 must define the valid actor-admin lifecycle and reject unauthorized role/capability mutation. Phase 3 only owns structural actor domains and invariant 16. |
| SQL-06 | Update an `actor_tokens` actor binding/digest to forge a relationship. | Phase 4 | Persistent-auth/token lifecycle | NO | Phase 4 must define token binding immutability, revocation, and administration. Phase 3 owns FK, digest shape, and UNIQUE only. |
| SQL-36 | Reset a consumed lease to NULL or consume it twice. | Phase 6 | Active lease consumption/report transaction | NO | Phase 6 must use `UPDATE … WHERE consumed_at IS NULL`, preserve duplicate behavior, and audit replay. Phase 3 does not activate consumption. |
| SQL-37 | Insert an expired/disabled token and attempt authentication, or bypass expiry by direct SQL use. | Phase 4 | Persistent verifier/startup auth | NO | Phase 4 must reject the token at active authentication. A historical expired row need not be rejected by a static CHECK; Phase 3 only stores its exact schema. |
| SQL-38 | Insert/modify an unsafe workspace path, bypass `version` CAS, or turn config text into a new capability. | Phase 4/5 | Active capability/config and job lifecycle | NO | Phase 4 owns capability activation; Phase 5 owns workspace and CAS lifecycle. Phase 3 does not claim realpath, time, or CAS enforcement. |

### 13.3 Matrix ownership rules

- Phase 3 executable tests may use fixture principal/system/token rows directly
  in a throwaway DB. They must not add those rows to production init or serve.
- Phase 3 owns structural DB rejection, T1–T8, exact seed freezing, canonical
  schema-definition verification, and invariant 16. It does not own production
  authentication or exactly-one-enabled-principal startup enforcement.
- Phase 4/5/6 hand-off cases remain required design evidence and must not be
  reported as Phase 3 completion gates.
- After all Phase 3 T2/T3/T4 attacks, the job’s prior status/state/version must
  remain unchanged. The later lease/report cases must additionally verify no
  duplicate evidence, settlement, or audit effect.

## 14. Benchmark recommendations adopted, rejected, and deferred

### Adopted in the Phase 3 plan

- SQLite-only durability and no second lease store.
- Exact many-to-one `actor_tokens` schema with unique digest, structural
  disabled/expiry fields, and `label`; no token-scopes column.
- Actor/job/cycle/run lease columns and the safe composite structural
  `worker_runs`/`leases` binding proposed in §6.2; active lease use remains
  Phase 6.
- Strict structural Zod v4/application inputs plus DB final constraints, without
  activating Phase 4 capability semantics.
- One local writer, `BEGIN IMMEDIATE`, deterministic migrations, and raw-SQL
  proof rather than application-only claims.
- Explicit init/serve/doctor modes, pre-open security verification, and WAL/SHM
  sidecar handling.

### Already present and preserved from Phase 2

- Official TypeScript MCP SDK v2 factory/stdio entries.
- Separate bearer, Host, and Origin gates.
- Loopback-only HTTP.
- Phase 1 startup gate before serving.
- Hash-only in-memory Phase 2 resolver and authenticated stdio.
- Minimal `ping`-only production tool surface.

### Deferred with reason

- Production principal/system bootstrap, first token issuance/printing,
  persistent-auth activation, capability/role activation, and verified session
  attribution: Phase 4 owns active authority/auth and invariants 17–20.
- Hermes single-owner process lifecycle, process identity, parked/reviving
  runtime, and bounded retry: owned by Phases 6/8, not DB authority.
- Windows Job Objects, process-group cleanup, graceful/force termination, and
  PID start-time identity: owned by Phase 6/8 process runtime.
- Active lease consumption, expiry, replay, and cleanup: Phase 6.
- Session TTL/capacity/reaper execution: schema can hold later fields, but
  active behavior is Phase 6/8.
- Remote URL/DNS-pinning/SSRF guard: V1 is local/loopback and has no remote
  egress; revisit only with an approved feature/threat model.
- OTel/Pino/structlog/metrics: Phase 9/later and separate from the audit chain.
- DPAPI/keyring/keytar: current ACL-protected regenerable lease key is the V1
  decision; revisit only for a concrete offline-copy requirement.
- Dynamic MCP/worker registry and schema cache: not needed for fixed Phase 3
  persistence and could create a second authority path.

### Rejected

- PM2: second daemon supervisor, AGPL-3.0, and outside local V1 scope.
- `node-tree-kill`: old shell/process-query implementation without AOM run
  identity or lifecycle state.
- keytar: archived/native and unnecessary for hash-only bearer tokens.
- Python/Rust runtime dependencies: AOM is TypeScript/Node 22 and the worker
  execution plane is later NDJSON.
- Microsoft MCP Gateway and registry cloud stacks: useful patterns, but their
  Kubernetes/Redis/Cosmos/NGINX/Mongo/OAuth systems are not AOM’s local store.
- Hermes function-calling examples and Awesome MCP catalog: not authority,
  persistence, or lifecycle implementations.

## 15. Phase 3 acceptance gates

Every gate below is executable within Phase 3 and does not require active Phase
4/5/6 behavior:

1. `better-sqlite3` is the only new production dependency at the exact
   reviewed version `13.0.3` in the lockfile; its matching
   `@types/better-sqlite3` package is development-only.
2. `openDatabaseForInit`, `openExistingDatabaseForServe`, and
   `inspectDatabaseFilesForDoctor` enforce their explicit modes. Init may create
   the schema DB; serve is existing-only; doctor never invokes
   `better-sqlite3` on the authoritative DB, never writes/creates/migrates,
   and reports `DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`.
3. Existing DB path, DB file, and WAL/SHM sidecars are security-checked before
   any writable SQLite open; doctor performs the filesystem/security checks and
   never opens SQLite or runs a write-affecting PRAGMA.
4. All four migrations apply deterministically once, roll back atomically, validate
   the applied set as a contiguous prefix of the known ordered set, reread it
   after `BEGIN IMMEDIATE` before deciding pending work, and refuse
   gaps/unknown/newer/corrupt schema states.
5. All 13 tables, approved indexes, exact seeds, structural checks, canonical
   definitions, and T1–T8 triggers are present and verified after migration.
6. T5/T6 seed ordering is tested: seed inserts succeed before freeze triggers;
   equivalent post-seed mutations abort.
7. Invariant 16 is proven: a second principal is rejected by the partial unique
   index. Phase 3 does not require exactly one enabled principal.
8. Actor/token structural tests prove FK, digest shape, UNIQUE digest, and no
   token-scopes column. Production actors, tokens, persistent lookup, and
   token lifecycle are not activated; fixtures may seed rows in throwaway DBs.
9. The 48-case Phase 3 raw-SQL matrix passes, including architecture invariants
   7–15 and 15a–15j, F-1 replacement cases, invariant 16, and post-attack
   assertions. The five future hand-off cases are not Phase 3 gates.
10. Decisions and audit rows are structurally append-only under T5; worker
    verdicts have no database authority path; transaction primitives use
    `BEGIN IMMEDIATE` without exposing later tools.
11. The Phase 3 transitional runtime keeps Phase 2 authentication, transports,
    and `ping`-only production surface green. No principal/token auth activation
    or authority tool is introduced.
12. `doctor` reports filesystem/security state and
    `DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN` without DB contents or secret
    material; `serve` refuses an absent or corrupt DB without repairing it.
13. The production doctor path has an instrumented/injected database opener test
    proving that it never calls the opener for the authoritative DB.
14. Doctor filesystem before/after tests prove the DB and every present WAL/SHM
    sidecar keep identical hash, size, and mtime, no new sidecar appears, and no
    DB is created.
15. `git diff --check` passes for this implementation. Typecheck, lint, tests,
     and build are green for the implementation change.
16. Canonical same-name tampering of every physical T1–T8 trigger, the
     principal index, `actor_tokens`, and the lease composite relation is
     rejected before serve binds HTTP or emits stdio protocol output.
17. Actual Windows temporary fresh-init failures for migration 001 and 002
    preserve the original error, leave zero DB/WAL/SHM artifacts, and allow a
     normal schema-v4 retry.
18. `recursive_triggers=ON` is set and verified on AOM-owned writable
    connections, while replacement remains rejected with it explicitly OFF on
    an external connection.

## 16. Explicit Phase 4+ exclusions and hand-offs

| Later phase/feature | Not implemented in Phase 3 | Required hand-off |
|---|---|---|
| **PHASE 4 HAND-OFF — authority/auth activation** | Production `codex`/`system` bootstrap, first token issuance/printing, token administration, persistent `actor_tokens` resolver, exactly-one-enabled-principal `serve` gate, active capabilities/roles, `TRANSITIONS`, `applyTransition`, `codex_decide`, verified session attribution, and active audit-chain semantics | Activate only after Phase 3 schema/integrity review. Derive `AuthInfo.scopes`/capabilities from the verified actor’s `actors.capabilities_json`; use `actor_tokens.label` for attribution; never add token scopes or a second auth system. |
| Phase 5 job lifecycle | `job_create`, `job_get`, `job_list`, cycle decisions, workspace lifecycle, public idempotency/CAS orchestration | Use `jobs`, `decisions`, `idempotency`, and `BEGIN IMMEDIATE`; workspace realpath policy remains with the job lifecycle owner. |
| Phase 6 worker runtime | `WorkerAdapter`, `ProcessRuntime`, NDJSON, worker registry execution, active lease issue/consume/report behavior | Use `worker_runs`, `leases`, composite run binding, actor binding, and append-only evidence/report rules. |
| Phase 7 evidence/artifacts | MCP tools and path-jail file operations | Use metadata tables only; hashes are computed by the orchestrator. |
| Phase 8 resilience | Reaper loop, crash recovery, retries, process cancellation, graceful shutdown, active lease expiry/replay cleanup | Use status/failure/expiry columns and audit primitives; never auto-authority. |
| Phase 9 hardening | Rate limits, redaction sweep, OTel/Pino, docs/worker protocol, two-session drill | Keep audit chain separate; add no telemetry dependency in Phase 3. |
| Post-V1 `agy`/browser/CDP/remote | All adapters, remote egress, dynamic registry, cloud stores, browser credentials | Register later as ordinary configured process workers or explicitly threat-model remote features. |

### 16.1 PHASE 4 HAND-OFF contract (design only)

The Phase 4 implementation must receive a migrated Phase 3 schema-v4 DB and
must not change the Phase 3 table names or remove T1–T8. Its activation
checklist is:

1. bootstrap the sole production `codex` principal and internal `system` actor
   according to architecture §16;
2. issue the first production bearer token print-once, storing only its
   `token_sha256` plus the exact `label` and other approved columns;
3. map additional session tokens many-to-one to the same principal;
4. replace the Phase 2 in-memory/environment-derived resolver with DB lookup
   without a fallback second auth system;
5. derive scopes/capabilities from the verified actor’s
   `capabilities_json`, not token rows;
6. enforce exactly one enabled principal at `serve` startup and activate
   invariants 17–20;
7. activate verified token/session attribution, `TRANSITIONS`,
   `applyTransition`, the sole authoritative writer, and audit-chain semantics;
8. prove a worker cannot acquire principal authority.

None of these actions is part of a Phase 3 implementation WP.

## 17. Safe Phase 3 implementation work packages

The following **10 Phase 3 work packages** were implemented on this branch and
end at structural STORE/DB authority. They contain no Phase 4 bootstrap/auth
activation:

1. **WP-0 — dependency/version/license lock:** after explicit authorization,
   add only the reviewed `better-sqlite3@13.0.3` dependency; record the
   Node `>=22` compatibility and MIT license, and confirm no other
   source/tool surface changes.
2. **WP-1 — secure DB open modes:** implement and test the exact path,
   init/serve/doctor contracts, pre-open file/sidecar security, post-create
   DB-file hardening, PRAGMAs, close behavior, and safe error mapping. Doctor
   is filesystem/security-only and never opens the authoritative DB with SQLite.
3. **WP-2 — migration runner:** implement exact-set discovery for `[1, 2, 3, 4]`, fresh-versus-
   existing classification, contiguous-prefix validation, post-`BEGIN IMMEDIATE`
   ledger reread, future/gap refusal, runner-owned transactions, rollback,
   quick-check, foreign-key check, and required-object verification.
4. **WP-3 — migration 001 schema:** create the 13-table approved schema,
   indexes, FKs, structural CHECKs, and the approved composite
   `worker_runs`/`leases` binding; create no production authority rows.
5. **WP-4 — migration 002 seeds + T1–T6:** seed the exact grant/status rows,
   verify them inside the transaction, then install T1–T6 and verify the frozen
   state.
6. **WP-5 — migration 003/004 + canonical verifier:** install T7 and T8
   without changing historical migrations, then make init/serve verify the
   exact migration set, canonical tables/indexes/triggers/seeds, PRAGMA policy,
   sidecars, FK health, and invariant 16 at-most-one principal. Make doctor verify only
   filesystem/security state and report SQL as not checked by design. Do not
   enforce Phase 4’s exactly-one-enabled-principal serve rule in Phase 3.
7. **WP-6 — thin repositories:** implement structural actor/token/reference
   access and typed table/transaction primitives for fixtures and later
   hand-offs; no production bootstrap, auth activation, active token lifecycle,
   or later MCP tool.
8. **WP-7 — Phase 3 executable adversarial tests:** add the 48 executable SQL
   cases, including SQL-39–SQL-45 T7 lifecycle tests, SQL-46–SQL-53 F-1
   replacement tests, post-attack assertions, seed-order tests, invariant-16
   tests, canonical tamper tests, and migration crash/rollback tests. Keep the
   five future cases as documented hand-offs only.
9. **WP-8 — doctor/init DB-schema integration:** allow init to create/apply the
   schema only; keep serve existing-only and deep-integrity-gated; implement
   doctor as filesystem/security-only with no authoritative SQLite opener;
   preserve the Phase 2 resolver and `ping` surface; do not bootstrap
   principal/system/token.
10. **WP-9 — documentation/acceptance:** record the Revision 7 transitional
     runtime and Phase 4 hand-off, run only the authorized Phase 3 acceptance
     gates, and leave later behavior absent.

No work package creates a Phase 3 branch, commits, pushes, opens a PR, or merges
anything automatically. Those actions require separate authorization.

## 18. Phase 3 implementation evidence checklist

The implementation evidence for this branch records:

- [x] The plan is marked `IMPLEMENTED — PHASE 3 STORE & DATABASE AUTHORITY —
      REVISION 7 F-1 REMEDIATION`;
      Phase 4 remains unimplemented.
- [x] The exact database path and Phase 1 security/open ordering are enforced.
- [x] Init may create the schema DB only; serve is existing-only and owns deep
      SQL integrity; doctor direct SQLite open is forbidden and it reports
      `DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`.
- [x] Existing DB/sidecars are security-checked before writable open; doctor
      performs only the same filesystem/security diagnosis and never opens
      SQLite. New DB/sidecars are hardened/verified before migration or WAL
      writes.
- [x] Doctor tests inject/instrument the DB opener and prove zero authoritative
      DB-opener calls, and before/after tests prove no DB/WAL/SHM hash, size, or
      mtime change, no new sidecar, and no DB creation.
- [x] The count of approved tables is 13; no `cycles`, `capabilities`,
      workspace, registry, Redis, or cloud table was invented.
- [x] `decision_grants` and `authoritative_statuses` seeds exactly match §4.
- [x] T5/T6 freeze triggers are created after seed inserts in migration 002.
- [x] T1–T6 names, timing, predicates, and abort strings match the
      architecture unchanged; T7 adds the two approved physical job-row
      triggers and T8 adds the three approved replacement guards, all with
      fixed abort strings.
- [x] The migration ledger accepts only the exact contiguous prefix of the
      known ordered set `[1, 2, 3, 4]`, and is reread after `BEGIN IMMEDIATE`
      before pending migrations are selected; migration 004 is present.
- [x] Init/serve compare canonical normalized SQL definitions for every
      approved table, security-sensitive index, and physical T1–T8 trigger;
      same-name weakened objects fail closed before serving.
- [x] T7 raw-SQL tests cover authoritative/stamped job inserts, unstamped and
      stamped deletes, and foreign-key-off laundering, preserving job/status/
      decision rows.
- [x] F-1 replacement tests prove ordinary new inserts still work while
      duplicate INSERT, `INSERT OR REPLACE`, and bare `REPLACE` fail for jobs,
      decisions, and audit rows with `recursive_triggers=OFF`; audit
      AUTOINCREMENT inserts remain valid.
- [x] Fresh migration 001/002 failures close SQLite before removing only their
      DB/WAL/SHM artifacts, preserve the original error, and retry to schema
      version 4; stale `dist/store/migrations` files do not survive copying.
- [x] AOM-owned writable connections set and verify
      `recursive_triggers=ON` as defense in depth; external OFF connections
      remain covered by schema-resident T8 guards.
- [x] `withImmediateTransaction` rejects asynchronous/thenable callbacks and
      rolls back before COMMIT.
- [x] Supporting guards are classified: lease dimension consistency is a
      Phase 3 composite FK/UNIQUE; actor/token active immutability and
      capability semantics are explicitly deferred to Phase 4; lease
      consumption is deferred to Phase 6.
- [x] Invariant 16 is Phase 3 **at most one** principal; exactly one enabled
      principal is explicitly a Phase 4 activation check.
- [x] The exact `actor_tokens` columns are preserved: no token scopes column,
      and the persistent column name is `label`.
- [x] Production bootstrap, token issuance, persistent auth, and
      `ORCHESTRATOR_ACTOR_TOKEN` transition are confined to the Phase 4 hand-off.
- [x] SQLite-only durability and `BEGIN IMMEDIATE` are preserved.
- [x] The raw-SQL matrix has 48 Phase 3 executable cases and 5 future
      hand-off cases, without falsely assigning path/time/CAS/auth checks to
      Phase 3 SQLite.
- [x] No Phase 4+ MCP tools, worker runtime, retries, reaper, remote registry,
      observability stack is included; only the approved SQLite dependency and
      matching development typings were added.
- [x] The 10 Phase 3 work packages end at structural store/DB authority, and
      the separate Phase 4 hand-off is design-only.

## Plan status

This document records the implemented Phase 3 behavior under the approved
Revision 7 boundary, which retains the Revision 5 doctor decision and Revision
6 canonical-schema/job-row protections. The §4.5 feasibility evidence records why direct
SQLite inspection, immutable mode, and snapshot/copy workarounds are forbidden
in the Phase 3 doctor. Phase 4 authority/auth and later runtime behavior remain
unimplemented.

Current status: **PHASE 3 F-1 REMEDIATION READY FOR FINAL RE-REVIEW**.
