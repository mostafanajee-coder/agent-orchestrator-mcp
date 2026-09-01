# Agent Orchestrator MCP — V1 Architecture (Revision 7 Approved / Revision 8 Phase 4 Baseline / Revision 9 Phase 6 Published / Revision 10 Phase 7 Published / Revision 11 Phase 8 Published / Revision 12 Phase 9 Published / Revision 13 Phase 10 Plan)

> **Status:** Revision 7 remains the approved Phase 3 baseline. Revision 8 is the approved Phase 4 planning baseline originating at `65008a97d0c88b6e104994cb23408f7f46ab11f6`; its implementation was merged through PR #7 at `ea07fbcae4264fb91601ba03b1bbc84c57e8b7a5`.
> Revision 9 records the scoped Phase 6 worker runtime, now published in
> `main` and `origin/main` at `88670743f8a443bbf3b71c9f379199deca42d512`.
> Revision 10 below is the reviewed and published Phase 7 implementation baseline. Its
> separate Codex authorization applied only to `codex/phase7-implementation`;
> the implementation and corrective Windows path fix are published in
> `main` and `origin/main`, with the final documentation closure at
> `d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3`.
> Revision 11 below records the published Phase 8 resilience and recovery implementation;
> Revision 12 below records the Phase 9 hardening plan and its implementation,
> merged and published in `main` and `origin/main`.
> Revision 13 below records the documentation-only Phase 10 plan; Phase 10
> implementation has not started and is not authorized. Its Codex adjudication
> is recorded in the Phase 10 planning documents.
> The Revision 8 proposal also amends the shared design sections §4, §14, §16,
> and §21 where explicitly identified below.

---

## Revision Delta

### Revision 8 / Phase 4 authority and auth activation (approved implementation baseline)

Revision 8 is the approved amendment governing the merged Phase 4
implementation. It preserves the Revision 7 Phase 3 baseline and covers only
the scoped Phase 4 work merged through PR #7; it does not authorize Phase 5/6
behavior.

The proposed Phase 4 target is schema version 6, reached by two new reviewed
migrations:

- `005_audit_sequence_guard_correction.sql` resolves O-1 before any audit
  writer exists by replacing only the existing audit replacement condition with
  the positive-sequence form equivalent to `NEW.seq > 0`. It must fail closed
  on pre-existing nonpositive audit sequence rows and record its version
  atomically. O1-02 verifies normal omitted AUTOINCREMENT inserts and existing
  positive identities in an isolated throwaway database; the migration itself
  does not write a verification row. Its compiled canonical fingerprint is
  updated in the reviewed source change, not by runtime migration SQL.
- `006_actor_token_immutability.sql` adds schema guards for actor identity/role/
  capability/creation fields and token identity/binding/digest/label/expiry/
  creation fields. Revoke and `last_used_at` lifecycle updates remain possible;
  a disabled token cannot be re-enabled. Historical migrations 001–004 are
  never rewritten.

The canonical fingerprint registry becomes version-keyed for schema versions 4,
5, and 6. A v4 database is checked against v4 definitions before migration 005,
against v5 definitions after migration 005, and against v6 definitions after
migration 006; the final init/serve check uses v6. These expected definitions
are compiled source data updated in the reviewed migration changes, never by
runtime migration SQL.

Phase 4 retains the literal V1 actor IDs `codex` (the one principal) and
`system` (the internal actor), but authority is actor/role/capability based and
not tied to an executable name. Many verified `actor_tokens` sessions map to
the same `codex` actor, leaving a future approved ChatGPT MCP client on the
same authentication model without a second principal or authority system.
The exact static public capability catalogue remains
`job:create`, `job:read`, `job:decide`, `qa:request`, `work:report`,
`evidence:add`, and `artifact:register`; `system` has `capabilities_json=[]`
and no bearer token. The startup gate rejects any additional `system`-role
actor and any `actor_tokens` row mapped to `system`.
`work:report` remains worker-only; the principal is not granted a
lease-backed worker-report path.

`init` is the only explicit production bootstrap path. It atomically creates
the exact principal/system rows and the first digest-only token on a valid
empty schema, prints the token once after commit, and is idempotent on a valid
already-bootstrapped state. Ambiguous or partial actor/token states fail
closed; `serve` never bootstraps credentials. Local CLI token issue/list/revoke
is proposed; token administration is not an MCP tool, token scopes are not a
database field, and the Phase 2 environment variable is only token delivery.

The persistent resolver validates the database token, actor, role,
capabilities, disabled state, expiry, and immutable session label. It has no
Phase 2 fallback. Startup requires exactly one enabled `codex` principal, the
exact enabled `system` actor, valid role-compatible capabilities, valid token
rows, and the Phase 3 schema/migration/canonical gates before HTTP bind or
stdio protocol output.
The resolver also rejects a system-role actor before any client transport
context is created.

Transport compatibility is wire-only. The existing HTTP wire contract keeps a
fixed `mcp` transport marker; the adapter exposes that marker alongside the
verified actor capabilities as non-authoritative SDK wire metadata. It is not
stored as a token scope, does not grant a capability, and does not create an
authentication fallback. Application authorization uses only the verified
actor capabilities.

`expires_at = NULL` means no scheduled expiry. A non-NULL value is an
immutable RFC3339 UTC timestamp ending in `Z`; a token is expired when
`expires_at <= current_utc_time`. Expired and revoked token rows remain
available indefinitely in V1 for attribution and audit history, with no prune
path in this phase. The resolver rejects them permanently; retention never
restores authentication validity.

`codex_decide` remains the narrow Phase 4 authority tool and uses the existing
fixture/production job rows; `job_create`, job query tools, workers, leases in
active use, evidence/artifact tools, and broader lifecycle remain Phase 5/6.
The sole application authority writer uses the static `TRANSITIONS` table,
mandatory rationale, expected-version CAS, verified `session_token_id`,
`BEGIN IMMEDIATE`, T1–T4, and an atomic decision/state/status/audit unit.
Phase 4 owns decision-scoped idempotency and expected-version CAS for
`codex_decide` only; broader job/lifecycle idempotency and CAS remain Phase 5.

After O-1, active Phase 4 audit writing may use the existing `audit_log` table:
append-only AUTOINCREMENT rows, fixed canonical JSON/hash-chain input, genesis
hash, redacted bounded details, verified session attribution, and no update,
delete, conflict-resolution, or self-repair path. The audit writer is disabled
until migration 005 and its tests pass.

Revision 8 adds `bootstrap.completed`, `token.issued`, and `token.revoked` to
the Phase 4 audit action catalogue. The stored hash is
`SHA-256(canonical_json(row_without_hash))`, with `prev_hash` included once as
the final canonical key and no separate prefix concatenation.

The full Phase 4 plan, 12 work packages, 70-case executable matrix, security
answers, review sequence, and explicit Phase 5/6 exclusions are recorded in
`docs/PHASE4_PLAN.md`. Revision 8 is the approved Phase 4 baseline and its
implementation is merged. Phase 5 planning and its explicit implementation
authorization are recorded separately in `docs/PHASE5_PLAN.md`; that plan
authorizes only the scoped Phase 5 implementation branch.

### Revision 7 / SQLite row-replacement integrity (this revision — approved architecture correction)

Revision 6's DELETE-only durability claim was incomplete for SQLite
`REPLACE` conflict resolution. With `PRAGMA recursive_triggers=OFF`, SQLite can
remove a conflicting PRIMARY KEY row before inserting the replacement without
firing the row's `BEFORE DELETE` trigger. That path could otherwise erase a
terminal job, rewrite an append-only decision, or forge an `audit_log` row.

Revision 7 preserves Revision 5's doctor decision, Revision 6's canonical
schema verification, T1–T7, the 13-table schema, Phase 2 behavior, and the
Phase 4 boundary. It adds only:

- Migration `004_row_replacement_integrity.sql`, without rewriting historical
  migrations `001`/`002`/`003`.
- T8, with INSERT-side identity-existence guards on `jobs`, `decisions`, and
  `audit_log`. A genuinely new row may be inserted, but an existing protected
  primary-key identity may not be inserted as a replacement, whether the
  caller uses `INSERT OR REPLACE` or bare `REPLACE`.
- AOM-owned writable connections set and verify
  `PRAGMA recursive_triggers=ON` as defense in depth. The schema-resident T8
  guards remain the integrity boundary and continue to reject replacement from
  an external connection that explicitly sets it OFF; the design does not
  depend on a caller honoring AOM's connection policy.
- Canonical verification of every physical T1–T8 trigger and schema version 4.

Canonical SQL fingerprints intentionally preserve SQL case and comments; only
whitespace is normalized. Any reviewed DDL change must regenerate the compiled
fingerprint in the same reviewed source change. A fail-closed representation
drift is preferable to accepting weakened DDL.

### Phase 5 planning amendment (implemented and merged — historical planning record)

The Phase 5 planning baseline and its authorized implementation branch added a
lifecycle staging amendment. It was independently reviewed, approved for the
final merge gate, and published in `main`; it did not retroactively alter the
approved Phase 4 boundary. The amendment
touches §1, §4, §6, §8, §14, §15, §17, §18, §19, §20, §21, and §23 only:

- §4 defines one guard-selected outcome for each `(from_state, transition)`
  key, so the existing `FIX`/`RETEST` verbs can select the normal or
  cycle-limit outcome deterministically without duplicate keys;
- §6 assigns normal cycle increment to the Phase 4 decision transaction,
  keeps `resume` non-incrementing, and documents the proposed
  `STALLED(max_cycles)` guard;
- §8 proposes permanent V1 `job_start`/`job_resume` lifecycle operations and
  the Phase 5 `job_get` collection restriction;
- §14 adds the `job.resume` audit action;
- §15 and §18 define the protected runtime `config.json` source for workspace
  roots and bounded lifecycle defaults, with no invented POSIX roots;
- §17 and §19 reconcile failed-CAS behavior as a no-durable-mutation result;
- §20 and §21 distinguish the ten baseline tools from the two proposed Phase 5
  additions and split invariant ownership; and
- §1 and §23 identify `docs/PHASE5_PLAN.md` as a separate proposed planning
  workstream that does not authorize implementation.

The published Phase 5 implementation contains the one narrowly scoped
cycle-exhaustion dependency amendment to the existing
`applyTransition`/`codex_decide` choke point and its audit handling. No other
Phase 4 source change was authorized by that Phase 5 decision.

### Revision 6 / Phase 3 job-row and schema-verification correction (historical approved architecture correction)

Revision 6 preserves the Revision 5 doctor boundary and all T1–T6 semantics. It
adds the narrow D-1/D-2/D-3/D-4/D-5/D-6 corrections approved for the Phase 3
implementation:

- Migration `003_job_row_integrity_and_schema_verification.sql` installs T7 as
  two physical triggers: `trg_jobs_unstamped_on_insert` rejects any new job
  with a non-NULL `authoritative_status`, a non-NULL `deciding_decision_id`, or
  an authoritative initial `state`; `trg_jobs_no_delete` rejects every runtime
  job deletion. Both use the fixed error strings recorded in §4.
- A job row is a durable ledger root. It must begin in a non-authoritative
  workflow state with both authority columns NULL, and it cannot be deleted,
  including by a second connection with foreign-key enforcement disabled.
- `init` and `serve` verify canonical normalized SQL definitions, not only
  object names, for all approved tables, security-sensitive indexes, and every
  physical T1–T7 trigger. A same-name weaker object is therefore a startup
  failure before HTTP bind or stdio protocol output.
- The approved migration set is exactly `[1, 2, 3]`. Failed fresh-init
  attempts close SQLite before removing only the DB/WAL/SHM files created by
  that attempt, while preserving the original failure. Build copying clears
  the exact `dist/store/migrations` destination first, and the synchronous
  transaction primitive rejects thenables before commit.
- The Phase 3 repository inventory is the implemented single
  `src/store/repositories.ts` module. Phase 4 design remains intact and is not
  activated by these corrections.

### Revision 5 / Phase 3 doctor ownership (historical approved architecture correction)

Phase 3 adopts a **FAIL-CLOSED / NO-DIRECT-SQL DOCTOR** contract for the
authoritative WAL database. `doctor` never opens
`orchestrator.db` through SQLite, even with `readonly: true`,
`immutable=1`, or a URI environment toggle.

The doctor owns filesystem/security diagnostics only: trusted-path existence,
`lstat`/realpath safety, object type, Windows DACL/POSIX mode, reparse
and hard-link safety, DB metadata, and the security state of any existing
`-wal`/`-shm` sidecars. Its structural result explicitly
reports `DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`; that status is not a
SQL-integrity pass. Unsafe DB/path/DACL/sidecar state remains a doctor failure,
while an absent DB is reported without creation. The inability to perform SQL
inspection is not itself an error: if all doctor-owned checks pass, doctor may
exit successfully with `DB_FILE_SECURITY=PASS` and the explicit
`NOT_CHECKED_BY_DESIGN` status.

`init` and `serve` startup own authoritative SQLite integrity:
secure open/create ordering, approved PRAGMAs, migrations, exact ledger/schema
verification, `quick_check`, `foreign_key_check`, tables,
indexes, triggers, seeds, and structural guards. `serve` fails before
MCP service when a required DB check fails.

The empirical Windows finding is that direct readonly WAL queries can mutate an
existing `-shm` or create `-wal`/`-shm`, while
immutable mode can ignore uncheckpointed WAL state. Phase 3 therefore selects no
snapshot, copy, quiescence, VSS, immutable, alternate engine, or external
snapshot workaround. A future offline/deep doctor may be reconsidered only after
a later lifecycle/hardening phase owns the required maintenance semantics.

### Revision 4 / Phase 1B (historical approved architecture correction)

**The Windows state root moves from `%LOCALAPPDATA%\AgentOrchestratorMCP\` to `<OS-reported user profile>\.agent-orchestrator-mcp\`** — typically `C:\Users\<user>\.agent-orchestrator-mcp`.

**Why LocalAppData was rejected.** A packaged (MSIX) process has `%LOCALAPPDATA%` virtualized into
`...\Packages\<id>\LocalCache\Local`. Measured on Windows 11 during Phase 1A: a state root created
at `%LOCALAPPDATA%\AgentOrchestratorMCP` by a packaged process resolved to the package's private
`LocalCache` store, and an unpackaged process launched on the same machine reported that same
logical path as **absent**. Two clients would therefore have kept two different physical stores,
breaking the core invariant that there is exactly **one orchestrator state store per user** — the
store Codex, the orchestrator, and every worker must agree on.

**Why the user-profile root was chosen.** It remains user-scoped rather than machine-wide, but sits
outside the LocalAppData virtualization boundary. Measured from both a packaged and an unpackaged
process on the same machine, the user-profile root produced an identical logical path, an identical
real path, and an identical `lease.key` digest.

**USERPROFILE is not the source of truth.** The location normally corresponds to `%USERPROFILE%`,
but that environment variable is *not* trusted to determine it. The profile directory is obtained
from OS user identity (`os.userInfo().homedir`). `os.homedir()` is explicitly not used on Windows:
Node documents it as consulting USERPROFILE first, and that was confirmed here — with
`USERPROFILE=D:\attacker-profile`, `os.homedir()` returned `D:\attacker-profile` while
`os.userInfo().homedir` still returned the real profile. Trusting the variable would let anyone who
can set it relocate the state root and the secrets in it. There is no fallback: if the OS cannot
report the profile, resolution fails closed.

**Network profiles are rejected in V1.** The Windows profile must be a normal local
drive-qualified path (`<drive>:\...`). UNC paths (`\\server\share\...`), the Win32 device
namespaces (`\\?\`, `\\.\`), drive roots, and relative paths are all refused. V1 is a local
orchestrator; the system of record must not live on a share.

Consequences, all narrow:

- Neither `%LOCALAPPDATA%` nor `%USERPROFILE%` is consulted for the active root; it derives from the
  OS-reported profile directory, validated as absolute, platform-appropriate, local (not UNC or
  device-namespace), and not a filesystem root.
- Pure path construction selects `path.win32` or `path.posix` from the *target* platform, so the
  Windows rules produce genuine Windows paths even when checked on a Linux CI runner.
- The `allowRedirectionBoundary` exemption introduced in Phase 1A is **removed**. It existed only
  because the LocalAppData root sat on a virtualization boundary. Every protected path, the root
  included, is now subject to the full strict check with no package-specific bypass.
- The superseded LocalAppData root is **detected and reported by `doctor` as a warning only**. It is
  never read, never migrated, never deleted, and never authoritative; a fresh `lease.key` is
  generated in the new root. Its path is derived from the trusted profile directory
  (`<profile>\AppData\Local\AgentOrchestratorMCP`), never from `LOCALAPPDATA`, so a poisoned
  variable cannot make `doctor` probe an attacker-chosen or network location. The old key had not yet been used by any later phase, so preserving it
  would add ambiguity for no functional benefit.

POSIX behaviour, the security model, the directory layout, and the lease-key format are unchanged.

### Revision 3 / Phase 1A (single hardening change)

**`authoritative_statuses` is now frozen at runtime, exactly like `decision_grants`.**

Revision 2 froze `decision_grants` but left `authoritative_statuses` writable. Trigger T3 (monotonicity and terminality) reads `rank` and `terminal` from that table, so a direct-SQL mutation of its rows would silently disarm T3 without ever touching a job row — for example `UPDATE authoritative_statuses SET terminal = 0 WHERE authoritative_status = 'JOB_COMPLETED';` would make a terminal outcome reopenable, and lowering `APPROVED`'s rank (or raising a terminal status's rank) would let milestones regress. Reference data that a security trigger reads is part of the security boundary and must be immutable at runtime.

Revision 3 adds `INSERT`/`UPDATE`/`DELETE` triggers on `authoritative_statuses`, created **after** the migration seeds the rows, plus five raw-SQL bypass tests (§19, invariants 15a–15e) and a threat-model row (§15, threat 2b). Sections touched: §4, §15, §19, §21, §23. **Nothing else in Revision 2 is changed.**

### Revision 2 (what changed from Revision 1)

| # | Change | Sections touched |
|---|---|---|
| 1 | **Authority trigger strengthened.** The old trigger only proved the referenced decision belonged to the same job/cycle. It is replaced by an immutable `decision_grants` mapping table plus a `authoritative_statuses` rank/terminal table, and triggers that require the referenced decision to **semantically grant** the exact status being written, to have been authored by an **enabled principal**, and to target the same `state`. `RETEST`/`FIX`/`VERIFY_SELF`/`IGNORE_FALSE_POSITIVE` grant nothing and can never justify an authoritative write. Monotonicity and terminality are enforced in the DB. `decisions` and `audit_log` are now append-only at the DB level. | §4, §9, §19 |
| 2 | **`final_status` renamed to `authoritative_status`** throughout. `state` remains the workflow position. `PACKAGING` reclassified as a *workflow* state that requires `job:decide` to enter but stamps no new milestone. | §4, §6, §9, §19 |
| 3 | **Windows-native secret protection.** `chmod`/0600 is documented as a **no-op on Windows** and is now only the POSIX implementation. Windows uses inheritance-stripped, current-user-SID-only DACLs applied and **verified after creation**, failing closed. DPAPI evaluated explicitly and deferred, with rationale. Token material is **print-once** by default so the orchestrator holds no plaintext bearer token at rest. | §15, §18, §20, §21 |
| 4 | **Single global state root** `<OS profile>\.agent-orchestrator-mcp\` with `data\ artifacts\ secrets\ logs\`. **One database for all projects** — no per-workspace DB. Jobs still record their `workspace`, and `job_list` queries across projects. | §9, §13, §17, §18, §21 |
| 5 | **Multiple concurrent Codex sessions supported from V1.** Still exactly one principal actor row. Tokens moved out of `actors` into a many-to-one `actor_tokens` table, so each Codex session can hold its own token that maps to the single principal — session identity becomes **verified, not claimed**. `session_token_id` and a server-generated `request_id` are recorded on decisions and audit rows. | §4, §5, §9, §14, §17, §19 |
| 6 | **Workspace roots are an explicit config allowlist**, seeded with `C:\AgentProjects` and `C:\SallaProjects`. Additive without code changes. Artifact storage is separate, under the global root. | §9, §15, §18 |
| 7 | **Browser/CDP worker stays external** for the first integration and is registered later as a generic process worker. No CDP dependency enters the V1 core. | §12, §20, §22 |
| 8 | **Exactly-one-principal invariant.** The unique partial index still guarantees *at most* one; a startup invariant now requires *exactly one enabled* principal or the service refuses to serve. Bootstrap behaviour documented. | §4, §16, §19, §21 |
| 9 | **`qa_dispatch` lifecycle disambiguated.** `QA_REQUESTED` is **removed from the observable state set**; request-and-dispatch is one `BEGIN IMMEDIATE` transaction ending in `QA_RUNNING`. `RETEST` now returns the job to `IN_PROGRESS` at `cycle+1` and requires a fresh explicit dispatch. The unused `work:claim` capability is dropped. | §6, §8, §17 |
| 10 | **agy remains deferred**, and §11 now flags that the stdin/prompt contract is **unverified** against the installed CLI and must be re-verified empirically when that phase begins. | §11, §21, §22 |
| 11 | Open Questions no longer ask about state location, concurrent Codex sessions, workspace roots, or the browser worker's location — those are decided. | §22 |

Everything not listed above is unchanged from Revision 1.

---

## Context

We are building a general-purpose, local multi-agent orchestration system exposed over MCP. The problem it solves: today an agent that does work is also the agent that judges whether the work is good, and an agent that reviews work can quietly promote its own opinion into a final verdict. That is unsafe and unauditable.

This system makes **Codex the sole authority**. Codex accepts tasks, does the work, and decides. Everything else — Gemini via `agy`, a deterministic Chrome/CDP worker, future agents — are *workers and advisors* that produce **evidence**. The orchestrator is the control plane that dispatches them, persists what happened, and structurally prevents any worker from writing an authoritative status.

Intended outcome of V1: a small, reliable, well-tested core (job state machine + authorization + persistence + evidence/artifacts + audit + one generic worker adapter) onto which Gemini, browser workers, and other agents can be added as *configuration*, not as core rewrites. Nothing in the design is coupled to any specific site, repo, or task domain.

Environment verified read-only on this machine: Node **v22.22.0**, npm 11.6.4, git 2.53.0, `agy.exe` **1.1.22**, Python present but **3.7.9 (EOL)**.

**Decisions already made and closed:** HTTP-first transport with stdio also supported · per-actor tokens plus single-use dispatch leases · V1 = core + one generic process-worker adapter · single global state root under the OS-reported user profile (revised in Phase 1B; see the Revision Delta) · multiple concurrent Codex sessions with one principal · workspace allowlist `C:\AgentProjects`, `C:\SallaProjects` · browser worker stays external.

---

## 1. Executive Architecture Summary

A single long-lived local service (`agent-orchestrator-mcp`) that is:

- **An MCP server** — the control plane. Codex is its client. The baseline V1
  proposal lists ten tools, one of which (`codex_decide`) is the only door to
  authoritative status; the proposed Phase 5 staging amendment adds two
  non-authoritative lifecycle operations if independently approved.
- **A job store** — one SQLite database (WAL) at a global user-profile location, the single system of record across all projects: jobs, cycles, worker runs, evidence, artifacts, decisions, and an append-only hash-chained audit log.
- **A worker runtime** — spawns deterministic or LLM-backed worker processes, talks NDJSON over stdout, enforces timeouts/cancellation/retries, and normalizes everything into `WorkerReport`.

Four architectural commitments carry the whole design:

1. **Authority is a capability, not a prompt.** `job:decide` is held by exactly one enabled actor row whose `role='principal'`. Tools requiring it are not registered on servers built for other actors, handlers re-check it, the domain layer re-checks it, and the database independently refuses an `authoritative_status` that is not *semantically granted* by a principal decision targeting that exact state. T7 also prevents an authoritative or stamped job from entering the ledger before that decision path exists.
2. **Worker verdict ≠ authoritative status.** `worker_runs.worker_verdict` and `jobs.authoritative_status` are different columns in different tables with **no code path between them**. The only writer of `authoritative_status` is `domain/decide.ts`.
3. **Deterministic execution is separated from intelligent analysis.** Browser navigation, DOM reads, screenshots, console capture are mechanical work with no model in the loop. Models are spent only on interpreting the artifacts that work produced.
4. **The system never self-approves and never self-fails a job.** Timeouts, crashes, max-cycle exhaustion, and orphaned runs move a job to `STALLED` — a *non-authoritative* holding state — and wait for Codex. The `system` actor has no path to any authoritative status.

The orchestrator is the control plane; MCP is not forced to be the internal worker protocol. Worker execution uses plain subprocess + NDJSON, which is simpler, faster, and testable without a protocol stack.

---

## 2. Recommended V1 Stack

*(unchanged from Revision 1)*

| Concern | Choice |
|---|---|
| Language | **TypeScript 5.x**, `strict`, ESM |
| Runtime | **Node.js 22 LTS** (v22.22.0 present) |
| MCP SDK | **`@modelcontextprotocol/server` v2** (+ `@modelcontextprotocol/node`) |
| Validation | **Zod v4** (`zod/v4`) — the SDK's Standard Schema path |
| Persistence | **SQLite via `better-sqlite3`**, WAL, hand-written SQL + numbered migrations. No ORM |
| HTTP | **`node:http`** + `localhostHostValidation()` / `localhostOriginValidation()` + local bearer gate. **No Express** |
| Testing | **Vitest** |
| Process mgmt | `node:child_process.spawn` with argv arrays (never shell strings) |
| IDs | `crypto.randomUUID()`, `crypto.randomBytes` |

### TypeScript/Node vs Python

| Criterion | TypeScript/Node | Python | Verdict |
|---|---|---|---|
| MCP ecosystem maturity | Reference implementation; v2 is stable, implements 2026-07-28, **and serves legacy 2025-era clients from the same factory** | Official SDK is good, but TS leads on spec revisions and on the dual-era serving we need for an unknown Codex client era | **TS** |
| Subprocess management | `spawn` + streams is idiomatic, non-blocking | `asyncio.create_subprocess_exec` is fine; sync/async split is a footgun | TS (mild) |
| NDJSON streaming | Native | Fine | TS (mild) |
| SQLite | `better-sqlite3` prebuilds for Node 22/Windows; synchronous API is a *feature* for a transactional single-writer store | stdlib `sqlite3` is excellent | Python (mild) |
| Windows support | First-class; already installed and working | **Local Python is 3.7.9, EOL since June 2023** — a fresh interpreter is step zero | **TS** |
| Schema validation | Zod v4 → SDK derives the JSON Schema the model sees | Pydantic v2 is equally strong | Tie |
| Future workers | The proven Chrome/CDP worker is already Node — same runtime, same NDJSON contract | Would need a second runtime or a Python CDP client | **TS** |
| Packaging | `npm i -g` / `npx` | venv/uv adds a step | TS |

**Selected: TypeScript on Node 22**, for the dual-era SDK serving, the existing Node CDP worker, and the EOL local Python.

**`better-sqlite3` over `node:sqlite`:** `node:sqlite` is stability **1.1 "Active development"** on Node 22 and still warns. For the system of record for approval decisions, that is the wrong trade. All access goes through a thin `Store` interface, so moving to `node:sqlite` on Node 24+ later is a one-file change.

**Explicitly avoided:** Express, an ORM, a DI container, a message broker, a plugin framework, monorepo tooling.

---

## 3. Component Diagram

```
   ┌──────────────────────────────────────────────────────────────────┐
   │              CODEX  (PRINCIPAL — one actor, many sessions)        │
   │      accepts task · does work · reviews evidence · DECIDES        │
   └───────────────────────────┬──────────────────────────────────────┘
                               │ MCP (Streamable HTTP, 127.0.0.1, bearer)
                               │ per-session token → same principal actor
   ┌───────────────────────────▼──────────────────────────────────────┐
   │                    AGENT ORCHESTRATOR MCP                         │
   │  mcp/        transport · per-actor server factory · tool schemas  │
   │  auth/       actors · actor_tokens · capabilities · leases        │
   │  domain/     job state machine · transition table · decide.ts     │
   │  store/      one SQLite DB (WAL) · migrations · repositories      │
   │  workers/    adapter registry · process runtime (NDJSON)          │
   │  artifacts/  path jail · sha256 · metadata-only in DB             │
   │  audit/      append-only hash-chained log · redaction             │
   │                                                                   │
   │  STATE ROOT: <OS profile>\.agent-orchestrator-mcp\              │
   │    data\orchestrator.db · artifacts\ · secrets\ · logs\           │
   └───┬───────────────────────────┬──────────────────────┬───────────┘
       │ spawn + NDJSON            │ spawn + NDJSON       │ MCP ingress
   ┌───▼──────────────┐   ┌────────▼─────────────┐   ┌────▼─────────────┐
   │ GEMINI REVIEWER  │   │  BROWSER WORKER      │   │  FUTURE WORKERS  │
   │ agy (LATER)      │   │  EXTERNAL repo, Node │   │  shell · QA ·    │
   │ INTERPRETS       │   │  + CDP, NO MODEL     │   │  file · API      │
   │ trust=untrusted  │   │  trust=deterministic │   │                  │
   └───┬──────────────┘   └────────┬─────────────┘   └────┬─────────────┘
       └────────── evidence + artifacts (labelled) ────────┘
                               ▼
                    Codex reads labelled evidence
                    → APPROVE · FIX · RETEST · VERIFY_SELF
                      · IGNORE_FALSE_POSITIVE · STOP · REJECT
```

---

## 4. Codex Authority Model — exact enforcement mechanism

> **Revision 8 proposed amendment:** The persistent resolver, transport-marker,
> and internal-system rules in this section apply only after Phase 4 approval;
> the implemented Phase 3 runtime remains the Revision 7 behavior.

Five independent layers. Removing any one still leaves the invariant enforced.

**Layer 1 — Transport identity.** Every request carries a bearer token. `verifyAccessToken(token)` hashes it (SHA-256) and looks it up in **`actor_tokens`**, which is many-to-one onto `actors`. It returns a verified actor context; the SDK-facing `AuthInfo.scopes` carries the fixed `mcp` transport marker plus actor capabilities for wire compatibility, while application authorization uses the explicit actor capabilities only. Several Codex sessions may each hold their own token; all resolve to the **single** principal actor. Tokens are never stored in plaintext, never logged, never returned by any tool. On stdio the same lookup happens once at startup from `ORCHESTRATOR_ACTOR_TOKEN`. Unknown, expired, or disabled token → 401, audited as `auth.rejected`.

**Layer 2 — Tool visibility.** The SDK builds a fresh `McpServer` per request from a factory receiving `authInfo`. Tools the actor lacks capabilities for are **not registered** — `tools/list` for a worker does not contain `codex_decide` at all.

**Layer 3 — Handler capability check.** Every handler begins with `requireCapability(ctx, '<cap>')`. Defence in depth against a registration bug, and it covers the stdio path.

**Layer 4 — Domain choke point.** Exactly one function mutates `jobs.state` / `jobs.authoritative_status`:

```
applyTransition(tx, job, transition, actorCtx) -> Job
```

It consults a static `TRANSITIONS` table keyed by `(from_state, transition)`.
Each key yields one deterministic rule with an ordered guard selector: the
selector evaluates the guards in fixed order and yields exactly one outcome of
the form `{ to, grantsStatus?, requiredCapability, allowedRoles, guards[] }`.
The ordinary one-outcome form remains valid; a guarded rule may select between
already-reviewed outcomes without creating duplicate keys or allowing the
caller to choose the outcome. In particular, the Phase 5 cycle-limit
clarification selects the normal `FIX`/`RETEST` outcome while
`cycle + 1 <= max_cycles`, and selects the existing non-authoritative `STALLED`
outcome otherwise. Every transition that stamps an authoritative status
requires `job:decide` and `role='principal'`. The repository layer exposes no
raw state setter.

**Layer 5 — Database.** The DB does not trust the application. Two immutable reference tables plus four triggers make an unjustified authoritative write impossible even from a `sqlite3` shell:

```sql
-- Which decision verb grants which authoritative status. Immutable after migration.
CREATE TABLE decision_grants (
  decision             TEXT NOT NULL,
  authoritative_status TEXT NOT NULL,
  PRIMARY KEY (decision, authoritative_status)
);
INSERT INTO decision_grants (decision, authoritative_status) VALUES
  ('APPROVE',  'APPROVED'),
  ('DELIVER',  'READY_FOR_DELIVERY'),
  ('COMPLETE', 'JOB_COMPLETED'),
  ('REJECT',   'REJECTED'),
  ('CANCEL',   'JOB_CANCELLED');
-- FIX, RETEST, VERIFY_SELF, IGNORE_FALSE_POSITIVE, STOP, PACKAGE grant NOTHING.
-- They have no row here, so they can never satisfy the trigger below.

-- Ranks and terminality that trigger T3 reads. Immutable after migration (T6).
CREATE TABLE authoritative_statuses (
  authoritative_status TEXT PRIMARY KEY,
  rank                 INTEGER NOT NULL,
  terminal             INTEGER NOT NULL
);
INSERT INTO authoritative_statuses VALUES
  ('APPROVED', 10, 0), ('READY_FOR_DELIVERY', 20, 0),
  ('JOB_COMPLETED', 30, 1), ('REJECTED', 90, 1), ('JOB_CANCELLED', 91, 1);
```

Both reference tables are **security-relevant data that triggers read**, not ordinary configuration: `decision_grants` is the allowlist T2 consults, and `authoritative_statuses` supplies the `rank`/`terminal` values T3 consults. Mutating either at runtime would disarm a trigger without touching a single job row. Both are therefore frozen by triggers created **after** the seed inserts, in the same migration (T5, T6 below).

```sql
-- (T1) Only an enabled principal may author a decision.
CREATE TRIGGER trg_decisions_principal_only BEFORE INSERT ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions require an enabled principal actor')
  WHERE NOT EXISTS (
    SELECT 1 FROM actors a
    WHERE a.actor_id = NEW.actor_id AND a.role = 'principal' AND a.disabled = 0);
END;

-- (T2) An authoritative_status write must be SEMANTICALLY GRANTED by the
--      referenced decision, which must target this job, cycle, and state.
CREATE TRIGGER trg_auth_status_requires_granting_decision
BEFORE UPDATE OF authoritative_status ON jobs
WHEN NEW.authoritative_status IS NOT OLD.authoritative_status
BEGIN
  SELECT RAISE(ABORT, 'authoritative_status requires a granting principal decision')
  WHERE NEW.authoritative_status IS NULL              -- never cleared once set
     OR NEW.deciding_decision_id IS NULL
     OR NOT EXISTS (
        SELECT 1
        FROM decisions d
        JOIN actors           a ON a.actor_id = d.actor_id
        JOIN decision_grants  g ON g.decision = d.decision
        WHERE d.decision_id = NEW.deciding_decision_id
          AND d.job_id      = NEW.job_id
          AND d.cycle       = NEW.cycle
          AND d.to_state    = NEW.state          -- decision targeted THIS state
          AND a.role        = 'principal'
          AND a.disabled    = 0
          AND g.authoritative_status = NEW.authoritative_status);  -- SEMANTIC MATCH
END;

-- (T3) Milestones are monotonic and terminality is absolute.
CREATE TRIGGER trg_auth_status_monotonic
BEFORE UPDATE OF authoritative_status ON jobs
WHEN OLD.authoritative_status IS NOT NULL
 AND NEW.authoritative_status IS NOT OLD.authoritative_status
BEGIN
  SELECT RAISE(ABORT, 'authoritative_status is terminal or would regress')
  WHERE (SELECT terminal FROM authoritative_statuses
          WHERE authoritative_status = OLD.authoritative_status) = 1
     OR (SELECT rank FROM authoritative_statuses WHERE authoritative_status = NEW.authoritative_status)
        <= (SELECT rank FROM authoritative_statuses WHERE authoritative_status = OLD.authoritative_status);
END;

-- (T4) state and authoritative_status may not disagree.
CREATE TRIGGER trg_state_matches_auth_status BEFORE UPDATE OF state ON jobs
WHEN NEW.state IN ('APPROVED','READY_FOR_DELIVERY','JOB_COMPLETED','REJECTED','JOB_CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'authoritative state requires the matching authoritative_status')
  WHERE NEW.authoritative_status IS NOT NEW.state;
END;

-- (T5) The ledger is append-only, and the reference tables are frozen.
CREATE TRIGGER trg_decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT,'decisions are append-only'); END;
CREATE TRIGGER trg_decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT,'decisions are append-only'); END;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER trg_grants_frozen_i BEFORE INSERT ON decision_grants
BEGIN SELECT RAISE(ABORT,'decision_grants is immutable'); END;
CREATE TRIGGER trg_grants_frozen_u BEFORE UPDATE ON decision_grants
BEGIN SELECT RAISE(ABORT,'decision_grants is immutable'); END;
CREATE TRIGGER trg_grants_frozen_d BEFORE DELETE ON decision_grants
BEGIN SELECT RAISE(ABORT,'decision_grants is immutable'); END;

-- (T6) The rank/terminal reference data that T3 depends on is frozen too.
--      Without this, `UPDATE authoritative_statuses SET terminal = 0 ...`
--      would disarm T3 without touching any job row.
CREATE TRIGGER trg_auth_statuses_frozen_i BEFORE INSERT ON authoritative_statuses
BEGIN SELECT RAISE(ABORT,'authoritative_statuses is immutable'); END;
CREATE TRIGGER trg_auth_statuses_frozen_u BEFORE UPDATE ON authoritative_statuses
BEGIN SELECT RAISE(ABORT,'authoritative_statuses is immutable'); END;
CREATE TRIGGER trg_auth_statuses_frozen_d BEFORE DELETE ON authoritative_statuses
BEGIN SELECT RAISE(ABORT,'authoritative_statuses is immutable'); END;

-- T5 and T6 are created in the same migration AFTER the seed INSERTs above.
-- Consequence: changing the grant map or the rank/terminal map is a MIGRATION,
-- reviewed and versioned, never a runtime statement.
```

### T7 — durable, initially unstamped job rows

Migration `003_job_row_integrity_and_schema_verification.sql` adds these two
physical triggers after the T1–T6 schema exists:

```sql
CREATE TRIGGER trg_jobs_unstamped_on_insert
BEFORE INSERT ON jobs
WHEN NEW.authoritative_status IS NOT NULL
  OR NEW.deciding_decision_id IS NOT NULL
  OR NEW.state IN (
    'APPROVED',
    'READY_FOR_DELIVERY',
    'JOB_COMPLETED',
    'REJECTED',
    'JOB_CANCELLED'
  )
BEGIN
  SELECT RAISE(ABORT, 'jobs must begin without authoritative state');
END;

CREATE TRIGGER trg_jobs_no_delete
BEFORE DELETE ON jobs
BEGIN
  SELECT RAISE(ABORT, 'jobs are durable and cannot be deleted');
END;
```

T7 is deliberately independent of foreign-key enforcement. A runtime DELETE
is never permitted, and a new job cannot be created already authoritative. The
later authority domain may stamp an existing non-authoritative row only through
the reviewed decision/status transaction protected by T1–T4.

### T8 — durable-row replacement integrity

Migration `004_row_replacement_integrity.sql` adds INSERT-side identity guards:

```sql
CREATE TRIGGER trg_jobs_no_replace
BEFORE INSERT ON jobs
WHEN EXISTS (SELECT 1 FROM jobs WHERE job_id = NEW.job_id)
BEGIN
  SELECT RAISE(ABORT, 'jobs are durable and cannot be replaced');
END;

CREATE TRIGGER trg_decisions_no_replace
BEFORE INSERT ON decisions
WHEN EXISTS (SELECT 1 FROM decisions WHERE decision_id = NEW.decision_id)
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only and cannot be replaced');
END;

CREATE TRIGGER trg_audit_no_replace
BEFORE INSERT ON audit_log
WHEN NEW.seq IS NOT NULL
  AND EXISTS (SELECT 1 FROM audit_log WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only and cannot be replaced');
END;
```

T8 is the schema-resident protection against SQLite's `REPLACE` conflict
resolution. It does not rely on `foreign_keys` or `recursive_triggers`, and it
does not reject a genuinely new row. For `audit_log`, the normal AUTOINCREMENT
path omits `seq` and remains valid; the implementation tests SQLite's actual
`NEW.seq` behavior rather than assuming that an omitted value is already the
final sequence number.

What this blocks, at the SQL layer, with no application code involved:

| Attempt | Blocked by |
|---|---|
| Reference a principal `RETEST` decision while setting `APPROVED` | T2 — `RETEST` has no `decision_grants` row |
| Reference a valid `APPROVE` decision while setting `JOB_COMPLETED` | T2 — grant is `APPROVE→APPROVED`, not `JOB_COMPLETED` |
| Reference a decision from another job, cycle, or `to_state` | T2 — join predicates |
| Reference a decision authored by a worker or a disabled principal | T1 at insert, T2 at use |
| Set `state='APPROVED'` without stamping the status | T4 |
| Regress `JOB_COMPLETED` back to `APPROVED`, or move off a terminal status | T3 |
| Clear `authoritative_status` to NULL | T2 |
| Rewrite or delete a decision or an audit row | T5 |
| Add a new grant row to widen authority | T5 |
| `UPDATE authoritative_statuses SET terminal = 0 WHERE … = 'JOB_COMPLETED'` to reopen a terminal job | **T6** |
| Lower `APPROVED`'s rank (or raise a terminal status's) to permit regression | **T6** |
| Insert a new authoritative status, or delete an existing one, to bypass T3 | **T6** |
| Insert a job already carrying an authoritative status, deciding decision, or authoritative state | **T7** |
| Delete an unstamped or stamped job, including after disabling foreign keys on another connection | **T7** |
| Replace an existing `jobs`, `decisions`, or `audit_log` primary-key row with `INSERT OR REPLACE` or `REPLACE` | **T8** |

**The structural separation.** `worker_runs.worker_verdict ∈ {PASS, FAIL, INCONCLUSIVE, NONE}` is advisory metadata on a worker row. `jobs.authoritative_status ∈ {APPROVED, READY_FOR_DELIVERY, JOB_COMPLETED, REJECTED, JOB_CANCELLED}` is authoritative. **No function reads the first and writes the second** — asserted by a source-scanning test.

**Exactly one principal.** The unique partial index guarantees *at most* one. Startup adds the missing half: `serve` runs `SELECT count(*) FROM actors WHERE role='principal' AND disabled=0` and **refuses to serve unless the result is exactly 1**, exiting with an actionable message. Under the proposed Revision 8 hand-off, `init` is the only command that may run with zero principals; it creates the exact `codex` principal and internal `system` actor and issues the first token after the schema reaches the approved Phase 4 version. Disabling the principal is therefore a deliberate kill switch — the service will not serve without one, by design (fail-closed, not fail-open).

**What the `system` actor may do:** write audit rows, mark worker runs terminal, and move a job to `STALLED`. It has no token row in `actor_tokens`, and the proposed Revision 8 resolver and startup gate reject any system-linked token, so it is unreachable over any transport.

---

## 5. Worker Trust Model

Three trust classes, stamped on every evidence row and surfaced to Codex:

| Class | Source | How Codex should read it |
|---|---|---|
| `deterministic` | Mechanical workers: exit codes, HTTP statuses, DOM assertions, file hashes, test-runner output | High confidence, still not a decision |
| `untrusted` | Any natural-language or model-generated output (Gemini findings, summaries, UX opinions) | Opinion. May be wrong, may be adversarial |
| `principal` | Codex's own self-verification evidence | Codex's own observation |

Rules:

- **Fail-closed.** Absence of a parseable verdict is never `PASS`. Missing, malformed, truncated, or timed-out output yields `MALFORMED`/`TIMEOUT` with `worker_verdict = NONE`.
- **A `PASS` is a claim, not a fact.** Codex can reject a `PASS`; `IGNORE_FALSE_POSITIVE` exists to record rejecting a `FAIL`.
- **Prompt-injection containment.** Worker text is data: `trust='untrusted'`, bounded, returned inside a fixed envelope with an `origin` label. The orchestrator never interprets worker text as instructions — no worker output ever selects a tool, path, command, or transition.
- **Capability grants are per-dispatch, narrow, and expiring.** Default worker capability set is read-and-report only. Anything broader is granted in the dispatch request, bounded to that run, audited, and dies with the lease.
- **Workers never see other jobs.** A worker's `job:read` is row-scoped by its active lease.
- **Session identity does not confer authority.** A Codex session token proves *which* session acted; authority comes from the actor row it maps to. A forged or absent session hint changes nothing about what is permitted.

---

## 6. Proposed Job State Machine

### States

**Workflow states** (non-authoritative)

| State | Meaning |
|---|---|
| `CREATED` | Job accepted, not started |
| `IN_PROGRESS` | Codex is doing the work (also where a cycle begins after `FIX`/`RETEST`) |
| `QA_RUNNING` | QA dispatched; ≥1 worker run exists for this cycle |
| `EVIDENCE_READY` | All runs for this cycle are terminal; awaiting Codex's decision |
| `REPAIR` | Codex chose FIX; transient until `resume` |
| `PACKAGING` | Codex authorized packaging. **Requires `job:decide` to enter, but stamps no new milestone** — `authoritative_status` stays `APPROVED` |
| `STALLED` | Guard fired (timeout / max cycles / orphaned runs / crash recovery / `STOP`). Holding state; only Codex leaves it |

`QA_REQUESTED` **no longer exists as an observable state** (see §9 of the delta and the `qa_dispatch` transaction in §17). It was the only place where two lifecycle interpretations could disagree.

**Authoritative states** (require `job:decide` + `role='principal'` + a *granting* decision; `state` and `authoritative_status` are equal here)

`APPROVED` · `READY_FOR_DELIVERY` · `JOB_COMPLETED` (terminal) · `REJECTED` (terminal) · `JOB_CANCELLED` (terminal)

### Transitions

| From | Transition | To | Actor | Capability | Stamps status | Guards |
|---|---|---|---|---|---|---|
| `CREATED` | `start` | `IN_PROGRESS` | codex | `job:create` | — | — |
| `IN_PROGRESS` / `REPAIR` | `dispatch_qa` | `QA_RUNNING` | codex | `qa:request` | — | `cycle < max_cycles`; ≥1 run created **in the same transaction** |
| `QA_RUNNING` | `runs_settled` | `EVIDENCE_READY` | system | — | — | all runs for the cycle terminal |
| `IN_PROGRESS` / `QA_RUNNING` | `stall` | `STALLED` | system | — | — | timeout / orphan / stale / deadline |
| `EVIDENCE_READY` | `decide:FIX` | `REPAIR` | **codex** | `job:decide` | — | `cycle+1 ≤ max_cycles` |
| `REPAIR` | `resume` | `IN_PROGRESS` | codex | `job:create` | — | cycle was already incremented by the preceding `FIX`; resume preserves it and requires version CAS |
| `EVIDENCE_READY` | `decide:RETEST` | `IN_PROGRESS` | **codex** | `job:decide` | — | `cycle+1 ≤ max_cycles`; `state_reason='retest'`; a fresh `qa_dispatch` is required |
| `EVIDENCE_READY` | `decide:FIX` / `decide:RETEST` at cycle limit | `STALLED` | **codex** | `job:decide` | — | next cycle would exceed `max_cycles`; no cycle increment; `state_reason='max_cycles'`; explicit guard is audited |
| `EVIDENCE_READY` | `decide:VERIFY_SELF` | `IN_PROGRESS` | **codex** | `job:decide` | — | — |
| `EVIDENCE_READY` | `decide:IGNORE_FALSE_POSITIVE` | `EVIDENCE_READY` | **codex** | `job:decide` | — | records rationale; no state change |
| `EVIDENCE_READY` / `IN_PROGRESS` / `STALLED` | `decide:APPROVE` | `APPROVED` | **codex** | `job:decide` | **APPROVED** | granting decision written first |
| `APPROVED` | `decide:PACKAGE` | `PACKAGING` | **codex** | `job:decide` | — (stays APPROVED) | — |
| `PACKAGING` | `decide:DELIVER` | `READY_FOR_DELIVERY` | **codex** | `job:decide` | **READY_FOR_DELIVERY** | manifest artifact registered |
| `READY_FOR_DELIVERY` | `decide:COMPLETE` | `JOB_COMPLETED` | **codex** | `job:decide` | **JOB_COMPLETED** | terminal |
| `EVIDENCE_READY` / `IN_PROGRESS` / `STALLED` | `decide:REJECT` | `REJECTED` | **codex** | `job:decide` | **REJECTED** | terminal |
| any non-terminal | `decide:CANCEL` | `JOB_CANCELLED` | **codex** | `job:decide` | **JOB_CANCELLED** | terminal; kills live runs |
| any non-terminal | `decide:STOP` | `STALLED` | **codex** | `job:decide` | — | halts dispatch, keeps job open |

**Loop bounding.** A normal `FIX` or `RETEST` increments `cycle` exactly once
in the `codex_decide` transaction; `resume` preserves that value. When a
`FIX`/`RETEST` request at the cycle limit would exceed `max_cycles`, the same
authority choke point records a non-authoritative guard transition to
`STALLED(reason=max_cycles)` without incrementing the cycle or creating worker
rows. A later `dispatch_qa` at the limit is refused before worker/lease
creation. From `STALLED`, Codex may APPROVE, REJECT, CANCEL, or raise
`max_cycles` via a `job:decide`-gated amendment — audited, and capped at a
configured `hard_max_cycles` (default 10) it cannot exceed. The cycle-limit
guard is a proposed Phase 5 lifecycle clarification and is not implementation
authorization. The explicit Phase 5 authorization is recorded in
`docs/PHASE5_PLAN.md`; the dependency is active only on the implementation
branch until a later merge.

**`state_reason` vocabulary.** The field is diagnostic metadata and never an
authorization input. The current Phase 5 values are `start`, `resume`,
`max_cycles`, and the lowercase decision names `approve`, `reject`, `fix`,
`retest`, `verify_self`, `ignore_false_positive`, `stop`, `package`,
`deliver`, `complete`, and `cancel`. Later runtime phases may add documented
operational reasons such as `timeout`, `orphaned_runs`, `stale`, and `deadline`;
they may not reinterpret an existing value as authority.

**No worker appears in the Actor column anywhere.** Workers write `worker_runs`, `evidence`, and `artifacts`; they never call `applyTransition`.

---

## 7. MCP Transport Decision

*(unchanged)* **Primary: Streamable HTTP on `127.0.0.1`, bearer-authenticated. Secondary: stdio, same core.**

- Codex CLI supports both, and its HTTP config accepts `bearer_token_env_var`, so per-session tokens are natively supported without pasting secrets into `config.toml`.
- Multiple processes must reach one job store: several Codex sessions, workers reporting in, later a status CLI. stdio is one-client-per-process; HTTP is not.
- The 2026-07-28 revision removed protocol sessions, so a stateless endpoint is the natural shape — state lives in SQLite, not in the connection.
- stdio is retained: one file (`serveStdio(factory)`), a zero-config Inspector path, better debugging.

**Protocol era.** Keep SDK defaults — `serveStdio` → `legacy: 'serve'`, `createMcpHandler` → `legacy: 'stateless'` — so both the 2026-07-28 era and 2025-era `initialize` clients are served from one factory. Phase 1 records which era the installed Codex actually speaks; tightening to `legacy: 'reject'` is then a config flag.

**Hardening (V1):** loopback bind only; `localhostHostValidation()` + `localhostOriginValidation()` (bad Origin → 403); bearer required on every request including `tools/list`; 1 MiB body cap; per-token rate limit; `X-Accel-Buffering: no`; fixed configured port whose bind doubles as the single-instance guard.

**What MCP is not used for.** Worker execution. MCP is the **control plane**; NDJSON subprocess is the **execution plane**. An MCP ingress for workers that already speak MCP exists (`run_report` with a lease) but no worker is required to use it.

---

## 8. Proposed MCP Tool Surface

The baseline V1 surface below defines ten tools. Every authoritative act is one
tool (`codex_decide`) so there is exactly one authorization gate and one audit
shape. Request-and-dispatch is one tool because it is one atomic intent. A
separate Phase 5 planning amendment proposes two non-authoritative lifecycle
operations; if approved, the Phase 5 activated surface will contain those two
additional entries. They are not active in the current merged Phase 4 state.

Common: every mutating tool accepts `idempotency_key` and an optional `session_hint`. Every tool returns `{ ok, data | error: { code, message, details } }` and carries a server-generated `request_id`. Schemas are Zod v4; JSON Schema derived.

**1. `job_create`** — Open a job.
- Caller: codex · Capability: `job:create`
- In: `{ title, spec: {objective, acceptance_criteria[], context?}, workspace, max_cycles?, deadline_at?, idempotency_key?, session_hint? }`
- Out: `{ job_id, state: "CREATED", authoritative_status: null, cycle: 0, max_cycles }`
- Authorization: `workspace` must realpath-resolve inside a configured **workspace root** (§15); `max_cycles` clamped to `hard_max_cycles`.

**2. `job_get`** — Full picture of one job.
- Caller: codex, observer; worker **only for its leased job** · Capability: `job:read`
- In: `{ job_id, include?: ("evidence"|"runs"|"artifacts"|"decisions")[], cycle? }`
- Out: job record (`state`, `authoritative_status`, `cycle`, `version`, `workspace`) + requested collections. Evidence carries `trust` and `origin`; untrusted text is enveloped. Worker responses are filtered to that run's own contributions.

**3. `job_list`** — Find jobs **across all projects**.
- Caller: codex, observer · Capability: `job:read`
- In: `{ state?, authoritative_status?, workspace?, updated_since?, limit?, cursor? }` · Out: `{ jobs[], next_cursor? }`

### Phase 5 lifecycle amendment (implemented and merged)

The Phase 5 plan approved `job_start` and `job_resume` as explicit lifecycle
operations under `job:create`. Both require `expected_version`, use the common
idempotency envelope, and remain non-authoritative. `job_start` moves only
`CREATED → IN_PROGRESS`; `job_resume` moves only `REPAIR → IN_PROGRESS` and
does not increment `cycle`. These are permanent V1 lifecycle operations, not
temporary fixtures. The published Phase 5 implementation exposes `job_get` only
to verified Codex/observer callers; no worker caller or lease-scoped read path
is activated.

The published Phase 5 implementation also returns `version: 1` from
`job_create` so a caller
can use the required CAS contract. `stale_after_s` is server-owned and comes
from a bounded configured default rather than a request field. `job_get`
accepts `include: ["decisions"]` only; `runs`, `evidence`, and `artifacts` are
unconditionally deferred to their owner phases and return the reviewed
`UNSUPPORTED_COLLECTION` error. The original ten-tool list remains the full
later V1 target description; these staging rules govern Phase 5 only. The
required independent review and Codex authorization are recorded in
`docs/PHASE5_PLAN.md`; the additions are active in the published Phase 5
baseline.

**4. `qa_dispatch`** — Request QA and dispatch workers as one atomic act.
- Caller: codex · Capability: `qa:request`
- In: `{ job_id, cycle, expected_version, requests: [{ worker_id, task, params, timeout_ms?, artifacts_expected? }], idempotency_key?, session_hint? }`
- Out: `{ runs: [{ run_id, worker_id, status }], cycle, state: "QA_RUNNING", version }` — **leases are delivered to the worker process, never returned to Codex.**
- Authorization: job in `IN_PROGRESS`/`REPAIR`, `cycle` matches, `cycle < max_cycles`, version CAS holds. `worker_id` must exist in the configured registry — **Codex names a registered worker; it never supplies a command line.** Transaction semantics in §17.

**5. `run_report`** — A worker submits its result.
- Caller: worker · Capability: `work:report` **plus a valid unconsumed lease**
- In: `{ lease, verdict: "PASS"|"FAIL"|"INCONCLUSIVE", summary, findings[]?, evidence[]?, artifacts[]?, usage? }`
- Out: `{ run_id, status, accepted: true, duplicate: boolean }`
- Authorization: lease HMAC verified, unexpired, unconsumed, bound to `(job_id, cycle, run_id)`; consumed atomically with the write; replay returns the original response. **Writes nothing to `jobs.authoritative_status`, ever.**

**6. `run_status`** — Poll worker runs.
- Caller: codex (any job), worker (own run) · Capability: `job:read`
- In: `{ job_id, cycle?, run_id? }` · Out: `{ runs: [{ run_id, worker_id, status, worker_verdict, failure_class?, started_at, ended_at, attempt }] }`

**7. `evidence_add`** — Record an observation.
- Caller: codex (self-verification), worker (with lease) · Capability: `evidence:add`
- In: `{ job_id, cycle, kind, summary, detail?, artifact_id?, lease? }` · Out: `{ evidence_id, trust }`
- Notes: `trust` is derived from the caller's role — **never accepted from input.**

**8. `artifact_register`** — Record a produced file.
- Caller: codex, worker (with lease) · Capability: `artifact:register`
- In: `{ job_id, cycle, path, kind, mime?, label?, lease? }` · Out: `{ artifact_id, sha256, bytes, rel_path }`
- Authorization: path must resolve inside `<state_root>\artifacts\<job_id>\`; size cap; **sha256 computed by the orchestrator, never accepted from the worker.**

**9. `codex_decide`** — The only authoritative act in the system.
- Caller: codex **only** · Capability: `job:decide` (role `principal`)
- In: `{ job_id, cycle, decision: APPROVE|REJECT|FIX|RETEST|VERIFY_SELF|IGNORE_FALSE_POSITIVE|STOP|PACKAGE|DELIVER|COMPLETE|CANCEL, rationale, evidence_refs?: string[], expected_version, idempotency_key?, session_hint? }`
- Out: `{ decision_id, job_id, state, authoritative_status, cycle, version }`
- Authorization: capability + role + transition guard + CAS on `expected_version`. Writes the `decisions` row (carrying `session_token_id` and `request_id`) and the state/status change in one transaction; triggers T1–T4 independently verify the write. `rationale` is required.

**10. `audit_query`** — Read the history.
- Caller: codex, observer · Capability: `job:read`
- In: `{ job_id?, actor_id?, session_token_id?, action?, since?, limit?, cursor?, verify_chain? }`
- Out: `{ entries[], next_cursor?, chain_valid? }` — redacted; `verify_chain` recomputes the hash chain.

*Deferred:* `actor_admin` (CLI-only in V1), MCP resources exposing artifacts read-only, `job_amend`.

**Capability catalogue:** `job:create`, `job:read`, `job:decide`, `qa:request`, `work:report`, `evidence:add`, `artifact:register`. (`work:claim` and `job:cancel` removed — the former was unused, the latter is a `codex_decide` variant.)

---

## 9. Data Model / SQLite Schema Proposal

**One database for all projects:** `<OS profile>\.agent-orchestrator-mcp\data\orchestrator.db`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;      -- FULL available via config
PRAGMA recursive_triggers = ON;   -- AOM-owned connection defense in depth

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

-- Identity: one row per ACTOR (authority), many rows per actor in actor_tokens (sessions).
CREATE TABLE actors (
  actor_id          TEXT PRIMARY KEY,          -- 'codex', 'gemini-reviewer', 'browser-worker'
  role              TEXT NOT NULL CHECK (role IN ('principal','worker','observer','system')),
  display_name      TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  disabled          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_actors_single_principal ON actors(role) WHERE role = 'principal';
-- "At most one" is the index; "exactly one enabled" is the startup invariant (§4, §16).

CREATE TABLE actor_tokens (
  token_id     TEXT PRIMARY KEY,
  actor_id     TEXT NOT NULL REFERENCES actors(actor_id),
  token_sha256 TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,       -- e.g. 'codex-session-a', 'codex-laptop', 'browser-worker'
  disabled     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX ix_actor_tokens_actor ON actor_tokens(actor_id);
-- Several concurrent Codex sessions each hold their own token; all map to the ONE principal.

CREATE TABLE decision_grants ( ... );        -- see §4, immutable
CREATE TABLE authoritative_statuses ( ... ); -- see §4, immutable

CREATE TABLE jobs (
  job_id               TEXT PRIMARY KEY,
  workspace            TEXT NOT NULL,        -- validated against the config allowlist
  title                TEXT NOT NULL,
  spec_json            TEXT NOT NULL,
  state                TEXT NOT NULL,        -- workflow position
  state_reason         TEXT,
  authoritative_status TEXT REFERENCES authoritative_statuses(authoritative_status),
  deciding_decision_id TEXT REFERENCES decisions(decision_id),
  owner_actor_id       TEXT NOT NULL REFERENCES actors(actor_id),
  cycle                INTEGER NOT NULL DEFAULT 0,
  max_cycles           INTEGER NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,   -- optimistic CAS
  deadline_at          TEXT,
  stale_after_s        INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX ix_jobs_state_updated ON jobs(state, updated_at);
CREATE INDEX ix_jobs_workspace     ON jobs(workspace, updated_at);   -- cross-project queries
CREATE INDEX ix_jobs_auth_status   ON jobs(authoritative_status);

CREATE TABLE decisions (
  decision_id      TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(job_id),
  cycle            INTEGER NOT NULL,
  actor_id         TEXT NOT NULL REFERENCES actors(actor_id),      -- principal-only (T1)
  session_token_id TEXT REFERENCES actor_tokens(token_id),         -- WHICH Codex session
  request_id       TEXT NOT NULL,                                  -- server-generated
  session_hint     TEXT,                                           -- client-supplied, untrusted
  decision         TEXT NOT NULL,
  rationale        TEXT NOT NULL,
  evidence_refs    TEXT,
  from_state       TEXT NOT NULL,
  to_state         TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_decisions_job     ON decisions(job_id, cycle);
CREATE INDEX ix_decisions_session ON decisions(session_token_id);

CREATE TABLE worker_runs (
  run_id         TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(job_id),
  cycle          INTEGER NOT NULL,
  worker_id      TEXT NOT NULL,
  adapter        TEXT NOT NULL,
  request_json   TEXT NOT NULL,
  status         TEXT NOT NULL,   -- PENDING RUNNING SUCCEEDED FAILED TIMEOUT CANCELLED MALFORMED ORPHANED
  worker_verdict TEXT,            -- PASS FAIL INCONCLUSIVE NONE  *** ADVISORY ONLY ***
  failure_class  TEXT,            -- SPAWN_FAILED TRANSIENT AUTH_REQUIRED MALFORMED_OUTPUT TIMEOUT MODEL_ERROR
  exit_code      INTEGER, pid INTEGER,
  usage_json     TEXT, stderr_tail TEXT,          -- bounded, redacted
  attempt        INTEGER NOT NULL DEFAULT 1,
  started_at     TEXT, ended_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX ix_runs_job_cycle ON worker_runs(job_id, cycle, status);

CREATE TABLE evidence (
  evidence_id  TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(job_id),
  cycle        INTEGER NOT NULL,
  run_id       TEXT REFERENCES worker_runs(run_id),
  source_actor TEXT NOT NULL REFERENCES actors(actor_id),
  trust        TEXT NOT NULL CHECK (trust IN ('deterministic','untrusted','principal')),
  kind         TEXT NOT NULL, severity TEXT,
  summary      TEXT NOT NULL,     -- ≤ 2 KiB
  detail_json  TEXT,              -- ≤ 64 KiB; overflow -> artifact
  artifact_id  TEXT REFERENCES artifacts(artifact_id),
  created_at   TEXT NOT NULL
);
CREATE INDEX ix_evidence_job_cycle ON evidence(job_id, cycle);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(job_id),
  cycle       INTEGER NOT NULL,
  run_id      TEXT REFERENCES worker_runs(run_id),
  kind        TEXT NOT NULL, mime TEXT, label TEXT,
  rel_path    TEXT NOT NULL,       -- relative to <state_root>\artifacts; NO BLOBS IN SQLITE
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,       -- computed by the orchestrator
  created_by  TEXT NOT NULL REFERENCES actors(actor_id),
  created_at  TEXT NOT NULL,
  UNIQUE (job_id, rel_path)
);

CREATE TABLE leases (
  lease_id    TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL UNIQUE REFERENCES worker_runs(run_id),
  job_id      TEXT NOT NULL, cycle INTEGER NOT NULL,
  actor_id    TEXT NOT NULL REFERENCES actors(actor_id),
  nonce       TEXT NOT NULL, expires_at TEXT NOT NULL,
  consumed_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE idempotency (
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, key)
);

CREATE TABLE audit_log (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT NOT NULL,
  actor_id         TEXT NOT NULL, actor_role TEXT NOT NULL,
  session_token_id TEXT, request_id TEXT NOT NULL, session_hint TEXT,
  action           TEXT NOT NULL,
  job_id           TEXT, cycle INTEGER, capability TEXT,
  subject_type     TEXT, subject_id TEXT,
  from_state       TEXT, to_state TEXT,
  from_auth_status TEXT, to_auth_status TEXT,
  result           TEXT NOT NULL,     -- ok | denied | error
  detail_json      TEXT,              -- redacted, bounded
  prev_hash        TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX ix_audit_job     ON audit_log(job_id, seq);
CREATE INDEX ix_audit_session ON audit_log(session_token_id, seq);
```

Plus triggers T1–T8 from §4. The Phase 3 baseline migration set was exactly
`[1, 2, 3, 4]`. Revision 8 extends the approved runtime migration set to
`[1, 2, 3, 4, 5, 6]`, with version-keyed canonical definitions for v4, v5, and
v6. Migrations are applied in a runner-owned transaction at startup; the
service refuses to start if the DB is newer than the binary or any canonical
table/index/trigger definition differs from the approved version.

---

## 10. Worker Adapter Architecture

*(unchanged)*

```ts
interface WorkerAdapter {
  readonly id: string;                                    // 'process'
  describe(): AdapterInfo;
  plan(req: DispatchRequest, cfg: WorkerConfig): ExecPlan; // pure — fully unit-testable
}

interface ExecPlan {
  argv: string[];                    // argv array, never a shell string
  cwd: string;                       // absolute, inside an allowed root
  env: Record<string,string>;        // allowlist, not inherited
  stdin?: string;                    // parameters go here, not on the command line
  timeoutMs: number;
  parse: 'ndjson';
}
```

Adapters are **pure planners**; one shared `ProcessRuntime` owns spawn, streams, timers, cancellation, and normalization — every failure mode in one place.

**`ProcessRuntime`:** spawn with argv array; write stdin then close; parse stdout line-by-line as NDJSON with a Zod discriminated union; bound line length and total lines; bounded redacted stderr ring buffer; timeout → `taskkill /T` (win32) or process-group kill, grace period, force kill; cancellation token; exit code + stream state → `failure_class`; emit exactly one normalized `WorkerReport`.

**NDJSON contract (stdout):**

```
{"type":"ready","worker":"...","version":"..."}
{"type":"progress","pct":40,"message":"..."}
{"type":"evidence","kind":"assertion","severity":"error","summary":"...","detail":{...}}
{"type":"artifact","path":"...","kind":"screenshot","mime":"image/png","label":"..."}
{"type":"result","verdict":"FAIL","summary":"...","usage":{...}}
{"type":"error","class":"AUTH_REQUIRED","message":"..."}
```

Unknown `type` values are ignored. Malformed lines increment a counter and become bounded `parse_error` evidence — a noisy worker degrades a run, never the orchestrator. No `result` line → `MALFORMED`, verdict `NONE`.

**Two ingress paths, one persistence function.** Push (orchestrator spawns) and pull (worker calls `run_report` with its lease) both normalize to `WorkerReport` and go through `recordWorkerReport(tx, …)`.

**Registry.** Workers are declared in config (id, adapter, argv template, env allowlist, cwd, default timeout, trust class, granted capabilities). Codex dispatches by `worker_id`; it never supplies a command line. This is the boundary that keeps `qa_dispatch` from being arbitrary code execution.

---

## 11. Gemini / `agy` Adapter Design *(design only — deferred, not in V1)*

**⚠ Assumptions to re-verify empirically before implementing this phase.** `agy --help` (v1.1.22, read on this machine) documents `-p/--print`, `--output-format text|json|stream-json`, `--json-schema <schema string or path>`, `--print-timeout` (default 5m), `--model`, `--effort low|medium|high`, `--add-dir`, `--conversation`, `--sandbox`, `--disable-slash-commands`, and `--input-format text|stream-json` (which "reads one NDJSON message per line from stdin and requires `--output-format stream-json`"). It does **not** document plain-text prompt delivery on stdin with `-p`. So the exact prompt-delivery mechanism — argv vs. stdin text vs. `--input-format stream-json` NDJSON — **must be verified against the installed binary at the start of that phase**, not assumed here. The rest of this section is design intent conditional on that verification.

**Invocation intent.** `agy.exe -p --output-format stream-json --json-schema <path> --print-timeout <t> --model <m> --effort <e> --add-dir <read-only root> --disable-slash-commands --sandbox`, with the prompt delivered off the command line (mechanism per the verification above) to avoid Windows argv length limits and all quoting/injection concerns. `--dangerously-skip-permissions` is never used by default and requires an explicit per-worker config opt-in that is recorded in the audit log.

**Structured output is mandatory.** `--json-schema` pins the final result to a fixed reviewer schema (`{verdict, summary, findings[{severity, location, claim, confidence}], caveats[]}`). Pretty terminal text is never parsed. Only the final schema-validated result yields a `worker_verdict`.

**Failure taxonomy:**

| Symptom | `failure_class` | Retry? |
|---|---|---|
| Binary missing / spawn error | `SPAWN_FAILED` | yes (2, backoff) |
| Non-zero exit with transient network signature | `TRANSIENT` | yes (2, backoff) |
| Auth/session expired | `AUTH_REQUIRED` | **no** — surfaced to Codex; retrying cannot help |
| Stream ended without a valid final result | `MALFORMED_OUTPUT` | no |
| Wall-clock exceeded | `TIMEOUT` | no |
| Model/service error event in stream | `MODEL_ERROR` | yes (1) |

Each retry is **its own `worker_runs` row** (`attempt` incremented) — partial evidence is never silently overwritten.

**Other:** `--print-timeout` set below the orchestrator's own timeout so the CLI self-terminates first; usage metadata into `worker_runs.usage_json`; `--conversation` deliberately unused so every run is stateless and reproducible; `--add-dir` scoped to a read-only path inside the job's workspace; all Gemini evidence stamped `trust='untrusted'`.

---

## 12. Browser Worker Design *(design only — EXTERNAL to this repo)*

**Decision: the existing Node/CDP worker stays external for the first integration.** It will be registered as an ordinary entry in the worker registry (`adapter: 'process'`, an argv template pointing at its own installed location) and must satisfy the same NDJSON contract as any other worker. **No CDP dependency enters the V1 core**, and this is not blocking V1.

**No model in the loop.** The worker executes a declarative, schema-validated step script:

```jsonc
{ "steps": [
  { "op": "navigate", "url": "https://..." },
  { "op": "wait_for", "selector": "#app", "timeout_ms": 5000 },
  { "op": "set_viewport", "width": 1280, "height": 800 },
  { "op": "read_dom", "selector": ".price", "as": "prices" },
  { "op": "collect_console" },
  { "op": "screenshot", "label": "checkout" },
  { "op": "assert", "expr": { "kind": "count_gte", "of": "prices", "n": 1 } }
]}
```

**No arbitrary JS evaluation from job input.** URL allowlist per worker config, so a poisoned job spec cannot drive the browser to an arbitrary host. Never enters credentials, never clicks irreversible controls.

**Outputs:** screenshots and structured captures as artifacts; assertion outcomes as `trust='deterministic'` evidence; the step script and its sha256 recorded as evidence so a RETEST is provably the same test.

**Division of labour:** the browser worker produces pixels and facts; Gemini interprets them; Codex decides. Tokens are never spent on navigation.

---

## 13. Artifact & Evidence Model

**Layout:** `<OS profile>\.agent-orchestrator-mcp\artifacts\<job_id>\<cycle>\<run_id>\<name>` — one global artifact root, isolated per job/cycle/run, **separate from workspace access**. A worker may read its workspace (per the allowlist) but may only write artifacts here.

**DB stores metadata only** — id, job, cycle, run, kind, mime, label, rel_path, bytes, sha256, creator, timestamp. No blobs in SQLite: they would bloat the WAL, slow every backup, and buy nothing when every consumer reads files by path.

**Path safety** (Windows-specific, enforced at register time): resolve to a realpath and require containment in the artifact root after normalization; reject symlinks and NTFS reparse points; reject `..`, absolute inputs, alternate data streams (`:`), reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), trailing dots/spaces; case-insensitive containment comparison; bounded name/path length; per-artifact and per-job size caps.

**Integrity:** sha256 computed by the orchestrator at register time, never accepted from the worker. A `PACKAGE` decision emits a `manifest` artifact — every artifact id, path, sha256, and the decision chain — which is what makes a handoff verifiable.

**Evidence sizing:** `summary` ≤ 2 KiB, `detail_json` ≤ 64 KiB; anything larger becomes an artifact. Raw model transcripts are not persisted; bounded summaries plus artifact pointers answer "why", which is the actual requirement.

**Retention:** nothing is deleted on completion or cancellation. Because one global root now accumulates artifacts from every project, a `prune` CLI (LATER) removes artifacts for terminal jobs older than N days and marks rows `pruned` rather than deleting metadata. V1 records `bytes` per artifact so total footprint is queryable from day one.

---

## 14. Audit Model

> **Revision 8 proposed amendment:** The Phase 4 audit actions, hash
> construction, and rejected-auth bound in this section are planning text only;
> the Phase 3 audit schema remains the approved Revision 7 baseline.

Every entry answers **who / which session / what / when / which job / what result**: `actor_id`, `actor_role`, `session_token_id`, `request_id`, `session_hint`, `action`, `job_id`, `cycle`, `capability`, `subject_type`+`subject_id`, `from_state`/`to_state`, `from_auth_status`/`to_auth_status`, `result`, redacted `detail_json`, `ts`.

**Audited actions:** `bootstrap.completed`, `token.issued`, `token.revoked`, `auth.rejected`, `job.create`, `job.start`, `job.resume`, `qa.dispatch`, `run.start`, `run.report`, `run.duplicate_rejected`, `run.timeout`, `run.orphaned`, `evidence.add`, `artifact.register`, `codex.decide`, `system.stall`, `lease.issued`, `lease.consumed`, `lease.rejected`, `config.reload`, `startup.invariant_failed`.

For Phase 4, an `auth.rejected` row uses the internal `system` attribution
with null session fields and no credential material. Rejected-auth writes are
rate-limited or aggregated under a configured bounded cap so unknown clients
cannot grow the append-only ledger without limit.
This is a Phase 4 audit-writer-internal in-memory bound, separate from the
Phase 9 transport rate limiter; it resets on process restart and requires no
new durable table. Phase 9 retains ownership of network/request rate limiting.

**Session attribution.** `session_token_id` is **verified** — it is the token row the request authenticated with, not a self-declared value — so "which Codex session made this decision?" is answered by joining `decisions.session_token_id → actor_tokens.label`. `session_hint` is an optional client-supplied string recorded alongside it and always treated as untrusted labelling. Neither field confers or restricts authority; both are attribution only, preserving the single-principal invariant.

**Tamper evidence:** `hash = sha256(canonical_json(row_without_hash))`, where
`prev_hash` is included once as the final canonical key, chained by `seq`.
`audit_query { verify_chain: true }` recomputes and reports the first break.
Append-only is enforced by trigger T5 and T8 as well as by the absence of any
update/delete/replace statement in the codebase (source-scanning test).

**"Why did Codex approve this job?"** — one query: the `decisions` rows for the job (each with mandatory `rationale`, `evidence_refs`, and session attribution), joined to the evidence they cite and the worker runs that produced it, in audit order. No transcripts required.

**Redaction:** a single `redact()` runs on everything before it reaches the log, the DB, or stderr — bearer tokens, `Authorization` values, lease HMACs, configured secret-name patterns, and any value from a non-allowlisted env var.

---

## 15. Security Threat Model

| # | Threat | Mitigation |
|---|---|---|
| 1 | **Worker promotes its own verdict to APPROVED** | Five layers (§4): capability gate, tool non-registration, handler check, single domain choke point, and DB triggers T1–T4 that require a *semantically granting* principal decision |
| 2 | **A non-granting decision is reused as justification** | `decision_grants` is an immutable allowlist; `RETEST`/`FIX`/`VERIFY_SELF`/`IGNORE_FALSE_POSITIVE`/`STOP`/`PACKAGE` have no grant row and can never satisfy T2 |
| 2b | **Disarming a trigger by mutating the reference data it reads** — e.g. `UPDATE authoritative_statuses SET terminal = 0 WHERE authoritative_status='JOB_COMPLETED'` to reopen a completed job, or re-ranking statuses to permit regression, without touching a single job row | **T6** freezes `authoritative_statuses` against INSERT/UPDATE/DELETE, as **T5** does for `decision_grants`. Both trigger sets are created *after* the seed inserts in the same migration, so the seed succeeds once and the tables are read-only for the life of the database. Changing either map is a reviewed, versioned migration — never a runtime statement |
| 2c | **Pre-authoritative, deleted, or replaced job ledger root** — a direct SQL client inserts an already-stamped/authoritative job, deletes and reinserts a terminal job, or uses `REPLACE` with foreign keys and recursive triggers disabled | **T7** requires NULL `authoritative_status`/`deciding_decision_id` and a non-authoritative initial state and rejects every job DELETE. **T8** rejects an existing `job_id` on the INSERT side. These physical guards remain active across connections regardless of connection-scoped `foreign_keys` or `recursive_triggers`; job/status/decision history remains durable |
| 2d | **Same-name schema weakening** — an attacker drops and recreates a trigger, index, or table with the expected name but weaker SQL | Init/serve compare canonical normalized-SQL fingerprints for all approved tables, security-sensitive indexes, and physical T1–T8 triggers before service. A mismatch fails closed before HTTP bind or stdio output |
| 3 | **Forged Codex identity** | Per-token SHA-256 with constant-time compare; `role='principal'` is a unique partial index; a second principal cannot exist, and a *session* token grants no more than its actor |
| 4 | **Replayed / duplicated worker result** | Single-use lease consumed in the same transaction as the write; `(actor_id, key)` idempotency returns the original response |
| 5 | **Stale authorization** | Leases carry `expires_at` and bind `(job_id, cycle, run_id)`; a report for cycle N is refused once the job is at N+1. `actor_tokens.expires_at` bounds session tokens |
| 6 | **Privilege escalation via config** | Capability sets validated against a fixed catalogue at load; unknown capability → refuse to start; worker roles cannot be granted `job:decide` |
| 7 | **DNS rebinding / remote access** | Bind `127.0.0.1` only; Host/Origin validation (403); bearer required on every request |
| 8 | **Arbitrary command execution via job input** | Codex dispatches a registered `worker_id`; argv comes from server-side config templates; `spawn` with argv arrays, never `shell: true` |
| 9 | **Workspace escape** | `job_create` validates `workspace` by realpath containment in the config allowlist (`C:\AgentProjects`, `C:\SallaProjects`), case-insensitive; UNC paths, device paths (`\\?\`), and the root itself rejected. **`C:\` is never allowed** |
| 10 | **Artifact path traversal** | Realpath containment in the global artifact root, symlink/reparse rejection, reserved-name and ADS rejection, size caps (§13) |
| 11 | **Prompt injection from worker output** | Worker text is data: `trust='untrusted'`, bounded, enveloped, never interpreted; never selects a tool/path/command/transition |
| 12 | **Malicious worker floods the store** | Per-run caps on evidence count, artifact count, total bytes, NDJSON lines and line length; per-token rate limits; 1 MiB request cap |
| 13 | **Secret leakage into logs/DB/evidence** | Central `redact()` on every sink; per-worker env allowlist (workers do **not** inherit the parent environment, including `NODE_OPTIONS`, proxy vars, and `*_TOKEN`/`*_KEY`); bounded redacted stderr tail |
| 14 | **Secret file readable by other local accounts** | **Windows security model, §15.1** — not `chmod` |
| 15 | **Audit tampering** | Hash chain + verification query + trigger T5 + no update/delete path in code |
| 16 | **Infinite repair loops** | `max_cycles` guard, `hard_max_cycles` ceiling Codex cannot exceed, per-run timeouts, per-job deadline, bounded retries |
| 17 | **Concurrent Codex sessions corrupting a job** | `version` CAS on every mutating tool; loser gets `STATE_CONFLICT` with the current job |
| 18 | **DoS by another local process** | Port-bind single-instance guard, rate limits, body caps, bounded concurrency |

### 15.1 Windows secret protection (replaces "chmod 0600")

**`fs.chmod` is effectively a no-op on Windows** — it maps only to the read-only attribute and grants no access control whatsoever. POSIX `0600`/`0700` remains the POSIX implementation; it is **not** the Windows mechanism.

**What actually needs to persist.** The orchestrator stores only `token_sha256`, so it **never needs a plaintext bearer token at rest**. The only genuine at-rest secret it must read is the **lease HMAC key**. Bearer tokens are therefore **print-once**: `token issue` writes the value to stdout for the operator to place in the environment variable Codex reads, and does not persist a plaintext copy unless `--write-file` is passed.

**Windows mechanism (V1).** For `<OS profile>\.agent-orchestrator-mcp\secrets\` and every file in it:

1. Resolve the **current user's SID** (`whoami /user /fo csv /nh`, or the identity API) — SIDs avoid locale and domain-name pitfalls.
2. Create the directory, then apply a DACL with inheritance **stripped** and exactly one ACE:
   `icacls "<dir>" /inheritance:r /grant:r "*<SID>":(OI)(CI)F` — invoked via `spawnSync` with an **argv array**, never a shell string, on a path the orchestrator itself computed.
3. Apply the same to each secret file (`/inheritance:r /grant:r "*<SID>":F`).
4. **Verify after creation**: read the ACL back and assert the ACE set contains *only* the current user's SID. Reject if `Everyone`, `BUILTIN\Users`, `Authenticated Users`, `INTERACTIVE`, or any inherited ACE is present.
5. **Fail closed**: if `icacls` is missing, returns non-zero, or verification does not match, the orchestrator **refuses to write the secret and exits** with an actionable message. It never falls back to an unprotected file.
6. Re-verify the ACL on **every startup**, not just at creation — an operator or an installer can loosen it later. A failed check refuses service.
7. Refuse a state root under a known cloud-sync path (OneDrive/Dropbox). The user-profile root is not sync-redirected by default, unlike `Documents`; the check catches redirected setups, and runs again on the resolved real path once the root exists.

The same verification is applied to `data\orchestrator.db` — the database contains no plaintext secrets, but it contains the decision ledger, and a world-readable ledger is its own problem.

**DPAPI — evaluated, deferred, with rationale.** Windows DPAPI (`CryptProtectData`, user scope) would encrypt the lease HMAC key at rest. Assessment:

- **What it does not defend against:** the primary local threat. DPAPI user-scope keys are unwrapped automatically for *any* process running as that user — precisely the attacker we care about. Against a same-user attacker, DPAPI adds no barrier over an ACL.
- **What it does defend against:** offline copy — a backup, a disk image, a sync folder, or a copied profile.
- **Cost:** Node has no built-in DPAPI binding. Options are a native addon (adds a compiled dependency and a Windows-only build path to a project that is otherwise prebuild-only) or shelling to PowerShell `ProtectedData` per read (slow and adds a shell surface).
- **Mitigating factor:** the lease HMAC key is **regenerable**. Rotating it invalidates in-flight leases only — an acceptable, recoverable event. It is not a long-lived credential whose disclosure is catastrophic.

**V1 decision: ACL hardening with fail-closed verification, plus print-once tokens. DPAPI is listed under SHOULD HAVE LATER**, to be adopted when a native dependency is otherwise justified or if the state root ever has to live somewhere backed up off-machine. The rationale is that DPAPI's marginal benefit here is offline-theft resistance for a regenerable key, which does not justify a compiled dependency in V1.

---

## 16. Failure & Recovery Strategy

> **Revision 8 proposed amendment:** The system-actor startup checks and
> bootstrap details below are Phase 4 design intent; they are not part of the
> implemented Phase 3 runtime.

**Init and serve own SQL integrity.** `init` may securely create the
database, apply migrations, and run every required SQLite integrity/schema check
before it returns. `serve` opens an existing database only, performs
the same deep checks at startup, and fails before serving a request if any
required check fails. `doctor` performs no SQLite open or SQL integrity
check; it owns only the filesystem/security diagnosis described in Revision 6
while retaining the Revision 5 no-direct-SQL boundary.

On a fresh-init migration failure, SQLite is closed before cleanup. Only the
DB/WAL/SHM paths created by that fresh attempt are removed; cleanup errors are
reported as secondary detail and never replace the original initialization
failure. A normal retry starts from the known failed-init artifact boundary.

**Serve startup invariants**, checked before serving a single request; any failure exits non-zero with an actionable message and an `startup.invariant_failed` audit row when a valid database/system actor can record it; otherwise the failure is bounded stderr only:

1. State root exists and its ACL verifies (§15.1).
2. Migrations applied; `PRAGMA quick_check` clean; DB not newer than the binary;
   AOM-owned connections report `recursive_triggers=ON`.
3. **Exactly one enabled principal actor exists, with the exact internal `system` actor and no system-linked token.** Zero → "run `init`"; more than one is impossible by index, but the check reports it rather than assuming.
4. Every configured worker's capability set is in the catalogue; every configured workspace root exists and is not a drive root.
5. The protected Phase 5 `config.json` exists, parses against its schema, and
   supplies the workspace roots and bounded lifecycle defaults before either
   transport is exposed.
6. Lease HMAC key present and readable, or generated and hardened on first run.

**Bootstrap.** Under the proposed Revision 8 hand-off, `init` is the only command permitted to run with zero principals. It creates the state root, hardens `secrets\`, applies and verifies the approved migrations, creates the exact `codex` principal and internal `system` actor, issues its first token (printed once), and exits. `serve` never bootstraps.

**Crash recovery at boot.** `worker_runs` in `PENDING`/`RUNNING` are marked `ORPHANED` with an audit entry; a job in `QA_RUNNING` with no live runs → `STALLED(reason=orphaned_runs)`. **Recovery never approves and never fails a job.**

**Reaper loop** (single timer): run timeout → kill + `TIMEOUT`; lease expiry → expired; `updated_at` older than `stale_after_s` → `STALLED(stale)`; past `deadline_at` → `STALLED(deadline)`. All under `system`, all audited, none authoritative.

**Worker failure classes** map to run status only. A job never changes authoritative status because a worker failed; it lands in `EVIDENCE_READY` (with failure evidence) or `STALLED`.

**Poison runs:** after the retry budget, `FAILED` with `failure_class` preserved and every attempt visible as its own row.

**Partial output:** evidence and artifacts emitted before a crash are kept and marked incomplete. No `result` line → `MALFORMED`, verdict `NONE`, never `PASS`.

**Durability:** WAL + `synchronous=NORMAL` survives process crash (`FULL` via config). Every state change is one `IMMEDIATE` transaction — no half-transitioned job exists.

**Graceful shutdown (Revision 11):** stop accepting new dispatches, request
bounded worker termination, retain a valid normal result completed during the
drain, and reconcile unresolved runtime work as `ORPHANED`; shutdown itself is
never an authoritative `CANCEL`. The explicit Codex `CANCEL` path remains the
only source of `JOB_CANCELLED`.

---

## 17. Concurrency / Locking / Idempotency

**Single-writer service.** One orchestrator process owns the DB; the port bind is the single-instance guard. Multiple Codex sessions are multiple *clients*, not multiple writers.

**Transactions.** Every mutation is a `BEGIN IMMEDIATE` transaction. `better-sqlite3` is synchronous, so a transaction cannot interleave with another request's statements — atomicity is structural.

**The `qa_dispatch` transaction — one atomic act, stated explicitly:**

```
BEGIN IMMEDIATE
  load job FOR UPDATE semantics (IMMEDIATE holds the write lock)
  assert job.state ∈ {IN_PROGRESS, REPAIR}
  assert job.cycle == request.cycle
  assert job.version == request.expected_version         -- CAS
  assert job.cycle  <  job.max_cycles
  for each request:  INSERT worker_runs (status='PENDING')
  for each run:      INSERT leases (single-use, bound to job/cycle/run, expiring)
  applyTransition(dispatch_qa) → state='QA_RUNNING', version += 1
  INSERT audit rows (qa.dispatch, lease.issued × n)
COMMIT
-- processes are spawned AFTER commit, outside the transaction
```

Either the runs, the leases, and `QA_RUNNING` all exist, or none of them do. There is no observable intermediate "requested but not dispatched" state, and therefore no second lifecycle interpretation. If spawning fails after commit, the run is marked `SPAWN_FAILED` by the runtime — the job stays `QA_RUNNING` until `runs_settled` fires, exactly as for any other failure.

`RETEST` deliberately does **not** auto-dispatch: it returns the job to `IN_PROGRESS` at `cycle+1` with `state_reason='retest'`, and Codex must issue a fresh `qa_dispatch`. Implicit re-dispatch would hide which worker set actually ran in the new cycle.

**Optimistic concurrency across Codex sessions.** `jobs.version` increments on every state change; `codex_decide` and `qa_dispatch` require `expected_version` and fail with `STATE_CONFLICT` (returning the current job) if it moved. Two concurrent sessions cannot both decide the same cycle; the loser re-reads and retries. The accepted winning action records its verified session identity; a failed CAS is intentionally not an accepted mutation and writes no decision, state, cycle, audit, or idempotency row.

**Idempotency.** Optional `idempotency_key` on every mutating tool → unique `(actor_id, key)`. Same key + same request hash returns the stored response; different hash → `IDEMPOTENCY_CONFLICT`. Note the key is scoped to the *actor*, so two Codex sessions sharing the principal share a key namespace — keys must be UUIDs, which the schema enforces by format.

**Duplicate worker results.** Lease consumption is `UPDATE … WHERE consumed_at IS NULL` inside the write transaction. Zero rows updated → replay → return the original response with `duplicate: true`. A duplicate can never double-count evidence or re-trigger a transition.

**Concurrency limits.** Global and per-worker caps on simultaneous runs with a small FIFO queue. `runs_settled` is evaluated inside the transaction that settles the last run, so it cannot fire twice.

---

## 18. Proposed Repository Structure & Runtime Paths

### Runtime state root (not in the repository)

```
<OS profile>\.agent-orchestrator-mcp\
├── config.json                   # protected Phase 5 runtime configuration
├── data\
│   └── orchestrator.db            # ONE database for all projects
├── artifacts\
│   └── <job_id>\<cycle>\<run_id>\ # isolated per job/cycle/run
├── secrets\                       # inheritance stripped, current-user SID only, verified
│   └── lease.key
└── logs\
    └── orchestrator-YYYYMMDD.log  # rotated service stderr
```

POSIX equivalent: `$XDG_STATE_HOME/agent-orchestrator-mcp` (default `~/.local/state/agent-orchestrator-mcp`), directories `0700`, files `0600`.

### Repository

```
agent-orchestrator-mcp/
├── package.json  tsconfig.json  vitest.config.ts  .editorconfig
├── README.md  LICENSE
├── SECURITY.md                     # threat model, Windows ACL model, bootstrap
├── config/
│   └── orchestrator.example.jsonc     # actors, workers, workspace_roots, port, limits
├── docs/
│   ├── ARCHITECTURE.md                # this report, maintained
│   └── WORKER_PROTOCOL.md             # the NDJSON contract
└── src/
│   ├── index.ts                       # CLI: serve --http|--stdio, init, token, migrate, doctor
│   ├── config/                        # zod-validated config, state root resolution, workspace roots
│   ├── mcp/
│   │   ├── server.ts                  # buildServer(authInfo) — per-actor factory
│   │   ├── http.ts   stdio.ts         # entry points + localhost guards + bearer gate
│   │   └── tools/                     # one file per tool: schema + thin handler
│   ├── auth/
│   │   ├── actors.ts  actorTokens.ts  capabilities.ts  leases.ts
│   │   └── secrets/  paths.ts  acl.win.ts  acl.posix.ts  verify.ts
│   ├── domain/
│   │   ├── states.ts  transitions.ts  # the state machine, as data
│   │   ├── decide.ts                  # THE ONLY writer of authoritative_status
│   │   ├── jobs.ts  cycles.ts  errors.ts
│   ├── store/
│   │   ├── db.ts  integrity.ts  schemaDefinitions.ts  repositories.ts
│   │   └── migrations/*.sql
│   ├── workers/
│   │   ├── registry.ts  adapter.ts  runtime.ts  ndjson.ts  report.ts
│   │   └── adapters/process.ts
│   ├── artifacts/  store.ts  paths.ts  hash.ts
│   ├── audit/      log.ts  redact.ts
│   └── util/       ids.ts  clock.ts  json.ts  result.ts
└── test/
    ├── fixtures/workers/              # echo, slow, crashing, malformed, chatty, secret-echoing
    ├── unit/  contract/  authz/  state/  sql/  workers/  store/  mcp/  integration/
```

`src/workers/adapters/agy.ts` and any browser adapter are **not created in V1**. Adding them must not require touching `domain/` or `store/` — that is the test of whether this structure is right.

---

## 19. Testing Strategy

Vitest, coverage, CI-ready. A fake clock and injectable ids make everything deterministic. A `sql/` test layer connects to a throwaway DB and issues **raw SQL that bypasses the application entirely** — this is how the DB-level authority claims are proven rather than asserted.

**Layers:** unit · contract/schema (JSON Schema snapshots) · authorization · state machine (property-based) · **raw-SQL bypass** · worker adapter · subprocess failure · store/migrations/crash · Windows ACL · MCP protocol (in-memory client, plus stdio smoke and an Inspector run) · integration.

### Critical invariants — each an explicit named test

**Authority (application layer)**

1. **Gemini cannot mark a job authoritative.** A worker-role actor calling `codex_decide` gets `AUTHORIZATION_DENIED`, and the tool is absent from its `tools/list`.
2. **A worker cannot impersonate Codex.** A worker token with a forged `actor_id` or `session_hint` in arguments is ignored; identity comes only from the verified token.
3. **`worker_verdict: PASS` never changes `authoritative_status`.** After a PASS report, `authoritative_status` is NULL and `state` is `EVIDENCE_READY`.
4. **Codex can reject a PASS**, recorded with rationale and cited evidence.
5. **Codex can approve over a FAIL** via `IGNORE_FALSE_POSITIVE` + `APPROVE`, both in the audit chain.
6. **`authoritative_status` has exactly one writer** — source-scanning test: no assignment outside `domain/decide.ts`.

**Authority (raw SQL bypass — the DB must refuse on its own)**

7. **A principal `RETEST` decision referenced while setting `APPROVED` is ABORTed** (T2, no grant row).
8. **A valid `APPROVE` decision referenced while setting `JOB_COMPLETED` is ABORTed** (T2, grant mismatch).
9. **A decision belonging to another job, another cycle, or another `to_state` is ABORTed** (T2, join predicates).
10. **A decision authored by a worker actor cannot be inserted** (T1), and a decision by a *disabled* principal cannot justify a status (T2).
11. **`state='APPROVED'` without the matching `authoritative_status` is ABORTed** (T4).
12. **`JOB_COMPLETED → APPROVED` and any move off a terminal status are ABORTed** (T3).
13. **Clearing `authoritative_status` to NULL is ABORTed** (T2).
14. **`decisions` and `audit_log` reject UPDATE and DELETE; `decision_grants` rejects INSERT/UPDATE/DELETE** (T5).
15. **A hand-written `INSERT` into `decision_grants` cannot widen authority**, and after it fails, invariant 7 still holds.

**Frozen reference data (T6) — raw SQL, application bypassed**

Each of 15a–15d asserts the statement is ABORTed, the table's rows are byte-for-byte unchanged afterwards, **and** that the invariant the row protects still holds (15e), proving the trigger was not merely cosmetic:

- **15a. Terminality cannot be relaxed.** `UPDATE authoritative_statuses SET terminal = 0 WHERE authoritative_status = 'JOB_COMPLETED'` is ABORTed.
- **15b. Ranks cannot be re-ordered.** `UPDATE authoritative_statuses SET rank = 99 WHERE authoritative_status = 'APPROVED'` is ABORTed (and so is lowering a terminal status's rank).
- **15c. New statuses cannot be added.** `INSERT INTO authoritative_statuses VALUES ('UNAPPROVED', 5, 0)` is ABORTed.
- **15d. Statuses cannot be deleted.** `DELETE FROM authoritative_statuses WHERE authoritative_status = 'REJECTED'` is ABORTed.
- **15e. Invariants survive every attempt.** After each of 15a–15d, re-run the T3 checks against a live job: a `JOB_COMPLETED` job still cannot be moved to any other status, and an `APPROVED` job still cannot regress. The protected behaviour is verified, not just the ABORT.

**Durable job roots (T7) — raw SQL, application bypassed**

- **15f. New jobs start unstamped.** Inserts carrying an
  `authoritative_status`, a `deciding_decision_id`, or an authoritative state
  (`APPROVED`, `READY_FOR_DELIVERY`, `JOB_COMPLETED`, `REJECTED`, or
  `JOB_CANCELLED`) are ABORTed with `jobs must begin without authoritative state`.
- **15g. Jobs cannot be deleted.** Deletes of both unstamped and stamped jobs
  are ABORTed with `jobs are durable and cannot be deleted`; the same remains
  true when a second SQLite connection disables foreign-key enforcement. The
  original job, status, and decision rows remain unchanged.

**Durable-row replacement (T8) — raw SQL, application bypassed**

- **15h.** A genuinely new `jobs` row can be inserted, but ordinary duplicate
  INSERT, `INSERT OR REPLACE`, and bare `REPLACE` cannot replace an existing
  `job_id`, even when the connection has `recursive_triggers=OFF`.
- **15i.** A new principal decision can be inserted, while UPDATE, DELETE,
  `INSERT OR REPLACE`, and bare `REPLACE` cannot replace an existing
  `decision_id`; T2 continues to evaluate the original immutable decision.
- **15j.** Normal `audit_log` AUTOINCREMENT inserts that omit `seq` continue to
  work, while explicit-sequence `INSERT OR REPLACE` and `REPLACE` cannot replace
  an existing row. The original audit row and hash remain unchanged.

**Identity, sessions, bootstrap**

16. **Only one principal actor can exist** (unique partial index).
17. **The service refuses to serve with zero enabled principals**, and `init` is the only path that creates one.
18. **Two Codex session tokens map to the same principal**, both may act, and each decision records the correct `session_token_id` — answering "which session decided this?"
19. **Session identity confers no extra authority**: a session token cannot do anything the actor cannot.
20. **Concurrent sessions cannot both decide a cycle** — the second gets `STATE_CONFLICT` and no durable mutation is committed; failed CAS attempts are intentionally not audit rows.

**Lifecycle**

21. **Max QA cycles are enforced** — a `FIX`/`RETEST` request that would
    exceed `max_cycles` selects the non-authoritative `STALLED(max_cycles)` guard
    without incrementing the cycle, while a `max_cycles+1`-th dispatch is
    refused before worker/lease creation.
22. **`hard_max_cycles` cannot be exceeded**, even by the principal.
23. **`qa_dispatch` is atomic** — a forced failure while inserting the second run leaves no runs, no leases, and `state` unchanged.
24. **`RETEST` does not auto-dispatch** — the job is `IN_PROGRESS` at `cycle+1` with no runs until an explicit dispatch.
25. **Duplicate worker result does not corrupt state** — two identical `run_report` calls → one evidence set, one settle, second returns `duplicate: true`.
26. **A stale lease is refused** — a report for cycle N after the job advanced is rejected and audited.
27. **Process restart preserves jobs** — kill mid-run, restart: jobs intact, runs `ORPHANED`, job `STALLED`, nothing auto-approved.
28. **The `system` actor cannot reach any authoritative status** — property test over every `(state, transition)` pair with `actor=system`.

**Boundaries and secrets**

29. **Workspace allowlist holds** — a job in `C:\Windows`, `C:\`, a UNC path, a `\\?\` device path, or `C:\AgentProjects\..\Other` is rejected; `C:\AgentProjects\foo` is accepted.
30. **Artifact path jail holds** — `..`, absolute paths, symlinks, `CON`/`NUL`, ADS, and trailing-dot names are all rejected.
31. **Secrets directory ACL is created and verified** — on Windows, an ACL containing `BUILTIN\Users` causes startup to **fail closed**; on POSIX, mode `0700`/`0600` is asserted. (Runs only on the matching platform.)
32. **Bearer tokens are print-once** — no plaintext token is written to the state root by default.
33. **Timeout kills the process tree** and produces `TIMEOUT`/`NONE`, never `PASS`.
34. **Malformed NDJSON does not crash a run** and never yields `PASS`.
35. **Secrets never appear** in audit rows, tool responses, stderr tails, or error messages (fixture worker that deliberately echoes a token).
36. **Audit chain verifies**, and a manually mutated row is detected.
37. **Non-localhost Origin → 403; unauthenticated → 401.**

### Verification (how a human confirms it end to end)

1. `npm test` — all layers green, including the raw-SQL bypass suite.
2. `node dist/index.js init` — creates `<OS profile>\.agent-orchestrator-mcp\`, hardens `secrets\`, applies migrations, creates the `codex` principal, prints its token once.
3. `node dist/index.js doctor` — reports state-root, DB-file, and
   WAL/SHM filesystem-security status. For an existing DB it reports
   `DB_FILE_SECURITY=PASS` and
   `DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`; it does not open the
   authoritative DB or report SQL migration/principal counts. Deep SQLite
   integrity is verified by `init` and `serve` startup.
4. `npx @modelcontextprotocol/inspector node dist/index.js --stdio` — the
   current baseline `tools/list` shows the ten baseline tools; the Phase 5
   verification packet must additionally prove only the approved lifecycle
   additions and must not expose Phase 6–9 tools.
5. Start HTTP mode; `curl` with no token → 401; bad `Origin` → 403; worker token → `tools/list` **does not contain `codex_decide`**.
6. Issue a *second* Codex token (`token issue --label codex-session-b`); register both in two Codex sessions via `bearer_token_env_var`; confirm both can act and that `audit_query` distinguishes them.
7. Scripted job against the fixture worker: create (in `C:\AgentProjects\...`) → dispatch → report(PASS) → confirm `authoritative_status` is NULL → `codex_decide(REJECT)` → `audit_query` explains the chain.
8. Against a DB created/validated by `init` or
   `serve` startup, open the DB with `sqlite3` and attempt by
   hand: the three decision bypasses (invariants 7–9), then
   `UPDATE authoritative_statuses SET terminal = 0 WHERE authoritative_status='JOB_COMPLETED'`
   and `UPDATE authoritative_statuses SET rank = 99 WHERE authoritative_status='APPROVED'`
   (invariants 15a–15b), an authoritative/stamped job INSERT, and a DELETE of
   both an unstamped and a stamped job (15f–15g), then exercise
   `INSERT OR REPLACE` and bare `REPLACE` against jobs, decisions, and
   `audit_log` (15h–15j). Every one must ABORT, and
   `SELECT * FROM authoritative_statuses` must be unchanged afterwards.
9. Kill the service mid-run and restart; confirm `STALLED` with orphaned runs and no authoritative status set.

---

## 20. V1 Scope

### MUST HAVE (V1)

- Config loading and validation, including the **workspace-root allowlist**
- `init` / `migrate` / `token` / `doctor` / `serve` CLI, with documented bootstrap
- Global state root under `<OS profile>\.agent-orchestrator-mcp\`, **Windows ACL hardening with fail-closed verification** (§15.1), POSIX modes on POSIX
- One SQLite store, migrations, all tables and **triggers T1–T8** (including the frozen `decision_grants` and `authoritative_statuses` reference tables and durable job roots)
- Actors, `actor_tokens` (multi-session), capabilities, dispatch leases, print-once tokens
- Job state machine and transition table exactly as §6, including the atomic `qa_dispatch` transaction
- The ten baseline MCP tools of §8, plus the two Phase 5 lifecycle operations
  `job_start` and `job_resume` once the Phase 5 plan is independently reviewed
  and implementation is explicitly authorized
- HTTP (loopback + bearer + Origin/Host guards) **and** stdio over one core
- Generic NDJSON process-worker adapter + shared `ProcessRuntime` + fixture workers
- Both worker ingress paths (spawned NDJSON, and `run_report` with a lease)
- Artifacts (path jail, sha256, metadata-only) and evidence with trust classes
- Hash-chained audit log with session attribution, redaction, `audit_query`
- Reaper, crash recovery to `STALLED`, startup invariants
- Idempotency and optimistic concurrency
- The full test suite of §19, including the raw-SQL bypass layer

### SHOULD HAVE LATER

- `agy`/Gemini adapter (§11), beginning with empirical re-verification of the CLI contract
- Registration of the **external** browser/CDP worker as a process worker (§12)
- **DPAPI encryption of the lease key** (§15.1 rationale)
- MCP resources exposing artifacts read-only
- Worker capability grants beyond read-and-report
- `prune` CLI and artifact retention policy for the shared global root
- Status CLI / read-only local dashboard
- Reusable QA recipes (job templates)
- Automatic DB backup rotation

### NOT NOW

- Remote/networked operation, TLS, multi-machine
- OAuth authorization server (the local token verifier is sufficient and correct)
- A plugin system, dynamic worker loading, in-process worker sandboxes
- Web UI
- Queueing beyond a small in-process FIFO
- Cost accounting/budgeting across agents
- Any NASQ-, Salla-, site-, or repo-specific tool, schema, or default

---

## 21. Implementation Phases

> **Historical implementation baselines:** The Phase 4 row below
> describes the authorized Phase 4 scope on `codex/phase4-implementation`.
> Phase 5 was subsequently planned, independently reviewed, implemented, and
> published under its separate authorization record. Revision 9 below records
> the published Phase 6 implementation. Revision 10 below records the published
> Phase 7 implementation and Windows correction. Revision 11 below records the
> published Phase 8 implementation. Revision 12 below is the current Phase 9
> hardening baseline, merged and published in `main` and `origin/main`.

Each phase is independently verifiable and leaves the repo green.

| # | Phase | Deliverable | Verified by |
|---|---|---|---|
| **0** | Skeleton | package.json, tsconfig, vitest, lint, empty CLI, CI script | `npm test` runs; `--help` works |
| **1** | State root & secrets | State-root resolution, directory creation, **Windows ACL apply + verify + fail-closed**, POSIX modes, lease-key generation, `doctor` | Invariants 31, 32; manual ACL tamper drill |
| **2** | MCP spine | Both entry points, one trivial `ping` tool, localhost guards, bearer gate, `actor_tokens` resolution | Inspector connects; invariant 37; **observed Codex protocol era recorded** |
| **3** | Store & DB authority | Migrations `001`–`004`, all tables, seeds, **triggers T1–T8** (freeze triggers created *after* the seed inserts), canonical schema verification, repositories, init/serve SQL integrity checks, and doctor filesystem/security diagnosis | Invariants 7–15, **15a–15j** plus F-1 replacement cases (raw SQL), 16; failed-init cleanup/build-copy/transaction gates; doctor explicitly reports SQL integrity not checked by design |
| **4** | Authority core | Capabilities, roles, transition table, `applyTransition`, `codex_decide`, decision-scoped idempotency/CAS, audit log + chain + session attribution, startup invariants | Invariants 1–6, 17–20, 28, 36 |
| **5** | Job lifecycle | Protected `config.json`, `job_create`, `job_start`, `job_resume` (+ workspace allowlist), `job_get`, `job_list`, cycles, broader lifecycle idempotency/CAS | Invariants 21, 22, 24, 29 with the Phase 5/6 owner split; integration to `APPROVED` with no workers |
| **6** | Worker runtime | Adapter interface, `ProcessRuntime`, NDJSON parser, fixture workers, atomic `qa_dispatch`, leases, `run_report`, `run_status` | Invariants 23, 25, 26, 33, 34; published at `8867074` |
| **7** | Evidence & artifacts | `evidence_add`, `artifact_register`, bounded metadata reads, path jail, hashing, trust classes, size caps | Revision 10 published; Windows correction and closure recorded at `d0ce68c` |
| **8** | Resilience | Reaper, crash recovery, cancellation settlement, graceful shutdown, `STALLED` paths, `audit_query` | Revision 11 approved plan; implementation merged and published at `3f03168c` |
| **9** | Hardening & docs | Rate limits, redaction sweep, `WORKER_PROTOCOL.md`, root `SECURITY.md`, README, two-session Codex drill | Accepted and published in `main`/`origin/main` at `398785ea` |
| **10** | External deterministic browser worker | First post-V1 integration plan using the existing worker pipeline; no core expansion proposed | Documentation-only plan on `codex/phase10-authority-plan`; implementation not started |

Phases 1–4 deliver the authority guarantee — the reason this project exists — before any worker code is written; Phase 3 in particular proves it at the SQL layer with no application code in the way.

**Post-V1, in order:** register the external browser worker (config only, no core change) → then the `agy` adapter, **starting with empirical verification of the installed CLI's prompt/stdin contract** before any code is written against it. If either requires editing `domain/` or `store/`, the architecture failed and should be revisited rather than patched.

---

## 22. Open Questions

Only what genuinely blocks or materially changes implementation. *(State location, concurrent Codex sessions, workspace roots, and the browser worker's location are decided and no longer asked.)*

1. **How will each Codex session receive a distinct token?** Codex reads the bearer token from an environment variable named in `config.toml`, so distinct per-session tokens require launching each session with a different value for that variable. If all sessions inherit one environment, they will share one token and session attribution degrades from *verified* (`session_token_id`) to *claimed* (`session_hint`). The design already handles both, so this is **not blocking implementation** — but it determines how strong the audit answer to "which session decided this?" actually is, and it is worth confirming how sessions are launched. *Affects Phase 4 documentation, not code.*

2. **Retention policy for the shared artifact root.** One global root accumulates artifacts from every project. Proposed Phase 7 fixes a per-artifact and per-job admission cap, while deletion, pruning, and archival remain later-phase concerns. A retention policy is not required to begin Phase 7 planning; any deletion policy must be reviewed separately and must not weaken append-only metadata.

3. **`agy` prompt-delivery contract.** Deferred by decision, but recorded here so it is not forgotten: the installed CLI documents `--input-format text|stream-json` for print mode and does not document plain-text stdin prompts with `-p`. This must be verified empirically at the start of the agy phase rather than assumed. *Not blocking V1.*

---

## 23. FINAL RECOMMENDATION

**Revision 7 remains the approved architecture for the merged Phase 3 baseline.**
Revision 8 is the approved Phase 4 implementation baseline and is merged.
Revision 9 is the published Phase 6 worker-runtime baseline at
`88670743f8a443bbf3b71c9f379199deca42d512`. Revision 5 remains the historical doctor-boundary correction;
Revision 6 remains the historical job-row/schema correction; Revision 7
preserves both and adds the narrow SQLite row-replacement integrity correction
described above.

Revision 6 retains the Revision 5 doctor boundary: doctor performs filesystem/security
diagnosis only and reports SQL integrity as
`NOT_CHECKED_BY_DESIGN`. Authoritative SQLite integrity belongs to
`init` and `serve` startup, where migration, schema, trigger,
seed, canonical-definition, and integrity checks can fail closed without giving
the diagnostic path a direct SQLite handle to the WAL database.

The central requirement — Codex as sole authority — is now enforced at five independent layers, and the database layer no longer merely checks that *a* decision exists: it checks that the referenced decision **semantically grants the exact status being written**, was authored by an **enabled principal**, targets the **same job, cycle, and state**, and does not regress or resurrect a terminal outcome. `RETEST`, `FIX`, `VERIFY_SELF`, and `IGNORE_FALSE_POSITIVE` have no grant row and therefore cannot justify any authoritative write, from the application or from a `sqlite3` shell. Those claims are proven by a raw-SQL test layer that bypasses the application entirely, not asserted in prose.

Revision 3 closes the last gap in that argument: the reference data those triggers *read* is now as immutable as the triggers themselves. `decision_grants` and `authoritative_statuses` are both frozen against INSERT/UPDATE/DELETE by triggers created after their seed inserts, so an attacker cannot disarm terminality or monotonicity by editing a lookup table instead of a job row. Changing either map is a reviewed, versioned migration. Five raw-SQL tests (15a–15e) prove not only that each mutation is ABORTed but that the invariant it protects still holds afterwards.

Naming now matches semantics: `authoritative_status` records milestones (some of which are not terminal), `state` records workflow position, and `worker_verdict` remains structurally unable to reach either.

Revision 6 closed the prior job-row lifecycle gap: every job begins as a
durable, non-authoritative ledger root and no runtime path may delete it. The
canonical startup verifier checks trigger bodies and all security-sensitive
schema definitions, so preserving an object name while weakening its SQL is
not an accepted recovery state. Its approved migration ledger was `[1, 2, 3]`;
failed fresh initialization removes only its own DB/WAL/SHM artifacts after
closing SQLite and keeps the original failure visible.

Revision 7 closes F-1: SQLite `REPLACE` cannot erase and recreate an existing
`jobs`, `decisions`, or `audit_log` identity, even when an external connection
sets `recursive_triggers=OFF`. The Revision 7 Phase 3 baseline ledger is
`[1, 2, 3, 4]`, canonical verification covers T1–T8, and AOM-owned writable
connections enable `recursive_triggers` as defense in depth. Revision 8 adds
migrations 005/006 and the v6 authority/auth implementation on the separate
Phase 4 branch.

The Windows security model is Windows-native — inheritance-stripped, current-user-SID-only DACLs, verified after creation and on every startup, failing closed — with `chmod` correctly demoted to the POSIX implementation, and DPAPI evaluated and deferred on a stated cost/benefit basis rather than by omission. State lives in one global root so the orchestrator can coordinate across projects, while workspace access is a narrow, config-driven allowlist that never includes a drive root.

Multiple Codex sessions are supported with **verified** session attribution and exactly one principal actor; the single-principal invariant is now guaranteed in both directions — at most one by index, exactly one enabled by startup check, with documented bootstrap.

Scope remains honest: V1 is the authority core plus one generic worker adapter. `agy` and the browser worker are designed, external, and deferred, with the agy CLI contract explicitly flagged as unverified.

The Phase 3 merge is complete. The Revision 8 amendment and
`docs/PHASE4_PLAN.md` are governing artifacts originating at `65008a97`; the
Phase 4 implementation is complete and merged in `main` at
`ea07fbcae4264fb91601ba03b1bbc84c57e8b7a5`. The Phase 5 planning baseline and
its authorization are recorded in `docs/PHASE5_PLAN.md`; the independently
reviewed implementation was merged at
`7d7c3f61a118c26d4da0347f6c3ceb9ec286d0ea` from reviewed head
`4ba475005a0f6d0b9504e7dc82d71d88f23a27e8`, and the closure record was
published in `main` at `530e2441636e6517096b1319c4510b1e56626592`. Phase 6 is
complete and published in `main` and `origin/main` at
`88670743f8a443bbf3b71c9f379199deca42d512`; its post-merge closure is recorded
in `docs/PHASE6_POST_MERGE_CLOSURE.md`. Phase 7 is published and closed at
`d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3`. Phase 8 planning is recorded below
and does not authorize implementation.

---

## 24. Revision 9 / Phase 6 worker runtime (published)

**Status: Phase 6 implementation complete and published in `main` and
`origin/main` at `88670743f8a443bbf3b71c9f379199deca42d512`.**

Revision 9 is the Phase 6 amendment derived from the published Phase
5 baseline `530e2441636e6517096b1319c4510b1e56626592`. It is governed by
`docs/PHASE6_PLAN.md` and `docs/WORKER_PROTOCOL.md`. The separate Codex
authorization permitted the scoped source implementation; the implementation
and post-merge closure are now complete. This section does not authorize Phase
7+ behavior.

### 24.1 Purpose and ownership

Phase 6 delivered the smallest local worker-runtime layer around the existing
job lifecycle. Workers may execute bounded tasks and return advisory results;
they may not make an authoritative job decision. `codex_decide` remains the
single authority path, and the internal `system` actor may perform only the
mechanical non-authoritative settlement required to close a run set.

### 24.2 Proposed worker registry

Phase 6 delivered a separate protected state-root registry at
`<state_root>\workers.json`. The existing Phase 5 `config.json` remains the
owner of Phase 5 workspace and cycle settings. The registry is server-owned
configuration and has no MCP administration tool.

Each enabled entry names a unique `worker_id`, a worker actor, the `process`
adapter, a local delivery mode, an operator-owned executable/argument policy,
an approved working-directory policy, an environment allowlist, and bounded
runtime/output limits. A dispatch request supplies only a registered
`worker_id` and bounded task parameters; it never supplies an executable,
shell command, environment, or arbitrary directory.

The init path creates one disabled starter entry so the Phase 6 transport can
start before an operator configures a real worker. Disabled entries are never
selectable; only an enabled entry requires an existing enabled `worker` actor
and an available regular executable.

The registry must be loaded and validated before the Phase 6 transport surface
is exposed. Worker actor bindings, capabilities, adapter names, path policy,
and bounds are all server-owned and fail closed when invalid. The exact
registry schema is fixed in `docs/PHASE6_PLAN.md` §5: root `version` is exactly
`1`, `workers` contains 1–64 entries, every entry has exactly the required
fields, `adapter` is `process`, `cwd_policy` is `job_workspace`, and timeout,
output, message, identifier, path, and environment bounds are enforced. No
unknown property is accepted. This replaces the earlier broad design wording
that described worker policy as part of general configuration; Revision 9
assigns it to the separate protected `workers.json` registry.

### 24.3 Proposed lifecycle and state boundary

The Phase 6 lifecycle is:

```text
IN_PROGRESS or REPAIR
  -> qa_dispatch transaction
  -> QA_RUNNING
  -> one or more worker runs
  -> terminal run settlement
  -> EVIDENCE_READY
  -> Codex consideration through codex_decide
```

The existing schema-v6 `worker_runs` and `leases` structures are reused in the
planning baseline. `QA_RUNNING` and `EVIDENCE_READY` remain non-authoritative.
When all runs for the current job/cycle are terminal, the runtime performs one
mechanical `QA_RUNNING` to `EVIDENCE_READY` transition. A worker PASS, FAIL,
timeout, cancellation, or malformed result never stamps an authoritative
status.

Restart-time orphan recovery, reaper loops, and job-level recovery remain
Phase 8 responsibilities. Evidence and artifact writes remain Phase 7
responsibilities, even though their structural tables already exist.

### 24.4 Proposed tool delta

The following MCP operations were approved for the scoped Phase 6 implementation
and are active on the published Phase 6 baseline:

| Tool | Caller | Purpose |
|---|---|---|
| `qa_dispatch` | verified Codex principal with `qa:request` | Atomically admit one to sixteen registered worker runs |
| `run_report` | verified worker with `work:report` and a valid run lease | Submit one bounded advisory terminal result |
| `run_status` | verified principal or observer with `job:read` | Read bounded run status |

No worker-administration, arbitrary process-launch, evidence, artifact,
recovery, or second-decision tool is part of the published Phase 6 surface.
Evidence and artifact admission are reserved for the separate Phase 7 proposal
below.

### 24.5 Proposed process and protocol boundary

The generic `process` adapter is a pure planner. One shared process runtime
owns argv-array execution, explicit working directory, explicit environment,
bounded streams, timeout, process-tree/group termination, and normalization.

The worker protocol is versioned NDJSON with bounded lines, total output,
message count, progress text, and result summary. The initial message types
are `ready`, `progress`, `result`, and `error`. A valid run has one terminal
result or error; missing, malformed, oversized, duplicate, or out-of-order
messages cannot produce success. Evidence and artifact messages are excluded
from the Phase 6 protocol.

Pipe-mode output and local pull-mode `run_report` input share one report
settlement function. A run-scoped lease is never returned to the Codex
dispatch caller and does not confer decision authority. Remote, cloud, browser,
and external worker delivery are excluded. In `mcp_pull` mode the lease is the
exact two-part `base64url(canonical_payload).base64url(HMAC-SHA256)` envelope
defined in `docs/WORKER_PROTOCOL.md` §3.1; its payload binds lease, run, job,
cycle, actor, expiry, and the server-generated nonce. The worker's transport
identity is separate from the lease and is not included in the registry or
private start envelope. Pipe mode keeps the lease runtime-owned.

### 24.6 Persistence and transaction boundary

The published Phase 6 implementation introduced no migration and no
schema-definition change.
`qa_dispatch` creates all run and lease rows and the non-authoritative
`QA_RUNNING` transition in one immediate transaction, then starts processes
after commit. Report settlement consumes the lease and updates the run in one
transaction; if the final run becomes terminal, the same transaction performs
the one non-authoritative settlement.

The existing audit-chain and attribution model is retained. Phase 6 may add
only the reviewed lifecycle action names needed for dispatch, run settlement,
lease events, timeout, cancellation, failure, and duplicate reporting. No
worker event may be recorded as an authoritative decision.

### 24.7 Phase boundary and authorization

The Phase 6 plan, worker protocol, and this architecture delta received
independent review and Codex adjudication. Codex has recorded the following
separate implementation decision for the implementation branch:

```text
AUTHORIZE PHASE 6 IMPLEMENTATION: YES
```

This decision authorized only the scoped work on
`codex/phase6-implementation`. That implementation was subsequently reviewed,
merged fast-forward into `main`, published to `origin/main`, and closed in
`docs/PHASE6_POST_MERGE_CLOSURE.md`. It does not authorize Phase 7.

---

## 25. Revision 10 / Phase 7 evidence and artifact proposal

**Status: Phase 7 implementation and the corrective Windows path fix are
published in `main` and `origin/main`. The final documentation closure is
`d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3`; the implementation handoff is
recorded in `docs/PHASE7_IMPLEMENTATION_REPORT.md` and post-merge closure is
recorded in `docs/PHASE7_POST_MERGE_CLOSURE.md`.**

Revision 10 is derived from the published Phase 6 baseline at
`88670743f8a443bbf3b71c9f379199deca42d512`. It is governed by
`docs/PHASE7_PLAN.md` and is intended to activate the existing `evidence` and
`artifacts` structures in a bounded, attributable, append-only manner. The
presence of those tables in the Phase 6 base schema version 6 did not mean their
runtime write paths were active; the Phase 7 implementation migrates the
published baseline to schema version 7 and activates the reviewed paths.

### 25.1 Purpose and ownership

Phase 7 owns the smallest evidence/artifact admission layer around completed
worker runs. It allows bounded observations and files to be associated with a
job, cycle, and optional run, and allows Codex to inspect bounded metadata and
cite evidence. Worker output remains advisory; `codex_decide` remains the only
authoritative decision path.

### 25.2 Proposed persistence amendment

The existing schema-v6 `evidence` and `artifacts` columns remain the data
contract unless independent review proves a missing column is necessary. The
proposed schema version is 7, with a reviewed migration for append-only guards,
job/cycle/run binding checks, and only the indexes required by bounded reads.
Canonical schema fingerprints and startup migration checks must be updated
together during a separately authorized implementation.

Phase 7 does not introduce deletion, replacement, pruning, retention cleanup,
or a recovery loop. Filesystem residue after a process crash belongs to Phase 8.

### 25.3 Evidence and trust boundary

The server derives `source_actor` from the verified caller or active run lease
and assigns trust. Principal-created evidence is `principal`, worker-created
evidence is `untrusted`, and `deterministic` remains reserved for a named
server-owned producer. A client cannot submit a stronger trust value.

Evidence is bounded to 1,024 rows per job, a 2,048-byte summary, and 65,536-byte
serialized detail; kind, severity, references, and idempotency are validated. Any supplied
decision evidence reference must exist for the same job and cycle, but evidence
never grants authority or changes a job state.

### 25.4 Artifact boundary

The orchestrator copies bytes into the global artifact root, computes the byte
count and SHA-256 digest, and stores metadata only in SQLite. Clients provide
only a relative source name within an approved source root. The server chooses
the final relative path and rejects traversal, absolute/device paths, alternate
data streams, reserved names, symlinks, reparse points, and out-of-root files.

The planning caps are 16 MiB per artifact, 256 MiB total and 256 rows per job,
with bounded kind, MIME, label, and stored-path fields. Artifact metadata is
append-only and a failed copy or metadata transaction cannot be reported as a
successful registration.

### 25.5 Proposed MCP surface

Phase 7 proposes exactly four operations:

| Operation | Surface |
|---|---|
| `evidence_add` | Append one bounded, server-classified evidence record. |
| `artifact_register` | Copy and register one bounded artifact file. |
| `evidence_list` | Read bounded evidence metadata with an opaque cursor. |
| `artifact_list` | Read bounded artifact metadata with an opaque cursor. |

No artifact bytes are exposed through MCP in Phase 7. Worker output is
normalized through the same admission rules in pipe and local pull modes. No
reaper, `audit_query`, remote worker, arbitrary file-read, or second-decision
operation is introduced.

### 25.6 Packaging and decision linkage

The `PACKAGE` path is planned to create one server-generated canonical manifest
artifact for the current job/cycle. It contains bounded evidence and artifact
metadata and decision-chain identifiers, not raw worker streams. `DELIVER`
continues to require a valid current-cycle manifest. Manifest creation must
have an explicit filesystem staging and SQLite transaction boundary; it cannot
be described as an unqualified atomic filesystem/database operation.

### 25.7 Phase boundary and authorization

The gate below is the historical pre-merge Phase 7 record. It is retained for
provenance; the gate was satisfied, the implementation was merged, the
Windows correction was verified, and the closure was published above. It does
not authorize Phase 8.

Revision 10 received independent architecture review and Codex adjudication.
The following decision authorizes only the scoped implementation branch:

```text
AUTHORIZE PHASE 7 IMPLEMENTATION: YES
```

The implementation must remain on `codex/phase7-implementation` and must not
be merged until its own implementation review and final merge gate. The review
must
confirm the proposed schema guards, quotas, trust derivation, path policy,
worker admission, metadata reads, manifest behavior, and Phase 8 boundary.
After review, Codex must adjudicate every finding and record a separate
decision:

```text
AUTHORIZE PHASE 7 IMPLEMENTATION: YES / NO
```

Until that decision is explicitly `YES`, no Phase 7 source, migration, MCP
registration, deployment, push, pull request, or merge may begin.

---

## 26. Revision 11 / Phase 8 resilience and recovery proposal

**Status: approved planning baseline; implementation merged and published.** Revision
11 is derived from the
published Phase 7 base at
`d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3`, whose tree is
`471c197bee3855fc210e2ab0adf77ce1f30815c7`. The base is clean and synchronized
with `origin/main`. The Phase 7 implementation head and the Windows
path-normalization correction are ancestors of this base.

The complete planning contract is in
[`docs/PHASE8_PLAN.md`](PHASE8_PLAN.md). Revision 11 defines and implements the smallest
resilience layer around the completed Phase 5–7 lifecycle:

- startup reconciliation of active runs left by a previous process;
- one bounded per-process reaper for stale, deadline, lease, and ownership
  loss cases;
- orphan handling, late-report rejection, and mechanical cancellation
  settlement;
- bounded graceful shutdown with HTTP/stdio parity;
- mechanical entry into the existing non-authoritative `STALLED` state; and
- one bounded, read-only, principal-only `audit_query` proposal.

The invariant is unchanged and absolute:

> **Recovery may stop, orphan, cancel, or stall work; it may never decide the job.**

### 26.1 Persistence boundary

The proposed baseline is schema v7 with no migration. Existing job fields
(`deadline_at`, `stale_after_s`, `updated_at`, `version`, and `state_reason`),
existing run statuses, derived lease eligibility, and the append-only audit
ledger are the candidate representation. This is conditional on independent
review confirming that no required recovery fact is being hidden in an
unrelated field. A missing fact requires a documented plan revision before
implementation authorization.

The plan uses existing run statuses (`ORPHANED`, `TIMEOUT`, and `CANCELLED`)
and does not invent an `EXPIRED` lease status. An expired, consumed, mismatched,
or terminal-run lease is simply unusable under the existing eligibility rule.

### 26.2 Authority and query boundary

The internal `system` actor may reconcile runtime state, append bounded audit
events, and enter `STALLED`; it has no public capability and cannot write an
authoritative decision. The existing `codex_decide` path remains the sole
authority writer.

`audit_query` is proposed as a principal-only read operation with opaque,
sequence-based pagination, page size 100 by default and 200 maximum. Workers
and the system actor have no access. Observer access and any new
`audit:read` capability are not silently added; they require a separate review
decision. Filters are limited initially to existing indexed scope (`job_id`,
`session_token_id`, and sequence cursor), with broader filtering deferred.

### 26.3 Scope and governance

Revision 11 excludes evidence/artifact redesign, remote or cloud workers,
automatic retries, distributed scheduling, telemetry, backup/restore,
deployment, and all Phase 9 work. The acceptance matrix in the plan contains
56 named cases: 48 Phase 8 behavior cases and 8 regression/scope cases.

The pre-implementation order was: freeze the documentation-only snapshot,
independent architecture review, Codex finding-by-finding adjudication,
documentation-only corrections if needed, final plan freeze, and then a
separate explicit decision. That gate is now satisfied for the branch below:

```text
AUTHORIZE PHASE 8 IMPLEMENTATION: YES / NO
```

The recorded authorization is:

```text
AUTHORIZE PHASE 8 IMPLEMENTATION: YES
IMPLEMENTATION BRANCH: codex/phase8-implementation
IMPLEMENTATION HEAD: d46e956026ae351c4aee7d353b4971924e00b717
```

The authorization was limited to `codex/phase8-implementation`; the reviewed
head was subsequently fast-forwarded into local `main` and published to
`origin/main` at `3f03168c161a941c4f7055629e6f433c636e62a7`. Deployment and
Phase 9 implementation remain outside this closure. The implementation head
and verification evidence are recorded in
[`docs/PHASE8_IMPLEMENTATION_REPORT.md`](PHASE8_IMPLEMENTATION_REPORT.md).

---

## 27. Revision 12 / Phase 9 hardening and documentation proposal

**Status: implementation complete, merged, and published.** Revision 12 is derived from the
published Phase 8 base at
`3f03168c161a941c4f7055629e6f433c636e62a7`, whose tree is
`8d34fe5c26d0b0f392cdab750cc8e14d3ab61c80`. Phase 8 is complete and published.
Phase 9 implementation was explicitly authorized on `codex/phase9-implementation`
from corrected planning snapshot `a75ec06542660cd4d3a338bed514186549a381bd`
and is locally complete at
`f17ba7788c6b364646eaf7e31c12422bc4d1e20c`. The accepted implementation was
fast-forwarded into local `main` at
`bea75982ec6c53539a3c13a8260d70f7d0160786` and published in `main` and
`origin/main` at `398785ea48926b52829a0fd1fa4c6d8d8c6e0ef8`.

The complete planning contract is in
[`docs/PHASE9_PLAN.md`](PHASE9_PLAN.md). Revision 12 proposes only:

- a shared authenticated per-token request-admission limiter;
- a complete redaction/data-classification and sink manifest;
- normalization of `WORKER_PROTOCOL.md` without changing version 1 wire behavior;
- the root `SECURITY.md` normative security guide;
- README and governance-status cleanup;
- a sanitized two-session attribution drill; and
- Windows/POSIX regression evidence for the published Phases 4–8.

No schema migration, public capability, MCP business tool, worker message,
remote/cloud integration, autonomous retry, telemetry platform, deployment, or
Phase 10 feature is proposed.

The central invariant remains:

> **Hardening may restrict exposure or admission; it may never create or alter an authoritative decision.**

The implemented fixed rate-limit values are 30 credits per verified token with
a one-credit-per-second refill, in memory only. The shared HTTP/stdio admission
hook is implemented and was independently implementation-reviewed before the
local fast-forward and publication.

The planned acceptance matrix contains 64 cases. The required governance order
is documentation freeze, independent architecture review, Codex adjudication,
documentation-only correction/re-review if needed, a separate explicit
`AUTHORIZE PHASE 9 IMPLEMENTATION: YES / NO` decision, implementation review,
and final merge authorization. The source implementation is complete, merged
into local `main`, and published to `origin/main`; later-phase work remains a
separate operation.

The local post-merge record is in
[`docs/PHASE9_POST_MERGE_CLOSURE.md`](PHASE9_POST_MERGE_CLOSURE.md).

---

## 28. Revision 13 / Phase 10 external deterministic browser worker plan

**Status: documentation-only planning.** Revision 13 starts from the published
Phase 9 `main` state at
`c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8`, whose tree is
`f3759e83ef167f0076e02b033bd5e06f9e90f3ff`. It proposes the first ordered
post-V1 integration: one external deterministic browser worker using the
existing local worker registry, process runtime, Worker Protocol V1,
evidence/artifact admission, and Codex authority boundary.

The complete planning contract is in
[`docs/PHASE10_PLAN.md`](PHASE10_PLAN.md). The plan introduces no schema
change, migration, MCP business tool, capability, actor role, worker message,
protocol-version change, remote/cloud transport, scheduler, autonomous retry,
telemetry platform, or Phase 11 feature.

The exact external worker identity, version, invocation contract, platform
support, destination policy, and output compatibility are not assumed. They
are blocking evidence items before any implementation authorization. If the
integration requires changing `src/domain/`, `src/store/`, authoritative
transitions, or durable schema, that is an architecture failure signal and the
work must return to review.

Chrome is the current engine candidate. The worker must use a dedicated,
operator-owned or fresh temporary profile, never a personal Chrome profile or
an already-running browser process. Profile paths, browser flags, executable
selection, and destination policy remain external configuration and are not
job-controlled inputs.

The intended final product runtime controller is ChatGPT connected to AOM over
MCP. The current V1 `codex` actor is the single principal identity, not a
requirement that the Codex executable be the runtime controller. Codex remains
the development governance authority while the product is being built. The
actual ChatGPT-to-local-AOM connector or bridge, and callable subordinate
interfaces for Codex or Antigravity/Hermes, remain unverified; no second
principal or authority path is introduced to solve that uncertainty.

The governing invariant is:

> **A browser worker may produce bounded advisory observations and artifacts;
> it may never become an authority, select arbitrary execution policy, or
> require an AOM core redesign.**

Phase 10 implementation remains unauthorized until an exact planning snapshot
passes independent architecture review and Codex records:

```text
AUTHORIZE PHASE 10 IMPLEMENTATION: YES / NO
```

The independent review and Codex finding-by-finding adjudication are recorded
in
[`docs/PHASE10_ARCHITECTURE_REVIEW_ADJUDICATION.md`](PHASE10_ARCHITECTURE_REVIEW_ADJUDICATION.md).

The current external-worker inventory is recorded in
[`docs/PHASE10_EXTERNAL_WORKER_EVIDENCE.md`](PHASE10_EXTERNAL_WORKER_EVIDENCE.md);
the exact worker contract remains unverified and implementation remains
unauthorized.
