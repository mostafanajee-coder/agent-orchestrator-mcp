# AOM — Phase 8 Resilience and Recovery Plan

> **Status: approved planning baseline with separately authorized implementation.**
> This document remains the Phase 8 scope and review contract. Its implementation
> authorization is recorded separately below and is limited to
> `codex/phase8-implementation`; it does not authorize deployment, Push, PR
> creation, or Merge.

## 1. Authority, baseline, and purpose

This plan is derived from the authoritative Phase 7-published `main` after the
Windows artifact-root correction and its documentation closure.

| Item | Verified value |
|---|---|
| Authoritative base branch | `main` |
| Authoritative base commit | `d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3` |
| `origin/main` | `d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3` |
| Base tree | `471c197bee3855fc210e2ab0adf77ce1f30815c7` |
| Working tree at planning start | clean |
| Phase 7 reviewed implementation head | `035fbb6f3de5588c420b153c6d47497e326340e0` |
| Phase 7 Windows correction | `bf789157619a0ec39486f451405e190ad5209d14` |
| Phase 7 reviewed head ancestor of base | yes |
| Phase 8 implementation | merged locally into `main` at `130d698` |

The previous Phase 8 proposal referenced `5b0aa1824f567d1369451c57193f8cbd465ed4ac`.
That value predates the Windows path-normalization fix and the final Phase 7
documentation closure. All Phase 8 comparisons and handoff references use
`d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3` instead.

Phase 8 is the smallest resilience layer around the completed Phase 5–7
lifecycle. Its governing invariant is:

> **Recovery may stop, orphan, cancel, or stall work; it may never decide the job.**

The existing Codex decision path remains the only path that can create an
authoritative job outcome.

## 2. Current v7 facts that constrain the plan

The planning baseline contains the following relevant structures. These facts
are the starting contract for independent review; implementation must verify
them again on the frozen planning snapshot.

| Existing fact | Phase 8 consequence |
|---|---|
| Job states include `QA_RUNNING`, `STALLED`, and terminal authoritative states. | Recovery may enter the existing non-authoritative `STALLED` state, but may not write an authoritative status. |
| Jobs contain `deadline_at`, `stale_after_s`, and `updated_at`, with indexes supporting state/time scans. | Staleness is evaluated from the job record; the plan does not invent a `worker_runs.updated_at` column. |
| Run statuses include `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMEOUT`, `CANCELLED`, `MALFORMED`, and `ORPHANED`. | Phase 8 uses the existing run vocabulary. No new run status is implicitly added. |
| Runs contain `started_at`, `ended_at`, `created_at`, process identity, and deadline information available through the joined job/runtime record. | Recovery records terminal runtime outcomes without adding a second status vocabulary. |
| Leases contain `expires_at` and nullable `consumed_at`, with one lease per run. | Lease usability is derived from expiry, consumption, current binding, and run status; `EXPIRED` is not a new persisted lease status. |
| `audit_log` is append-only, hash-chained, and indexed by `(job_id, seq)` and `(session_token_id, seq)`. | Recovery actions are audited; query filters must remain compatible with these indexes or be explicitly deferred. |
| Public capabilities currently have no `audit:read` capability, and no `audit_query` tool is active. | The initial proposal does not add a capability silently. `audit_query` is principal-only unless review approves a separately specified observer policy. |
| Phase 7 explicitly leaves recovery, reaping, pruning, and broad retries to Phase 8. | No Phase 7 redesign is performed and no automatic retry scheduler is introduced. |

## 3. Scope and invariants

### 3.1 In scope

Phase 8 may define and later implement:

1. Startup reconciliation of durable active runs left by a previous process.
2. A single per-process reaper for bounded stale-state reconciliation.
3. Orphan handling and deterministic rejection of late reports.
4. Mechanical settlement after an already-authorized job cancellation.
5. Bounded graceful shutdown for owned worker processes.
6. Mechanical entry into the existing non-authoritative `STALLED` state.
7. One bounded, read-only `audit_query` MCP operation.
8. Shared HTTP/stdio startup, recovery, and shutdown semantics.
9. Tests for races, idempotency, limits, redaction, and Phase 4–7 regressions.

### 3.2 Non-negotiable invariants

- Recovery never approves, rejects, completes, delivers, or cancels a job.
- `codex_decide` remains the only authoritative decision writer.
- The `system` actor has no public capability and no transport token.
- A terminal run never returns to an active state.
- A recovered or terminal run cannot be revived by a late worker report.
- A lease that is expired, consumed, mismatched, or attached to a terminal run
  is unusable and cannot settle evidence, artifacts, or a run.
- Every run/lease/job recovery unit is atomic within one SQLite immediate
  transaction, or produces no partial lifecycle mutation.
- Recovery is state-idempotent; repeating it creates no duplicate transition.
- Shutdown is not recorded as an authoritative job cancellation.
- No automatic replacement run, retry cycle, or fresh dispatch is created.
- HTTP and stdio expose the same authorization and lifecycle semantics.
- Responses and errors remain bounded and contain no secrets, stacks, raw
  bearer/lease material, or unrestricted worker output.

## 4. Explicit exclusions

The following remain outside Phase 8:

- New evidence or artifact models, artifact byte reads, retention, pruning, or
  deletion of durable evidence/artifact metadata.
- Remote, cloud, browser, or external worker integrations.
- A general retry, backoff, queue, circuit-breaker, or distributed scheduler.
- Autonomous job decisions or any second authoritative decision path.
- A general telemetry, metrics, observability, export, or reporting platform.
- Backup/restore, database maintenance, multi-machine recovery, or deployment.
- General rate-limit redesign.
- Phase 9 hardening/documentation work except for the explicit phase boundary.

Phase 8 may append bounded audit records for its own mechanical actions. That
does not create a telemetry subsystem.

## 5. Recovery lifecycle contract

### 5.1 Startup ordering

Every service start must perform, in order:

1. Existing filesystem, database, migration, schema, audit-chain, and
   authority/integrity gates.
2. Phase 8 startup reconciliation of durable active runs.
3. Audit of the reconciliation result.
4. Only after successful fail-closed reconciliation, expose HTTP or stdio.

No transport may accept MCP work while the runtime is partially recovered.

### 5.2 Orphan recovery

At startup, a run in `PENDING` or `RUNNING` that cannot belong to the new
process instance is reconciled to the existing terminal `ORPHANED` status.
The transition records `ended_at` and a bounded audit detail identifying the
recovery reason. It does not adopt, reconnect to, or silently trust the old
process.

For an affected `QA_RUNNING` job, if the interrupted run makes the cycle
ambiguous, the job moves to `STALLED` with a bounded reason such as
`orphaned_runs`. This is a workflow holding state and is not an authoritative
result.

The lease remains retained for auditability. It becomes unusable through the
existing eligibility rule because its run is terminal; recovery does not invent
an `expired` lease row or rewrite `consumed_at` merely to label expiry.

### 5.3 Reaper

One logical reaper runs per service instance. Each tick is bounded to at most
100 candidates and uses immediate transactions with state/CAS conditions.
Candidates beyond the bound wait for a later tick.

The reaper may reconcile:

- a run whose effective deadline has elapsed;
- an expired lease together with its still-active bound run, so the run is
  terminalized conservatively and the lease cannot remain reportable;
- a job whose `updated_at` is older than its `stale_after_s` policy while it
  remains in an active lifecycle state;
- runtime ownership that has disappeared;
- mechanically inconsistent active run/job state that can be resolved safely.

The plan must distinguish job staleness (`jobs.updated_at`) from run start/end
timestamps. It must not assume a nonexistent `worker_runs.updated_at` field.

The reaper may terminate/settle a run, invalidate its lease eligibility, append
an audit event, and move an affected job to `STALLED`. A deadline/lease expiry
uses `TIMEOUT`; lost ownership uses `ORPHANED`. It may not create a new run,
increment a cycle, or call an authoritative decision transition.

The proposed default tick interval is 30 seconds. It is an operational policy,
not an authority invariant, and remains configurable only within bounded
implementation limits.

### 5.4 Run states and late reports

The plan uses only existing persisted run statuses:

| Condition | Run result | Job effect |
|---|---|---|
| Normal worker completion | existing normal terminal status | existing Phase 6/7 settlement |
| Deadline exceeded | `TIMEOUT` | `STALLED` only when the active cycle becomes unsafe/ambiguous |
| Already-authorized cancellation cleanup | `CANCELLED` | job remains `JOB_CANCELLED`; no new authority is created |
| Process ownership lost across restart | `ORPHANED` | active affected cycle moves to `STALLED` |
| Malformed or failed worker protocol | existing Phase 6 terminal status | existing non-authoritative settlement rules |

`ORPHANED`, `TIMEOUT`, and `CANCELLED` are existing run statuses, not new
migration values. Exact writes, `failure_class`, and audit action names must be
verified against the frozen source before implementation authorization.

A report arriving after terminalization is rejected without rewriting the run,
recreating a lease, adding duplicate evidence/artifacts, changing the job, or
creating an authoritative result.

### 5.5 STALLED

`STALLED` remains durable, visible to Codex, and non-authoritative. Phase 8 may
enter it mechanically for `orphaned_runs`, `stale`, `deadline`, or a bounded
recovery/cancellation-cleanup reason. Only the existing approved Codex
lifecycle rules may leave it. Phase 8 adds no recovery-specific authority path.

### 5.6 Cancellation completion

The existing Codex `CANCEL` decision commits the authoritative
`JOB_CANCELLED` outcome. Phase 8 owns only downstream mechanics:

```text
Codex cancellation → terminate live runs → terminal run state → lease unusable
```

If cleanup is interrupted, startup recovery completes the mechanical
settlement. The system actor never writes `JOB_CANCELLED` and never creates a
decision row.

### 5.7 Graceful shutdown

Shutdown must:

1. Stop admitting new dispatches and other mutating runtime work.
2. Allow in-flight MCP requests a bounded drain interval.
3. Request termination of owned worker processes.
4. Allow a bounded worker completion interval.
5. Reconcile unresolved owned runs conservatively as interrupted/orphaned
   runtime work, not as an authoritative cancellation.
6. Attempt persistence/WAL checkpoint and close only after lifecycle attempts.

The proposed default drain bound is 5 seconds and the hard maximum is 30
seconds. A shutdown cannot wait indefinitely. A worker that finishes during the
drain retains its valid normal terminal result; a worker that does not finish
is reconciled under the same fail-closed rules used after restart.

## 6. Persistence and transaction decision

### Proposed baseline: schema v7, no migration

No Phase 8 migration is proposed at this planning stage. The preferred design
uses the existing v7 fields and derived lease eligibility:

- `jobs.state`, `state_reason`, `deadline_at`, `stale_after_s`, `version`, and
  `updated_at` represent job recovery state and bounded reasons.
- Existing `worker_runs` statuses and timestamps represent terminal runtime
  outcomes.
- `leases.expires_at` and `consumed_at`, together with run/job binding and
  terminality checks, represent lease usability.
- Existing append-only `audit_log` records the recovery action and reason.

The no-migration decision is conditional, not permission to overload unrelated
fields. Before implementation authorization, the reviewer and Codex must
confirm that the exact recovery contract fits v7. If a required fact cannot be
represented without ambiguity, the plan must be revised and an additive
migration reviewed before any source implementation.

### Recovery transaction rule

One logical recovery event must be one atomic immediate transaction. For
example, a successful orphan recovery cannot leave a run terminal while its
lease remains independently reportable, and a successful stale transition
cannot be accompanied by a missing audit record. CAS/state predicates protect
against overwriting a report or decision that won the race.

## 7. Reaper ownership and concurrency

- The reaper is an internal runtime component acting as the `system` actor.
- Only one logical reaper is active per service instance.
- Each tick is finite, bounded, and repeatable.
- A second tick seeing already-terminal or already-reconciled rows performs no
  duplicate mutation.
- A report/reaper race is resolved by the first valid immediate transaction;
  the losing operation re-reads state and returns a bounded conflict/terminal
  result without overwriting newer data.
- Recovery never uses client idempotency keys and never advances `cycle`.
- Existing principal CAS/idempotency rules remain unchanged.

## 8. Proposed `audit_query` read surface

Phase 8 proposes exactly one new MCP operation: `audit_query`. It is inspection
only and is not an administration or repair operation.

### 8.1 Initial authorization decision

The conservative initial proposal is:

- verified Codex principal: allowed;
- worker: denied;
- system actor: no transport access;
- observer: not exposed in the initial contract because the current capability
  catalogue has no dedicated `audit:read` capability and cross-job audit scope
  is not yet defined.

Adding observer access, a new capability, or a cross-job policy is a review
decision and must not appear as an implementation-time assumption.

### 8.2 Bounded contract

- read-only, with no repair or mutation behavior;
- stable sequence ordering using an opaque cursor;
- default page size 100, maximum page size 200;
- no unrestricted result set or bulk export;
- supported filters initially limited to `job_id`, `session_token_id`, and a
  sequence cursor because those have existing index support;
- action/actor/time filtering is deferred unless the review establishes that it
  is bounded and efficient without a schema/index change;
- output contains selected structured metadata only and is redacted;
- no bearer, lease nonce, raw worker stream, stack trace, or unbounded detail;
- a bounded range-chain check may inspect the returned page plus its immediate
  predecessor anchor, but full-chain verification remains a startup concern;
- a broken chain is reported and never repaired by the query.

The final response schema and exact error names must be reconciled with the
project's existing MCP error conventions before implementation.

## 9. HTTP and stdio parity

Both transports must use the same Phase 8 factory and authorization semantics.
Startup recovery completes before HTTP bind or stdio protocol output. Shutdown
through either transport uses the same drain, termination, and reconciliation
owner. There is no HTTP-only reaper, stdio-only authority shortcut, or
transport-specific audit visibility rule.

## 10. Error and resource bounds

The implementation contract should map to existing project error conventions
and expose only bounded categories, including the semantic cases below:

- `STATE_CONFLICT`
- `RUN_ALREADY_TERMINAL`
- `LEASE_NOT_USABLE`
- `RECOVERY_IN_PROGRESS`
- `SERVICE_SHUTTING_DOWN`
- `INVALID_CURSOR`
- `QUERY_LIMIT_EXCEEDED`
- `AUTHORIZATION_DENIED`
- bounded internal/recovery failure

These names are planning labels until reconciled with the current domain error
types. Errors must not expose database SQL, local absolute paths, process
stacks, credentials, lease material, or unrestricted worker output.

Resource limits are fixed in the implementation plan, not delegated to workers:

- reaper batch: 100 candidates maximum per tick;
- audit page: 100 default, 200 maximum;
- shutdown drain: 5-second default, 30-second hard maximum;
- no recursive/unbounded rescan in one transaction;
- no unbounded audit detail or result export.

## 11. Work-package sequence

| WP | Scope | Dependency |
|---|---|---|
| WP0 | Freeze Phase 8 scope, invariants, exclusions, and authoritative base | none |
| WP1 | Verify schema-v7 sufficiency and exact v7 lifecycle vocabulary | WP0 |
| WP2 | Define startup ownership and reconciliation ordering | WP1 |
| WP3 | Define orphan/run/lease atomic reconciliation | WP2 |
| WP4 | Define bounded periodic reaper and stale/deadline rules | WP3 |
| WP5 | Define `STALLED` recovery integration and reason vocabulary | WP3 |
| WP6 | Define post-Codex cancellation completion | WP3 |
| WP7 | Define graceful shutdown and process-runtime coordination | WP3, WP6 |
| WP8 | Define principal-only bounded `audit_query` read model | WP1 |
| WP9 | Define shared HTTP/stdio startup and shutdown integration | WP2, WP7, WP8 |
| WP10 | Define races, CAS/idempotency, errors, redaction, and limits | WP4–WP9 |
| WP11 | Freeze the acceptance/regression matrix | WP10 |
| WP12 | Independent review package, Codex adjudication, and final plan freeze | WP11 |

The planning document alone does not authorize implementation. The separate
Codex authorization recorded in §14 permits the scoped implementation branch.

## 12. Acceptance and regression matrix

The corrected matrix contains **56 named cases**: 48 Phase 8 behavior cases
plus 8 regression/scope cases.

### Startup recovery — 7 cases

| ID | Case | Required result |
|---|---|---|
| P8-REC-01 | clean restart with no active runs | no lifecycle mutation |
| P8-REC-02 | restart with one previous active run | safely reconciled to `ORPHANED` |
| P8-REC-03 | restart with several active runs | each reconciled once |
| P8-REC-04 | previously terminal run | remains unchanged |
| P8-REC-05 | recovery updates run and lease eligibility | atomic result |
| P8-REC-06 | recovery interrupted/fails | no partially exposed service |
| P8-REC-07 | late report after recovered orphan | rejected without mutation |

### Job and `STALLED` — 5 cases

| ID | Case | Required result |
|---|---|---|
| P8-STL-01 | QA job loses active runtime on restart | job becomes `STALLED` |
| P8-STL-02 | recovery-generated `STALLED` state | remains non-authoritative |
| P8-STL-03 | system actor attempts authoritative outcome | refused/impossible |
| P8-STL-04 | repeated recovery | no duplicate transition |
| P8-STL-05 | principal subsequently handles `STALLED` job | existing authority path governs |

### Reaper — 6 cases

| ID | Case | Required result |
|---|---|---|
| P8-RPR-01 | expired active lease | reconciled once |
| P8-RPR-02 | stale active run/job | safely terminalized or stalled per frozen rule |
| P8-RPR-03 | already terminal run | ignored |
| P8-RPR-04 | more candidates than batch cap | bounded batch only |
| P8-RPR-05 | concurrent report races reaper | one valid outcome; no overwrite |
| P8-RPR-06 | two reaper ticks see same candidate | idempotent |

### Cancellation — 5 cases

| ID | Case | Required result |
|---|---|---|
| P8-CAN-01 | authoritatively cancelled job with live run | termination initiated |
| P8-CAN-02 | cancellation settlement completes | run terminal; lease unusable |
| P8-CAN-03 | crash during cancellation cleanup | startup recovery completes safe settlement |
| P8-CAN-04 | worker reports after cancellation settlement | rejected |
| P8-CAN-05 | mechanical cancellation path attempts authority | impossible/refused |

### Graceful shutdown — 6 cases

| ID | Case | Required result |
|---|---|---|
| P8-SHD-01 | shutdown with no active work | clean exit |
| P8-SHD-02 | shutdown with active worker | bounded termination sequence |
| P8-SHD-03 | worker completes during drain | normal terminal result retained |
| P8-SHD-04 | worker exceeds grace | conservatively reconciled |
| P8-SHD-05 | new dispatch during shutdown | refused |
| P8-SHD-06 | shutdown does not complete within bound | no indefinite wait |

### Audit query — 10 cases

| ID | Case | Required result |
|---|---|---|
| P8-AUD-01 | first bounded page | ordered, redacted results |
| P8-AUD-02 | cursor continuation | no duplicate/skip under stable ordering |
| P8-AUD-03 | limit above maximum | refused or frozen clamping rule |
| P8-AUD-04 | job filter | only matching rows |
| P8-AUD-05 | unauthorized worker query | denied |
| P8-AUD-06 | principal query | allowed |
| P8-AUD-07 | observer query | denied until separately authorized |
| P8-AUD-08 | range-chain check | bounded verification only |
| P8-AUD-09 | broken chain | reported, never repaired |
| P8-AUD-10 | sensitive audit detail | remains redacted |

### Transport parity — 4 cases

| ID | Case | Required result |
|---|---|---|
| P8-TRN-01 | HTTP startup recovery | completes before bind |
| P8-TRN-02 | stdio startup recovery | completes before protocol output |
| P8-TRN-03 | HTTP/stdio audit surface | same authorization and schema |
| P8-TRN-04 | shutdown through either runtime | same lifecycle semantics |

### Authority — 5 cases

| ID | Case | Required result |
|---|---|---|
| P8-AUT-01 | orphaning a run | never writes authoritative job status |
| P8-AUT-02 | reaper timeout | never decides job |
| P8-AUT-03 | graceful shutdown | never decides job |
| P8-AUT-04 | worker output during recovery | remains advisory |
| P8-AUT-05 | existing `codex_decide` path | remains sole authority writer |

### Regression and scope — 8 cases

| ID | Case | Required result |
|---|---|---|
| P8-REG-01 | full Phase 7 regression suite | green |
| P8-REG-02 | existing Phase 6 runtime behavior | preserved |
| P8-REG-03 | existing Phase 5 job lifecycle | preserved |
| P8-REG-04 | existing Phase 4 authority gates | preserved |
| P8-REG-05 | schema version | remains v7 if no migration approved |
| P8-REG-06 | Phase 9 source/features | absent |
| P8-REG-07 | remote/cloud functionality | absent |
| P8-REG-08 | automatic retry scheduler | absent |

## 13. Review findings the independent reviewer must answer

The review must explicitly assess:

1. Whether schema v7 represents every approved recovery outcome without
   abusing unrelated fields.
2. Whether `ORPHANED`, `TIMEOUT`, and `CANCELLED` semantics are consistent with
   the existing run implementation and audit vocabulary.
3. Whether lease invalidity can remain derived without a new persisted status.
4. Whether startup recovery and reaper transactions prevent report/recovery
   races and duplicate settlement.
5. Whether shutdown is clearly separated from authoritative cancellation.
6. Whether principal-only `audit_query` is sufficient and whether observer
   access must be separately designed.
7. Whether existing indexes support every proposed filter and cursor.
8. Whether all output, detail, page, batch, and shutdown bounds are enforceable.
9. Whether HTTP and stdio behavior remains identical.
10. Whether the Phase 9 boundary and no-retry/no-remote exclusions are explicit.

## 14. Governance sequence and authorization state

The required sequence is:

1. Codex prepares this documentation-only baseline from authoritative `main`.
2. Codex freezes the exact planning snapshot and records its commit, tree, and
   changed paths.
3. One independent architecture reviewer reads the exact snapshot and returns
   a complete read manifest plus finding-by-finding verdict.
4. Codex adjudicates every finding as accepted/blocking,
   accepted/non-blocking, rejected with rationale, or deferred to a named
   later phase.
5. Codex applies documentation-only corrections if required.
6. A targeted re-review is performed if a blocker materially changes the
   architecture.
7. Codex freezes the corrected planning baseline and separately decides:

   ```text
   AUTHORIZE PHASE 8 IMPLEMENTATION: YES / NO
   ```

8. Only an explicit `YES` permits creation of a separately frozen Phase 8
   implementation starting point from the then-authoritative `main`.
9. Implementation, full verification, independent implementation review, and
   final merge authorization are separate later gates.
10. Phase 9 planning cannot start automatically after a Phase 8 merge.

Codex has now recorded the required separate authorization:

```text
AUTHORIZE PHASE 8 IMPLEMENTATION: YES
IMPLEMENTATION BRANCH: codex/phase8-implementation
IMPLEMENTATION SCOPE: this plan only
MERGE/PUSH/DEPLOYMENT: NOT AUTHORIZED
```

At this planning snapshot:

```text
PHASE 7: COMPLETE, PUBLISHED, AND WINDOWS-FIXED
PHASE 8 PLAN: APPROVED PLANNING BASELINE
PHASE 8 IMPLEMENTATION: COMPLETE AND MERGED LOCALLY
PHASE 8 IMPLEMENTATION AUTHORIZED: YES
PHASE 8 REMOTE PUBLICATION: YES
PHASE 9: NOT STARTED
```

**PHASE 8 IMPLEMENTATION AUTHORIZED — SCOPE LIMITED TO THIS PLAN**
