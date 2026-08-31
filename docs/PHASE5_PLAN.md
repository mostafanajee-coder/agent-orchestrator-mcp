# AOM — PHASE 5 JOB LIFECYCLE PLAN

> **Status: PROPOSED PLANNING BASELINE — IMPLEMENTATION NOT AUTHORIZED**
>
> This document starts the Phase 5 planning cycle from the authoritative merged
> Phase 4 `main` state. It defines the intended job-lifecycle boundary and the
> review gates; it does not authorize source changes, migrations, MCP tool
> registration, push, pull requests, deployment, or Phase 6+ work.

Date: 2026-08-31
Repository: `C:\AgentProjects\agent-orchestrator-mcp`
Planning branch: `codex/phase5-authority-plan`
Authoritative planning base: `4ebfb267b25607f5e955d0d376582a3b26593648`
Phase 4 implementation merge: `ea07fbcae4264fb91601ba03b1bbc84c57e8b7a5`
Phase 4 closure merge: `4ebfb267b25607f5e955d0d376582a3b26593648`
Governing architecture: `docs/ARCHITECTURE.md` Revision 8
Governing Phase 4 record: `docs/PHASE4_PLAN.md`

## 0. Governance and authority

Codex is the principal architecture and implementation authority for this
repository. This plan is a planning artifact only. An independent reviewer may
identify blockers or required corrections, but implementation begins only after
Codex adjudicates the review and issues a separate explicit authorization.

The required sequence is:

```text
Phase 5 plan
  -> documentation-only review corrections, if any
  -> frozen planning snapshot
  -> independent architecture review
  -> Codex finding adjudication
  -> explicit: AUTHORIZE PHASE 5 IMPLEMENTATION: YES / NO
  -> implementation branch and source work
  -> implementation tests and independent implementation review
  -> Codex final merge gate
```

The following remain prohibited by this document:

- source-code changes for Phase 5;
- SQL migration creation or schema-version changes;
- registering or exposing Phase 5 MCP tools;
- worker execution, lease use, evidence/artifact writes, or resilience loops;
- changes to Phase 3/4 history or the merged Phase 4 implementation;
- push, PR creation, merge, deployment, or Phase 6/7/8/9 work.

## 1. Planning baseline

The starting tree is the merged Phase 4 tree on `main`. Phase 4 is complete and
closed. Its authority, authentication, audit, transition, and decision rules are
inherited rather than redesigned here.

The current durable store is SQLite schema version 6 with migrations 001–006.
The Phase 3 schema already contains the durable `jobs`, `decisions`, and
`idempotency` tables and the indexes needed for the initial Phase 5 reads. This
plan assumes that those tables are sufficient. A newly discovered need for a
column, table, index, trigger, or migration is a planning blocker and must not
be implemented under this plan without a reviewed plan amendment.

Phase 5 starts with no production job-lifecycle tool registered. Existing
`codex_decide` is the Phase 4 authority primitive and operates on an existing
job row. Phase 5 supplies the durable job lifecycle around that primitive; it
does not replace it and does not create another authority writer.

## 2. Objective

Implement and verify the smallest safe lifecycle for durable jobs:

1. accept a new job only after validating its bounded specification and
   workspace;
2. persist the job in the approved initial non-authoritative state;
3. read one job or a bounded filtered page of jobs;
4. provide the lifecycle/cycle coordination needed before worker runtime exists;
5. apply broader lifecycle idempotency and optimistic concurrency rules while
   preserving the Phase 4 decision-scoped rules; and
6. prove that a created job can reach `APPROVED` through `codex_decide` without
   worker execution or fabricated worker evidence.

The objective is a job ledger and lifecycle boundary, not an execution engine.

## 3. Inherited non-negotiable contracts

### 3.1 Authority and identity

- Codex remains the sole authority. Worker, observer, and system actors cannot
  create authoritative status or write a decision.
- Authentication is the Phase 4 database-backed `actor_tokens` resolver. The
  caller actor, role, capabilities, and `token_id` come from verified auth;
  `session_hint` is metadata and never grants permission.
- Phase 5 uses only the already approved `job:create` and `job:read`
  capabilities for its lifecycle surface. It must not add token scopes,
  capabilities, principals, or a second authentication system.
- `owner_actor_id` is derived from the verified caller where the contract
  requires it. It is never accepted as an authority override from request data.
- `codex_decide` remains the only path that can write an authoritative status.
  Phase 5 must not assign `authoritative_status`,
  `deciding_decision_id`, or an authoritative state directly.

### 3.2 Persistence and transactions

- SQLite remains the sole durable source of truth; no JSON registry, cloud
  store, Redis, Postgres, or second job store is introduced.
- Every mutating lifecycle operation uses `BEGIN IMMEDIATE` and commits the
  complete unit atomically.
- A failed validation, workspace check, idempotency conflict, or CAS check
  leaves no partial job, cycle, audit, or idempotency record.
- The Phase 3 T1–T8 protections and Phase 4 O-1/O-2 protections remain active.
  No application path may use `REPLACE`, destructive delete, or a conflict
  resolution write against durable rows.
- All mutation audit entries use the existing Phase 4 audit writer and verified
  session attribution. Phase 5 does not invent a parallel audit format.

### 3.3 Phase boundaries

Phase 5 may create and read job-lifecycle rows, but it must not activate:

- worker processes, worker adapters, NDJSON, `qa_dispatch`, or `run_report`;
- active lease issue, consumption, expiry, or worker report handling;
- evidence or artifact creation, path-jail file operations, or artifact hashing;
- reapers, retries, crash recovery, cancellation of live processes, or queues;
- Gemini/`agy`, browser/CDP, remote transport, cloud persistence, or dynamic
  registries;
- rate-limit, telemetry, worker-protocol, or deployment work assigned later.

Fixture rows may be used by tests only when they are isolated and do not create
production worker behavior.

## 4. Proposed Phase 5 deliverables

### WP-1 — Lifecycle contract and boundary lock

Record the final request/response/error contracts, state ownership, actor
permissions, pagination rules, and the exact relationship to `codex_decide`.
Resolve the two open API questions in §12 before implementation authorization.

### WP-2 — Input and domain validation

Define strict schemas for job specifications, identifiers, workspace, cycle
limits, deadlines, stale thresholds, filters, cursors, and idempotency keys.
Validation is bounded and deterministic; request text is data and never becomes
a command or a filesystem operation.

### WP-3 — Workspace admission policy

Validate `job_create.workspace` against the existing configured workspace-root
allowlist before inserting the job. The policy is described in §7 and must be
implemented once in a shared domain boundary rather than copied into MCP
handlers.

### WP-4 — Atomic job creation

Create the durable initial job row and its optional idempotency record in one
transaction. The row starts unambiguously non-authoritative and is attributable
to the verified principal session without persisting a bearer token.

### WP-5 — Job reads and bounded listing

Implement the read model for a single job and a stable, bounded cross-project
list. Reads must not leak data from a worker's lease scope and must not turn
future evidence/artifact ownership into a Phase 5 write path.

### WP-6 — Lifecycle and cycle coordination

Implement the lifecycle operations required by the approved state machine,
including the `CREATED` start path and `REPAIR` resume path if the public API
decision in §12 authorizes them. The implementation must call the existing
transition/transaction primitives and must not create a second state writer.

Cycle limits, `hard_max_cycles`, and no-auto-dispatch behavior are specified in
§8. Time-based stalling and process cleanup remain later-phase behavior.

### WP-7 — Lifecycle idempotency and CAS

Extend the Phase 4 transaction pattern to Phase 5 lifecycle mutations. A
same-actor, same-key, same-request replay returns the stored response. The same
key with a different request hash returns `IDEMPOTENCY_CONFLICT`. A stale
`expected_version` returns `STATE_CONFLICT` without changing durable state.

### WP-8 — MCP exposure and compatibility

Register only the exact Phase 5 surface approved by the final plan. Preserve
the common response envelope, server-generated `request_id`, HTTP/stdio auth
gates, localhost restrictions, body caps, and no unauthenticated `tools/list`.
No Phase 6+ tool may appear in the Phase 5 inventory.

### WP-9 — Verification and documentation

Add tests for the Phase 5 invariants and integration gates in §11, update only
the documents authorized by the final plan, and produce a reproducible review
report containing the exact base/head, changed paths, test commands, and scope
proof.

## 5. Proposed lifecycle API contracts

These contracts carry forward the existing architecture. They are proposals for
independent review, not implementation authorization.

### 5.1 `job_create`

Caller: verified `codex` principal with `job:create`.

Input:

```text
{
  title: string,
  spec: {
    objective: string,
    acceptance_criteria: string[],
    context?: string
  },
  workspace: string,
  max_cycles?: integer,
  deadline_at?: RFC3339 UTC timestamp,
  stale_after_s?: integer,
  idempotency_key?: UUID,
  session_hint?: string
}
```

Output:

```text
{
  job_id: string,
  state: "CREATED",
  authoritative_status: null,
  cycle: 0,
  max_cycles: integer,
  version: 1
}
```

The server generates `job_id`, `request_id`, and timestamps. The caller cannot
provide `owner_actor_id`, `state`, `authoritative_status`,
`deciding_decision_id`, `version`, or a worker identity. Creation is rejected
before any durable write if the workspace or specification is invalid.

### 5.2 `job_get`

Caller: verified Codex or observer with `job:read`; a worker may use the
architecture's later lease-scoped read rule only after Phase 6 owns that path.

Input:

```text
{
  job_id: string,
  include?: ["decisions" | "runs" | "evidence" | "artifacts"],
  cycle?: integer
}
```

The core Phase 5 result contains the job lifecycle fields, `version`, cycle,
workspace, and decisions that are already durable. The final plan must state
whether `runs`, `evidence`, and `artifacts` are rejected as future-owned
collections or returned read-only when fixture rows exist. Phase 5 must not
write those collections or bypass their later ownership boundaries.

### 5.3 `job_list`

Caller: verified Codex or observer with `job:read`.

Input:

```text
{
  state?: WorkflowState,
  authoritative_status?: AuthoritativeStatus | null,
  workspace?: string,
  updated_since?: RFC3339 UTC timestamp,
  limit?: integer,
  cursor?: opaque string
}
```

Output:

```text
{
  jobs: JobSummary[],
  next_cursor?: string
}
```

Listing is bounded, uses a stable server-defined ordering such as
`(updated_at, job_id)`, and uses an opaque cursor rather than unbounded OFFSET
pagination. The final plan must define whether a null-status filter means
explicit `NULL` or absence of a filter; it must not silently conflate them.

### 5.4 Lifecycle transitions

The approved state machine already defines `CREATED → IN_PROGRESS` (`start`)
and `REPAIR → IN_PROGRESS` (`resume`) under `job:create`, while Phase 4 owns
decision transitions and authoritative writes. Phase 5 must provide the
approved invocation surface for those two non-authoritative transitions, or
explicitly document that they are internal domain operations. It must not
invent a generic `set_status` operation.

## 6. Initial row and lifecycle semantics

### 6.1 Creation invariants

Every successful creation has:

- `state = CREATED`;
- `authoritative_status IS NULL`;
- `deciding_decision_id IS NULL`;
- `cycle = 0`;
- `version = 1`;
- an owner actor derived from verified authentication;
- a canonical, admitted workspace path;
- bounded, valid `max_cycles`, `deadline_at`, and `stale_after_s` values.

The existing T7/T8 database guards remain the final barrier against an already
authoritative insert, deletion, or replacement of the job ledger root.

### 6.2 Start, resume, and decision ownership

- `start` may move only `CREATED` to `IN_PROGRESS`.
- `resume` may move only `REPAIR` to `IN_PROGRESS` and must preserve the
  state-machine cycle semantics.
- Phase 5 may not write an authoritative status while performing either move.
- `FIX` and `RETEST` decisions remain Phase 4 `codex_decide` operations; the
  cycle increment must happen exactly once according to the existing transition
  table, not once in Phase 4 and again in Phase 5.
- `APPROVE` from a valid non-authoritative state remains a `codex_decide`
  operation. It is the integration route for the no-worker Phase 5 acceptance
  test.
- Phase 5 does not infer approval from a job's age, worker verdict, text,
  evidence, or absence of errors.

### 6.3 Time and cycle fields

Phase 5 validates and stores the existing `deadline_at`, `stale_after_s`,
`cycle`, and `max_cycles` fields. It does not run a clock-based reaper, kill a
process, mark a job `STALLED` because time passed, or perform retry scheduling.
Those behaviors belong to Phase 8 and require their own plan and authorization.

`max_cycles` is clamped to the configured `hard_max_cycles`; values beyond the
hard ceiling are rejected or normalized according to the final reviewed API
contract, never accepted as a principal override.

## 7. Workspace admission and path safety

`job_create` must realpath-resolve the requested workspace and prove strict
containment inside the configured allowlist. The current architecture allowlist
is `C:\AgentProjects` and `C:\SallaProjects`; the implementation must read the
existing configuration source rather than introduce a database allowlist.

The admission check must reject, at minimum:

- a configured root itself when the policy requires a project child;
- `..` escapes and sibling-prefix tricks such as `C:\AgentProjectsOther`;
- UNC paths and device paths such as `\\?\`;
- paths outside the configured roots, including `C:\Windows` and `C:\`;
- missing or non-directory targets;
- symlink/reparse traversal that defeats the containment proof;
- platform-specific case or separator variants that evade the boundary.

The canonical admitted path is stored in `jobs.workspace`. Phase 5 does not
write into the workspace, execute a command from it, inspect arbitrary files,
or treat workspace text as instructions. Artifact-root path jail remains a
Phase 7 concern.

## 8. Idempotency, CAS, and concurrency

### 8.1 Idempotency

For every mutating Phase 5 operation that accepts `idempotency_key`:

1. compute a canonical request hash from the validated semantic input;
2. look up `(actor_id, key)` inside the write transaction;
3. return the original response for the same hash;
4. return `IDEMPOTENCY_CONFLICT` for a different hash; and
5. store the response only in the same transaction as the lifecycle mutation.

The hash excludes untrusted transport decoration that has no semantic effect,
or the final reviewed contract must explain why it is included. A session hint
never creates a second idempotency namespace.

### 8.2 Optimistic concurrency

Every mutating operation that changes a job requires the current
`expected_version`. The update must include `WHERE job_id = ? AND version = ?`
and require exactly one changed row. A loser receives `STATE_CONFLICT` and the
transaction writes no decision, status, cycle, audit, or idempotency mutation.

Concurrent read operations are bounded and do not hold a write transaction.
Concurrent lifecycle mutations are serialized through SQLite's existing
single-writer transaction model.

### 8.3 Durable-row safety

Phase 5 uses ordinary `INSERT` for genuinely new jobs and controlled `UPDATE`
for the explicitly owned non-authoritative fields. It never uses `REPLACE`,
`INSERT OR REPLACE`, delete-and-reinsert, or a generic conflict-resolution
write against a durable job or idempotency row.

## 9. Error and response rules

The final implementation must use the existing response envelope:

```text
{ ok: true, data, request_id }
{ ok: false, error: { code, message, details }, request_id }
```

At minimum, the reviewed Phase 5 surface must distinguish:

- `INVALID_INPUT` — malformed or out-of-range request;
- `WORKSPACE_NOT_ALLOWED` — path cannot be admitted;
- `JOB_NOT_FOUND` — requested job does not exist;
- `AUTHORIZATION_DENIED` — verified actor lacks the required capability;
- `STATE_CONFLICT` — stale version, cycle, or lifecycle precondition;
- `IDEMPOTENCY_CONFLICT` — key reused for a different request;
- `UNSUPPORTED_COLLECTION` — a future-owned `job_get` collection is requested,
  if the conservative include policy is selected; and
- `INTERNAL_ERROR` — bounded safe failure without secret or raw SQL leakage.

Exact public error names must be reconciled with the existing repository error
taxonomy before implementation. Error wording is not an authority mechanism.

## 10. Audit and attribution

Phase 5 mutating operations use the Phase 4 audit writer in the same transaction
as the operation. A creation/start/resume event records the verified actor,
role, `session_token_id`, server request ID, job and cycle identifiers, action,
state change, result, and bounded redacted detail.

Read-only `job_get`/`job_list` calls may be audited according to the established
Phase 4 policy, but they must not become an alternate state writer. The client
cannot supply `actor_id`, `actor_role`, `session_token_id`, or an authoritative
result. `session_hint` may be recorded as untrusted metadata only.

No bearer token, plaintext secret, worker command, arbitrary workspace content,
or unbounded request text may be persisted in the job, idempotency, or audit
records.

## 11. Verification matrix

The final frozen plan must map each case to a test file and an observable
result. The initial target matrix is:

### 11.1 Contract and validation

- valid creation returns `CREATED`, null authoritative status, cycle 0, and
  version 1;
- empty/oversized title, objective, acceptance criteria, context, or identifiers
  are rejected before a write;
- malformed timestamps, negative values, excessive `max_cycles`, and invalid
  UUID idempotency keys are rejected or bounded as specified;
- caller-supplied owner, state, status, version, decision ID, or worker fields
  cannot alter the initial row;
- unknown state/status/filter/cursor values fail closed;
- all responses carry a server request ID and the common envelope.

### 11.2 Workspace boundary

- an allowed existing child directory is accepted;
- each configured root, the filesystem root, `C:\Windows`, and an outside
  directory is rejected;
- traversal, sibling-prefix, UNC, device-path, separator, and case variants
  cannot escape the allowlist;
- missing paths, files, symlinks, and reparse-point escapes are handled
  according to the reviewed policy;
- a rejected workspace leaves no job, audit, or idempotency row.

### 11.3 Reads and listing

- `job_get` returns the requested lifecycle record and `JOB_NOT_FOUND` is
  distinguishable;
- `job_list` enforces the maximum page size and returns a stable opaque cursor;
- filters compose deterministically and do not leak unrequested collections;
- null authoritative status is represented distinctly from an omitted filter;
- an observer can read only the approved surface and cannot mutate it;
- future-owned collections are rejected or read exactly as the final plan says,
  never silently activated.

### 11.4 Lifecycle, idempotency, and CAS

- only valid `start` and `resume` transitions are accepted;
- a stale version causes no durable mutation;
- same actor/key/same request replays the original response exactly;
- same actor/key/different request returns `IDEMPOTENCY_CONFLICT`;
- two concurrent writers produce one winner and one `STATE_CONFLICT`;
- max-cycle and hard-max-cycle bounds are enforced without auto-dispatch;
- `RETEST`/`FIX` cycle increments are not duplicated by Phase 5;
- a Phase 5-created job can reach `APPROVED` only through `codex_decide` and
  without worker rows or worker verdict authority.

### 11.5 Security and regression

- direct SQL T1–T8 and Phase 4 authority tests remain green;
- `tools/list` exposes only the exact reviewed Phase 5 additions plus existing
  tools, with no Phase 6/7/8 tools;
- HTTP and stdio retain bearer, localhost, Origin/Host, and body-cap gates;
- system/worker/observer actors cannot obtain `job:create` unless the approved
  capability model explicitly allows it;
- no plaintext token, secret, command, or unbounded input appears in logs or
  durable rows;
- Windows and POSIX `npm run ci` remain green, including build asset checks.

## 12. Open decisions and planning blockers

These are intentionally explicit. They must be resolved by the independent
review and Codex adjudication before implementation authorization.

### D-1 — Public start/resume surface (BLOCKING)

The architecture's state machine defines `start` and `resume`, while the
approved tool inventory names `job_create`, `job_get`, and `job_list` for the
Phase 5 job lifecycle but does not name `job_start` or `job_resume`. The final
plan must choose one of these and document its capability, input, audit event,
idempotency, and CAS contract:

- expose explicit reviewed lifecycle tools;
- make the operations internal domain calls with a separately documented
  caller; or
- revise the lifecycle contract so another already-approved operation invokes
  them without creating an authority bypass.

No implementation may guess this boundary.

### D-2 — `job_get` future-owned collections (BLOCKING)

The architecture describes `job_get` as a full picture with optional runs,
evidence, artifacts, and decisions, while Phase 6/7 own active worker and
evidence/artifact behavior. The final plan must choose whether Phase 5 rejects
future-owned collection requests, returns only already-durable read data, or
defers those include options until their owner phases. It must specify worker
row scoping and avoid creating a Phase 7 write path.

### D-3 — Workspace configuration source (CLOSED FOR PLANNING)

Use the existing configured roots and Phase 1 path-safety boundary. Do not add a
workspace table, remote URL feature, or user-controlled allowlist in Phase 5.

### D-4 — Time-based enforcement (CLOSED FOR PLANNING)

Phase 5 validates and stores deadline/stale fields; it does not run reapers,
perform automatic stalling, or kill processes. Enforcement belongs to Phase 8.

### D-5 — Stable list ordering (PROPOSED)

Use an opaque cursor over a deterministic `(updated_at, job_id)` ordering with a
bounded limit. The independent review may refine the encoding, but OFFSET-only
pagination and unbounded lists are not acceptable.

## 13. Explicit non-goals and later ownership

| Area | Owner | Phase 5 treatment |
|---|---|---|
| Authority decisions and authoritative status | Phase 4 | Reuse `codex_decide`; no second writer |
| Job creation, reads, cycles, lifecycle idempotency/CAS | Phase 5 | In scope here |
| Worker adapters, process runtime, NDJSON, QA dispatch | Phase 6 | Not implemented or registered |
| Active leases and worker reports | Phase 6 | Not implemented or consumed |
| Evidence and artifact writes/path jail | Phase 7 | Not implemented or activated |
| Reaper, retries, crash recovery, cancellation | Phase 8 | Fields may be read/stored; behavior deferred |
| Rate limits, telemetry, worker protocol, security docs | Phase 9 | Not part of this plan |
| Gemini, browser/CDP, cloud, remote MCP, tunnels | Post-V1/later | Explicitly excluded |

## 14. Implementation authorization gate

Implementation may be authorized only when all of the following are true:

1. D-1 and D-2 are resolved in the final reviewed plan.
2. The frozen planning snapshot is documentation-only and its exact base/head
   are recorded.
3. Independent architecture review reports no unresolved blocking finding, or
   Codex explicitly resolves each finding with evidence.
4. The implementation branch starts from the selected authoritative `main`
   SHA and contains no pre-existing Phase 5 source work.
5. The approved scope still excludes Phase 6–9 and post-V1 work.
6. Codex records the exact decision:

```text
AUTHORIZE PHASE 5 IMPLEMENTATION: YES
```

Until that line is issued in a separate authorization record:

```text
PHASE 5 IMPLEMENTATION AUTHORIZED: NO
```

## 15. Requested independent-review packet

When this plan is frozen, the independent reviewer receives exactly:

- `docs/PHASE5_PLAN.md` at its frozen commit;
- `docs/ARCHITECTURE.md` Revision 8 from the same snapshot;
- `docs/PHASE4_PLAN.md` and the Phase 4 closure record for context;
- the exact base SHA and the documentation-only changed-path list;
- an explicit instruction to review planning only, with no edits, code,
  migrations, tool registration, or implementation authorization.

The reviewer must classify each finding as blocking, non-blocking, or rejected,
and must not treat a planning review as permission to implement.

## 16. Current planning verdict

```text
PHASE 5 PLAN STARTED
PHASE 5 IMPLEMENTATION AUTHORIZED: NO
NEXT GOVERNANCE STEP: RESOLVE D-1/D-2, THEN FREEZE AND SUBMIT FOR INDEPENDENT ARCHITECTURE REVIEW
```
