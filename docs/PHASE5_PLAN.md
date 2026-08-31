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
- changes to Phase 3/4 history or the merged Phase 4 implementation, except
  for the narrowly scoped Phase 4 dependency amendment explicitly described in
  §6.2 and §12; that exception is available only after a separate Phase 5
  implementation authorization and this planning document itself authorizes
  nothing;
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
The independent review identified D-1 and D-2 as blocking; this corrected
baseline resolves both explicitly in §5 and §12. The later re-review identified
P5-15 as a boundary-representation problem; the corrected baseline also records
the exact, limited dependency exception in §6.2 and §12.

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
including the explicitly proposed `job_start` and `job_resume` surface in §5.
The implementation must call the existing transition/transaction primitives
and must not create a second state writer.

Cycle limits, `hard_max_cycles`, cycle-exhaustion behavior, and no-auto-dispatch
behavior are specified in §8. Time-based stalling and process cleanup remain
later-phase behavior.

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
`stale_after_s` is server-owned: it is populated from the explicit configured
default, is returned by `job_get`, and is not a caller-controlled creation
parameter. The configured default must be present and bounded; there is no
implicit unlimited or zero-value fallback.

### 5.2 `job_get`

Caller: verified Codex or observer with `job:read`. Worker access and
lease-scoped reads are deferred to Phase 6; Phase 5 grants no worker read path.

Input:

```text
{
  job_id: string,
  include?: ["decisions"],
  cycle?: integer
}
```

The core Phase 5 result contains the job lifecycle fields, `version`, cycle,
workspace, and decisions that are already durable. `runs`, `evidence`, and
`artifacts` are rejected with `UNSUPPORTED_COLLECTION` unconditionally. They
are not returned conditionally when fixtures happen to exist, and no worker
lease-scoping approximation is implemented in Phase 5. Their read/write
contracts remain with Phases 6 and 7.

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
`(updated_at DESC, job_id DESC)`, and uses an opaque cursor rather than
unbounded OFFSET pagination. The default page size is 50 and the maximum is
100. The cursor contains the last ordering key and a filter fingerprint; a
cursor cannot be reused with different filters. The existing indexes plus a
bounded sort satisfy this ordering; no new index is required by this plan.

When `authoritative_status` is omitted there is no status filter. When it is
explicitly `null`, the query selects rows whose status is SQL `NULL`. The two
cases are distinct and are covered separately by tests.

### 5.4 `job_start` and `job_resume`

The corrected plan resolves D-1 by proposing two explicit, non-authoritative
Phase 5 lifecycle operations. These are subject to independent review as part
of this plan; they are not implementation authorization.

Both operations use:

```text
Input:  { job_id, expected_version, idempotency_key?, session_hint? }
Output: { job_id, state, authoritative_status, cycle, version }
Caller: verified `codex` principal with `job:create`
```

`job_start` moves only `CREATED → IN_PROGRESS`. `job_resume` moves only
`REPAIR → IN_PROGRESS`. Both require `expected_version`, use the common
idempotency contract, emit a bounded audit action (`job.start` or
`job.resume`), and return `STATE_CONFLICT` for a stale version. These are
permanent V1 lifecycle operations, not temporary test scaffolding. Neither writes
an authoritative status, changes the cycle, creates worker rows, or dispatches
work. `job_resume` requires that the cycle increment from the preceding `FIX`
has already happened.

### 5.5 Lifecycle transition ownership

The approved state machine defines `CREATED → IN_PROGRESS` (`start`) and
`REPAIR → IN_PROGRESS` (`resume`) under `job:create`. Phase 4 owns all
`codex_decide` calls and remains the only application writer of authoritative
fields. Phase 5 owns the public lifecycle surface and invokes the existing
transition choke point; it must not invent a generic `set_status` operation.
The cycle-limit outcome is a deliberately scoped dependency amendment to that
same choke point, not a second writer or a Phase 5 direct state update.

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
- bounded, valid `max_cycles`, `deadline_at`, and the configured effective
  `stale_after_s` value.

The existing T7/T8 database guards remain the final barrier against an already
authoritative insert, deletion, or replacement of the job ledger root.

### 6.2 Start, resume, and decision ownership

- `job_start` may move only `CREATED` to `IN_PROGRESS`.
- `job_resume` may move only `REPAIR` to `IN_PROGRESS` and preserves the
  already-updated cycle.
- Phase 5 may not write an authoritative status while performing either move.
- `FIX` and `RETEST` decisions remain Phase 4 `codex_decide` operations; the
  Phase 4 decision transaction performs the cycle increment exactly once for a
  normal transition. `job_resume` never increments it again.
- `APPROVE` from a valid non-authoritative state remains a `codex_decide`
  operation. It is the integration route for the no-worker Phase 5 acceptance
  test.
- Phase 5 does not infer approval from a job's age, worker verdict, text,
  evidence, or absence of errors.

If a `FIX` or `RETEST` request would advance beyond `max_cycles`, the existing
`codex_decide` authority choke point records a non-authoritative
cycle-exhaustion transition to `STALLED` with `state_reason = max_cycles`.
That guard transition increments no cycle, creates no worker run, and leaves
`authoritative_status` unchanged. It is an explicit lifecycle guard, not a
time-based reaper and not a second Phase 5 state writer. The corresponding
shared transition clarification is recorded in `ARCHITECTURE.md` and must be
accepted before implementation.

The merged Phase 4 implementation at the planning base currently rejects this
condition with `INVALID_TRANSITION`; it does not yet contain the proposed
guard-selected outcome. Therefore the future Phase 5 implementation may make
one narrowly scoped dependency change to the existing Phase 4
`applyTransition`/`codex_decide` path, only after the explicit Phase 5
authorization gate. That change may add only the guard outcome described here
and its required audit handling; it may not rewrite Phase 4 history, redesign
authority, or add any other Phase 4 behavior. This exception is part of the
reviewed Phase 5 plan and is not active now.

### 6.3 Time and cycle fields

Phase 5 validates and stores the existing `deadline_at`, `stale_after_s`,
`cycle`, and `max_cycles` fields. It does not run a clock-based reaper, kill a
process, mark a job `STALLED` because time passed, or perform retry scheduling.
Those behaviors belong to Phase 8 and require their own plan and authorization.
The only Phase 5 cycle-exhaustion move is the explicit `FIX`/`RETEST` guard
described in §6.2; it is not automatic time enforcement.

`max_cycles` defaults to the configured bounded lifecycle default and is clamped
to the configured `hard_max_cycles` (default hard ceiling 10). Values beyond the
hard ceiling are rejected or normalized according to the final reviewed API
contract, never accepted as a principal override. The effective
`stale_after_s` comes from an explicit bounded configuration default, and a
missing or invalid default fails closed rather than becoming unlimited.

## 7. Workspace admission and path safety

`job_create` must realpath-resolve the requested workspace and prove strict
containment inside the configured allowlist. The current architecture allowlist
is `C:\AgentProjects` and `C:\SallaProjects`; the implementation must read the
existing configuration source rather than introduce a database allowlist.

The admission check must reject, at minimum:

- a configured root itself; a job must name an admitted child directory;
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

The canonical hash input is fixed and excludes transport decoration, server
generated IDs, timestamps, `session_hint`, and server-owned configuration
defaults:

- `job_create`: `{ operation, title, spec.objective,
  spec.acceptance_criteria, spec.context|null, canonical_workspace,
  max_cycles, deadline_at|null }`;
- `job_start`/`job_resume`: `{ operation, job_id, expected_version }`.

Keys are serialized in this documented order before hashing. A session hint
never creates a second idempotency namespace. `effective_stale_after_s` is
deliberately excluded: a valid replay returns the originally stored response
even if an operator later changes the server configuration. Configuration
changes do not invalidate an otherwise identical caller request.

### 8.2 Optimistic concurrency

Every mutating operation that changes an existing job requires the current
`expected_version`. The update must include `WHERE job_id = ? AND version = ?`
and require exactly one changed row. A loser receives `STATE_CONFLICT`; by
deliberate inherited policy, a failed CAS is not an accepted mutation and
writes no decision, status, cycle, audit, or idempotency row. The losing
session is not treated as authoritative and is not persisted as a successful
attempt.

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

- `INVALID_INPUT` — malformed or out-of-range request, including an invalid
  cursor or a cursor whose filter fingerprint does not match the request;
- `WORKSPACE_NOT_ALLOWED` — path cannot be admitted;
- `JOB_NOT_FOUND` — requested job does not exist;
- `AUTHORIZATION_DENIED` — verified actor lacks the required capability;
- `STATE_CONFLICT` — stale version, cycle, or lifecycle precondition;
- `IDEMPOTENCY_CONFLICT` — key reused for a different request;
- `UNSUPPORTED_COLLECTION` — `job_get` requests `runs`, `evidence`, or
  `artifacts`, which are unconditionally future-owned in Phase 5; and
- `INTERNAL_ERROR` — bounded safe failure without secret or raw SQL leakage.

These are the fixed Phase 5 public error codes. They are mapped into the
repository's existing response envelope; internal TypeScript error classes may
remain implementation details. `WORKSPACE_NOT_ALLOWED` and
`UNSUPPORTED_COLLECTION` are operation-level codes, not new capabilities or
database statuses. Error wording is not an authority mechanism.

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
- an invalid cursor or a cursor reused with different filters returns
  `INVALID_INPUT` and performs no read mutation;
- an observer can read only the approved surface and cannot mutate it;
- future-owned collections are rejected unconditionally with
  `UNSUPPORTED_COLLECTION` and never silently activated.

### 11.4 Lifecycle, idempotency, and CAS

- only valid `start` and `resume` transitions are accepted;
- a stale version causes no durable mutation;
- same actor/key/same request replays the original response exactly;
- same actor/key/different request returns `IDEMPOTENCY_CONFLICT`;
- two concurrent writers produce one winner and one `STATE_CONFLICT`;
- max-cycle and hard-max-cycle bounds are enforced without auto-dispatch;
- normal `FIX`/`RETEST` increments the cycle exactly once in the Phase 4
  decision transaction; `job_resume` does not increment it again;
- a `FIX`/`RETEST` request that would exceed `max_cycles` produces the explicit
  non-authoritative `STALLED(max_cycles)` guard transition and does not exceed
  the limit;
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

### 11.6 Invariant traceability and owner split

| Architecture invariant | Phase 5 proof | Later owner-phase proof |
|---|---|---|
| 21 — max-cycle bound | Prove `FIX`/`RETEST` at the limit yields the explicit `STALLED(max_cycles)` guard without increment or worker creation. | Phase 6 proves the `max_cycles+1` dispatch request is refused before worker/lease creation. |
| 22 — hard maximum | Prove `job_create` cannot set `max_cycles` above the configured `hard_max_cycles`; Phase 5 has no `job_amend` surface. | Later phases must preserve the same ceiling when dispatching or changing lifecycle state. |
| 24 — RETEST behavior | Prove the Phase 4 `RETEST` result is `IN_PROGRESS` at `cycle+1`, no Phase 5 auto-dispatch occurs, and `job_resume` does not add another increment. | Phase 6 proves a fresh explicit `qa_dispatch` is required and no implicit dispatch occurs. |
| 29 — workspace allowlist | Prove realpath containment, root/path rejection, canonical storage, and no write on rejection. | Later artifact/process phases must not weaken the admitted workspace boundary. |

This split is part of the acceptance contract: Phase 5 cannot claim to prove
worker/lease behavior owned by Phase 6, but Phase 5 must leave those later
preconditions explicit and testable.

## 12. Adjudicated review corrections and closed decisions

The independent review returned `NEEDS DOCUMENTATION CORRECTION`. Codex accepts
P5-01 through P5-10 and P5-13 as valid corrections, rejects P5-11, P5-12, and
P5-14 as non-findings, and records the following final planning decisions.

### D-1 — Public start/resume surface (RESOLVED)

Phase 5 proposes explicit `job_start` and `job_resume` operations. Options that
leave `start` internal with no Phase 5 caller are rejected because
`job_create` returns `CREATED` and `codex_decide(APPROVE)` cannot accept that
state. Both operations use `job:create`, `expected_version`, the common
idempotency contract, and the `job.start`/`job.resume` audit action. They are
non-authoritative and do not create worker activity.

### D-2 — `job_get` future-owned collections (RESOLVED)

Phase 5 accepts `include: ["decisions"]` only. Requests for `runs`, `evidence`,
or `artifacts` fail unconditionally with `UNSUPPORTED_COLLECTION`. Worker
lease-scoped filtering is deferred to Phase 6; Phase 5 provides no approximation
of it and no conditional fixture-dependent response shape.

### D-3 — Workspace configuration source (RESOLVED)

Use the existing configured roots and Phase 1 path-safety boundary. No workspace
table, remote URL feature, or user-controlled allowlist is added.

### D-4 — Time-based enforcement (RESOLVED)

Phase 5 validates and stores deadline/stale fields but does not run reapers,
perform time-based stalling, or kill processes. Those behaviors belong to
Phase 8. The only Phase 5 cycle-limit move is the explicit `FIX`/`RETEST`
guard-to-`STALLED` through the existing authority choke point.

### D-5 — Stable list ordering (RESOLVED)

Use `(updated_at DESC, job_id DESC)` with default limit 50 and maximum 100. An
opaque cursor carries the last ordering key and a filter fingerprint. Existing
indexes plus a bounded sort satisfy the contract; no new index is required.

### D-6 — Null filter semantics (RESOLVED)

An omitted `authoritative_status` means no status filter. An explicit JSON null
means `WHERE authoritative_status IS NULL`.

### D-7 — Public error taxonomy (RESOLVED)

The codes in §9 are the fixed Phase 5 envelope codes. Implementation-specific
error classes may map to them, but the public meanings and distinctions cannot
be changed without a reviewed plan amendment.

### D-8 — Idempotency hash membership (RESOLVED)

The exact semantic fields are fixed in §8.1. `session_hint`, request IDs,
server-generated identifiers, and timestamps are excluded; no implementation
may choose a different field set silently.

### D-9 — CAS-loss audit policy (RESOLVED)

The merged Phase 4 behavior is retained: a failed CAS returns `STATE_CONFLICT`
and writes no audit row or other durable mutation. The architecture annotation
in `ARCHITECTURE.md` reconciles the older wording that said the losing attempt
was audited. Accepted lifecycle mutations remain audited.

### D-10 — Cycle increment ownership (RESOLVED)

The Phase 4 `codex_decide` transaction increments `cycle` exactly once for a
normal `FIX` or `RETEST`. Phase 5 `job_resume` preserves that value. A limit
guard that would exceed `max_cycles` increments nothing and transitions the job
to non-authoritative `STALLED(max_cycles)` through the same existing choke
point.

### D-11 — Phase 5 invariant ownership (RESOLVED)

The traceability table below separates Phase 5 coverage from later owner-phase
coverage. No invariant is treated as fully proven merely because its later
runtime half is documented.

### D-12 — Cycle-limit transition representation and dependency authority (RESOLVED)

The transition table remains keyed by `(from_state, transition)`, but a rule may
contain an ordered guard selector that chooses exactly one outcome. The normal
`FIX`/`RETEST` outcome applies when `cycle + 1 <= max_cycles`; the
cycle-exhaustion outcome applies otherwise and moves to non-authoritative
`STALLED` without incrementing the cycle. This adds no state and no new
transition verb.

The merged Phase 4 code currently rejects the over-limit request, so the future
Phase 5 implementation is allowed one narrowly scoped dependency amendment to
the existing `applyTransition`/`codex_decide` choke point. The amendment is
authorized only by a later explicit Phase 5 implementation decision, must use
the selected guard outcome and existing transaction/audit path, and must not
rewrite history or change any other Phase 4 behavior. The current planning
snapshot contains no source change.

### D-13 — Invariant 21/22 split (RESOLVED)

Invariant 21 is split between the Phase 5 decision guard, which records
`STALLED(max_cycles)`, and the Phase 6 dispatch refusal, which occurs before
worker/lease creation. Invariant 22's Phase 5 proof is limited to the
`job_create` clamp; no `job_amend` operation exists in this surface.

### D-14 — `job.resume` audit action (RESOLVED)

`job.resume` is added to the audited-action catalogue as part of the same
proposed Phase 5 staging amendment as `job.start`. The action is bounded,
redacted, and emitted only for an accepted lifecycle mutation.

### D-15 — Server-owned idempotency inputs (RESOLVED)

The server-owned `effective_stale_after_s` value is excluded from the
`job_create` request hash. An identical replay therefore remains identical
across configuration changes and returns the originally stored response.

### D-16 — Cursor mismatch error (RESOLVED)

A malformed cursor or a cursor whose filter fingerprint does not match the
request returns `INVALID_INPUT` and performs no mutation.

### D-17 — Revision Delta and lifecycle permanence (RESOLVED)

`ARCHITECTURE.md` now labels the Phase 5 text as a proposed staging amendment,
names every touched section, documents the Phase 5 worker-read restriction,
and states that `job_start` and `job_resume` are permanent V1 lifecycle
operations if Phase 5 is approved, not temporary fixtures. The baseline tool
count and the proposed additions are distinguished explicitly.

### D-18 — Workspace-root rule (RESOLVED)

The configured workspace roots themselves are rejected unconditionally. A job
must name an admitted child directory under an existing configured root.

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

1. D-1 through D-18 are resolved in the final reviewed plan, including the
   corresponding `ARCHITECTURE.md` annotations for cycle outcomes, cycle
   ownership, the `job.resume` audit action, and CAS-loss auditing.
2. The frozen planning snapshot is documentation-only and its exact base/head
   are recorded.
3. Independent architecture review reports no unresolved blocking finding, or
   Codex explicitly resolves each finding with evidence.
4. The implementation branch starts from the selected authoritative `main`
   SHA and contains no pre-existing Phase 5 source work.
5. The approved scope still excludes Phase 6–9 and post-V1 work.
6. The public Phase 5 additions are limited to the reviewed lifecycle surface:
   `job_create`, `job_start`, `job_resume`, `job_get`, and `job_list`.
7. The narrowly scoped Phase 4 dependency amendment described in D-12 is
   treated as part of the Phase 5 implementation scope; no other Phase 4
   source change is permitted.
8. Codex records the exact decision:

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
INDEPENDENT REVIEW RESULT: NEEDS DOCUMENTATION CORRECTION
CODEX ADJUDICATION: CORRECTIONS ACCEPTED; D-1 THROUGH D-18 RESOLVED IN THIS SNAPSHOT
NEXT GOVERNANCE STEP: RE-FREEZE AND SUBMIT THIS CORRECTED DOCUMENTATION SNAPSHOT FOR TARGETED INDEPENDENT RE-REVIEW
```
