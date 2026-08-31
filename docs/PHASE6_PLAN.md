# AOM — PHASE 6 WORKER RUNTIME PLAN

> This document records the reviewed Phase 6 planning baseline and its current
> implementation boundary. The separate Codex authorization recorded below
> permits only the scoped source work on the implementation branch.

Date: 2026-08-31
Repository: `C:\AgentProjects\agent-orchestrator-mcp`
Planning branch: `codex/phase6-authority-plan`
Authoritative Phase 5/main base: `530e2441636e6517096b1319c4510b1e56626592`
Phase 5 reviewed implementation head: `4ba475005a0f6d0b9504e7dc82d71d88f23a27e8`
Phase 5 merge commit: `7d7c3f61a118c26d4da0347f6c3ceb9ec286d0ea`
Governing architecture: `docs/ARCHITECTURE.md` Revision 8, with the proposed
Revision 9 delta recorded in that document
Implementation authorization: **YES — Codex authorization recorded on the implementation branch**

## 0. Governance and authority

Codex remains the principal architecture and implementation authority. This
document records the Phase 6 planning baseline and governance boundary.
Independent review may identify blockers or required corrections, but it is
not itself permission to edit the repository or implement the plan.

The required sequence is:

```text
Codex Phase 6 planning
  -> documentation-only planning snapshot
  -> independent architecture review
  -> Codex adjudication of every finding
  -> documentation corrections, if required
  -> targeted re-review if a blocker caused substantive changes
  -> explicit: AUTHORIZE PHASE 6 IMPLEMENTATION: YES / NO
  -> separately frozen implementation branch
  -> staged implementation, tests, and reviews
  -> independent implementation review
  -> Codex final merge gate
  -> merge and post-merge closure
```

This plan and the separate Codex decision authorize only the scoped Phase 6
implementation on `codex/phase6-implementation`. They do not authorize any of
the following:

- database migrations or schema changes;
- Phase 7, Phase 8, Phase 9, or post-V1 behavior;
- remote worker or external integration work;
- deployment, remote synchronization, push, pull request, or merge;
- evidence or artifact writes;
- crash recovery, reaper loops, autonomous retries, or later-phase work.

The implementation branch is derived from the published Phase 5 `main`; the
approved planning documents were carried forward before source work began.

## 1. Verified baseline and inherited contracts

The current published baseline is Phase 5-complete and has no active Phase 6
worker surface. The current Phase 5 public lifecycle is exactly:

```text
job_create, job_start, job_resume, job_get, job_list
```

The existing authority operation remains `codex_decide`. A worker result is
never an authoritative job decision; only the existing Codex decision path may
write an authoritative milestone.

The current schema version is 6. The existing schema already contains
structural tables for `worker_runs`, `leases`, `evidence`, and `artifacts` in
the base schema. Their presence is not evidence that the corresponding
runtime behavior is active. Phase 6 must not silently activate evidence or
artifact behavior merely because those tables exist.

The current `worker_runs` structure already provides the following fields for
planning reuse: `run_id`, `job_id`, `cycle`, `worker_id`, `adapter`,
`request_json`, bounded run status, advisory `worker_verdict`, `failure_class`,
`exit_code`, `pid`, `usage_json`, `stderr_tail`, `attempt`, and lifecycle
timestamps. The current `leases` structure provides `lease_id`, `run_id`,
`job_id`, `cycle`, `actor_id`, `nonce`, `expires_at`, `consumed_at`, and
timestamps.

The current workflow states relevant to this plan are:

```text
IN_PROGRESS -> QA_RUNNING -> EVIDENCE_READY
REPAIR      -> QA_RUNNING -> EVIDENCE_READY
```

`QA_RUNNING` means that at least one run was admitted for the current cycle.
`EVIDENCE_READY` means that all admitted runs for the cycle are terminal and
await Codex consideration; it does not mean that a worker result is trusted or
authoritative.

The existing roles and capabilities are retained:

| Role | Existing relevant capability | Phase 6 responsibility |
|---|---|---|
| `principal` / Codex | `qa:request`, `job:read`, `job:decide` | Request dispatch, read runs, make the final decision |
| `worker` | `work:report`, bounded `job:read`/report-related capabilities | Execute an assigned run and report only against its run binding |
| `observer` | `job:read` | Read permitted run status; cannot dispatch or report |
| `system` | no public capability | Perform bounded mechanical settlement and runtime bookkeeping only |

HTTP and stdio remain two transports over the same server factory. Phase 6
must preserve that shared-factory rule and must not create a transport-specific
authority path.

## 2. Objective and success criterion

Phase 6 defines the smallest local worker-execution layer that can:

1. accept an explicit dispatch request from the existing Codex-controlled job
   workflow;
2. select only a server-owned registered worker definition;
3. execute a bounded local worker process through one controlled runtime;
4. exchange a strict, bounded NDJSON protocol;
5. bind each run to one job, cycle, worker actor, and single-use lease;
6. accept and durably settle a worker report;
7. move the non-authoritative job lifecycle to `EVIDENCE_READY` exactly once
   when the required runs are terminal; and
8. preserve the existing single decision-authority path.

The success criterion is:

> Workers may execute and report bounded facts or results, but a worker result
> can never decide, approve, reject, complete, or otherwise authoritatively
> settle a job.

## 3. Explicit scope boundary

### 3.1 In scope for this planning baseline

| Area | Phase 6 treatment |
|---|---|
| Worker registry | Server-owned, operator-configured local worker definitions |
| Adapter model | One generic local `process` adapter; pure planning plus one runtime owner |
| Process runtime | Bounded argv execution, cwd, environment, streams, timeout, termination |
| Worker protocol | Versioned NDJSON framing, message bounds, ordering, terminal rules |
| Dispatch | Atomic creation of runs and leases plus non-authoritative `QA_RUNNING` transition |
| Run lifecycle | Pending, running, terminal status, result normalization, settlement |
| Leases | Run-scoped, bound, expiring, single-use report authorization |
| Worker reports | One accepted terminal report or one deterministic duplicate response |
| Run status | Read-only status for permitted principal/observer callers |
| Failure handling | Spawn failure, malformed output, non-zero exit, timeout, and cancellation |
| Retry | Explicitly no autonomous job-level retry; fresh dispatch remains Codex-controlled |
| Concurrency | Dispatch CAS, report/settlement serialization, duplicate protection |
| Cross-platform behavior | Equivalent observable lifecycle rules on Windows and POSIX |
| Documentation and tests | Normative protocol, work-package traceability, stable test IDs |

### 3.2 Explicitly out of scope

- evidence persistence or `evidence_add` activation;
- artifact persistence, path handling, hashing, or `artifact_register`;
- external, cloud, browser, Gemini, or remote workers;
- remote MCP exposure or tunnels;
- worker administration or arbitrary command submission;
- a second authoritative decision path;
- autonomous job retries, reapers, orphan reconciliation, or restart recovery;
- general telemetry, rate-limit platforms, or deployment operations;
- Phase 7, Phase 8, Phase 9, or post-V1 behavior.

Run-level timeout and cancellation are in scope because they are required to
close a live process deterministically. Long-lived recovery after the
orchestrator itself restarts remains a later-phase concern.

## 4. Phase 6 architectural decisions

The following decisions are the proposed planning baseline. They are explicit
review targets, not implementation authorization.

### D6-01 — Reuse the existing schema-v6 run and lease structures

The initial Phase 6 implementation must reuse the existing `worker_runs` and
`leases` tables. No migration or schema-definition change is included in this
planning baseline. Existing `evidence` and `artifacts` tables remain dormant
and are not written by Phase 6.

If independent review demonstrates that an invariant cannot be represented by
the existing schema, implementation authorization must stop and the plan must
be corrected before any migration is proposed. A missing field may not be
silently added during implementation.

### D6-02 — Use a separate protected worker registry

Phase 5's protected `config.json` remains the source for Phase 5 workspace and
cycle settings. Phase 6 proposes a separate protected state-root file:

```text
<state_root>\workers.json
```

The registry is server-owned configuration, not a request payload and not an
MCP administration surface. It is loaded and validated before a Phase 6
transport is exposed. A missing, malformed, duplicated, disabled, or
incompatible worker definition fails closed for the relevant startup gate.

This separation prevents a worker executable policy from being silently added
to the Phase 5 lifecycle configuration and makes the Phase 6 registry a
separately reviewable artifact.

The exact schema is fixed in §5 below. Unknown top-level or worker-entry
properties are rejected; the registry is not an open-ended extension point.

### D6-03 — One generic local process adapter

The initial adapter identifier is `process`. The adapter is a pure planner; a
single `ProcessRuntime` owns process creation, stream handling, timeout,
termination, and result normalization.

The dispatch request names `worker_id` only. It never supplies an executable,
shell string, environment map, or arbitrary working directory. Those values
come from the registered worker definition.

### D6-04 — Two report delivery modes, one settlement function

The runtime supports two local delivery modes behind one normalized report
path:

1. `pipe`: the spawned process emits the terminal `result` on stdout using the
   worker protocol; the orchestrator settles it directly;
2. `mcp_pull`: a registered local worker receives an opaque run lease in its
   private start envelope and submits a terminal report through `run_report`.

Both modes call the same transaction-owned report settlement function. The
Codex caller never receives a lease. No remote worker or remote report endpoint
is part of this baseline. The exact pull-mode lease envelope, nonce binding,
and separate worker session rule are defined in
`docs/WORKER_PROTOCOL.md` §3.1; a report submits the complete envelope rather
than a caller-supplied binding or standalone nonce.

### D6-05 — Strict bounded NDJSON protocol

The normative contract is in `docs/WORKER_PROTOCOL.md`. The initial protocol
version is `1`. Each line is one UTF-8 JSON object. Phase 6 accepts only the
documented message types and only one terminal outcome. Evidence and artifact
payloads are not protocol fields in this phase.

### D6-06 — One run and one lease per dispatch request item

`qa_dispatch` accepts between 1 and 16 distinct registered worker requests.
Each item creates exactly one `worker_runs` row and one `leases` row in the
same transaction. A partial multi-worker dispatch is never observable.

### D6-07 — Existing run statuses are normative

The existing schema statuses are used without adding a new status:

| Status | Meaning in Phase 6 |
|---|---|
| `PENDING` | Durable run admitted; process not yet marked active |
| `RUNNING` | Process/runtime accepted the run and is active |
| `SUCCEEDED` | Valid terminal result and successful process completion |
| `FAILED` | Spawn, process, or explicit worker failure; `failure_class` explains it |
| `TIMEOUT` | Runtime deadline elapsed and process termination was attempted |
| `CANCELLED` | Explicit cancellation or controlled shutdown stopped the run |
| `MALFORMED` | Protocol could not produce one valid terminal result |
| `ORPHANED` | Reserved for later restart recovery; not activated by Phase 6 |

`worker_verdict` remains advisory and is limited to `PASS`, `FAIL`,
`INCONCLUSIVE`, or `NONE`. A failed, timed-out, cancelled, or malformed run
uses `NONE` unless a valid advisory result was already durably accepted under
the selected policy; it never creates an authoritative job outcome.

### D6-08 — Non-authoritative settlement is mechanical

When every run admitted for the current job/cycle is terminal, the orchestrator
performs the existing non-authoritative transition from `QA_RUNNING` to
`EVIDENCE_READY` exactly once. The settlement actor is the internal `system`
actor or a clearly equivalent runtime-owned transaction path; it has no public
decision capability.

`EVIDENCE_READY` means "runs are settled and available for Codex review." It
does not mean PASS, approval, evidence completeness, or job completion.

### D6-09 — No autonomous retry loop

Phase 6 does not retry a job or silently create another run after a failed,
timed-out, cancelled, or malformed attempt. A future retry is a new explicit
`qa_dispatch` request after Codex considers the current job state. The
existing `attempt` field remains visible for future ownership but is not used
to create an unbounded loop in Phase 6.

### D6-10 — Existing capability catalogue and authority path remain unchanged

Phase 6 reuses `qa:request`, `work:report`, and `job:read`. It does not add a
new capability and does not grant a worker `job:decide`. `codex_decide` remains
the only path that can create an authoritative job status.

### D6-11 — Cancellation is not a second decision path

There is no Phase 6 `job_cancel` or `run_cancel` authority tool. A Codex
`codex_decide(CANCEL)` remains the authoritative job-cancellation request. The
runtime may then stop live processes and settle their run rows as
`CANCELLED`, but a runtime stop never creates or changes an authoritative
decision by itself.

### D6-12 — Fixed protocol and runtime bounds

The proposed initial bounds are:

| Bound | Proposed value |
|---|---:|
| Dispatch items per `qa_dispatch` | 1–16 |
| Worker registry entries | 1–64 |
| NDJSON line size | 65,536 bytes |
| Total worker stdout | 4 MiB per run |
| Maximum protocol messages | 256 per run |
| Retained stderr tail | 65,536 bytes per run |
| Progress message text | 1,024 bytes |
| Default process timeout | 300,000 ms |
| Hard process timeout | 900,000 ms |
| Worker task text | 8,192 bytes |
| Worker parameter JSON | 32,768 bytes |

These values are reviewable constants. They must be represented in one
configuration/validation owner and may not be relaxed by a request field.

### D6-13 — Initial multi-run settlement rule

One dispatch may contain multiple runs. The job remains `QA_RUNNING` until
all runs from that dispatch for the current cycle reach a terminal status.
The final terminal report performs the one `QA_RUNNING` → `EVIDENCE_READY`
settlement in its transaction. Duplicate reports and concurrent final reports
must converge on one settlement and one corresponding audit event.

### D6-14 — Local-only pull reporting

`run_report` is a local control-plane ingress for a registered worker actor
with a valid run lease. It is not a general remote callback endpoint. The
implementation must not introduce a public bind address, tunnel, cloud worker,
or external callback registry as part of Phase 6.

### D6-15 — Cross-platform behavioral equivalence

The process adapter uses an argv array, never a shell command. The observable
rules are identical on Windows and POSIX: same bounds, status mappings,
terminal requirements, lease rules, and authority separation. Platform-specific
process-tree termination is an implementation detail behind the common
runtime contract.

### D6-16 — Exact worker-registry schema (RESOLVED)

The `workers.json` schema is now fixed for the planning baseline. Its exact
fields, types, bounds, and cross-field rules are defined in §5 and must be
implemented as a strict parser with no additional properties. The schema is a
precondition for implementation authorization and is no longer deferred to an
unspecified implementation decision.

## 5. Worker registry proposal

The `workers.json` document is strict and server-owned. The following is the
normative schema for the Phase 6 planning baseline:

```json
{
  "version": 1,
  "workers": [
    {
      "worker_id": "local-worker",
      "actor_id": "worker-local",
      "enabled": true,
      "adapter": "process",
      "delivery": "pipe",
      "executable": "C:\\AgentTools\\local-worker.exe",
      "argv_template": ["--mode", "worker"],
      "cwd_policy": "job_workspace",
      "environment_allowlist": ["LANG"],
      "default_timeout_ms": 300000,
      "hard_timeout_ms": 900000,
      "max_output_bytes": 4194304,
      "max_messages": 256
    }
  ]
}
```

The field schema is:

| Object | Field | Type and bounds |
|---|---|---|
| root | `version` | integer, exactly `1` |
| root | `workers` | array, 1–64 entries |
| worker | `worker_id` | string matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| worker | `actor_id` | string matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| worker | `enabled` | boolean |
| worker | `adapter` | string, exactly `process` |
| worker | `delivery` | string, `pipe` or `mcp_pull` |
| worker | `executable` | non-empty string, maximum 4,096 bytes; local absolute path |
| worker | `argv_template` | array of 0–32 strings, each maximum 1,024 bytes |
| worker | `cwd_policy` | string, exactly `job_workspace` |
| worker | `environment_allowlist` | array of 0–64 unique environment-name strings |
| worker | `default_timeout_ms` | integer from 1,000 through 900,000 |
| worker | `hard_timeout_ms` | integer from 1,000 through 900,000 |
| worker | `max_output_bytes` | integer from 1 through 4,194,304 |
| worker | `max_messages` | integer from 1 through 256 |

Every listed field is required. No root or worker-entry property outside this
table is allowed. The following rules are also normative:

- `worker_id` is unique and is the only worker selector accepted by dispatch;
- `actor_id` is unique within the registry and must resolve to an enabled actor
  with role `worker`;
- `adapter` must be a known adapter; the initial set contains only `process`;
- `delivery` is limited to `pipe` or local `mcp_pull`;
- `executable` must be a local absolute path with no UNC/device form or
  traversal segment; an enabled entry must resolve to an approved regular
  executable file at startup;
- executable and argument templates are operator-owned and never copied from
  the dispatch request;
- template substitution has a fixed allowlist of `{run_id}`, `{job_id}`, and
  `{cycle}` placeholders; task text and parameters are delivered through the
  private start envelope, not argv;
- shell interpretation is prohibited;
- each environment name must match `^[A-Za-z_][A-Za-z0-9_]{0,127}$`; the child
  environment is an explicit allowlist, not the parent environment;
- `cwd_policy = job_workspace` means the canonical admitted job workspace and
  no other directory;
- `default_timeout_ms <= hard_timeout_ms <= 900000`;
- `max_output_bytes <= 4194304` and `max_messages <= 256`;
- worker capabilities are checked against the existing catalogue and cannot
  include `job:decide`;
- disabled or invalid workers cannot be selected;
- worker configuration is read before transport exposure and is not changed by
  an MCP call in Phase 6;
- the file is UTF-8 JSON, has no comments, and is bounded to 256 KiB;
- registry validation is deterministic and fails closed on unknown fields,
  duplicate IDs, invalid actor bindings, invalid paths, or invalid bounds.

## 6. Worker lifecycle and transaction boundaries

### 6.1 Dispatch transaction

`qa_dispatch` performs the following as one `BEGIN IMMEDIATE` transaction:

```text
load job
assert caller is the verified Codex principal with qa:request
assert state is IN_PROGRESS or REPAIR
assert request cycle equals job cycle
assert expected_version equals job version
assert cycle < max_cycles
validate 1..16 distinct registered worker requests
insert one PENDING worker_runs row per request
insert one unconsumed lease per run
apply the non-authoritative dispatch transition to QA_RUNNING
append qa.dispatch and lease.issued audit rows
store/replay the idempotency response
COMMIT
```

The process is spawned only after commit. If a process cannot be started, its
run becomes `FAILED` with `failure_class = SPAWN_FAILED`; the dispatch
transaction is not retroactively rewritten and the job is never approved by
that failure.

### 6.2 Run start and process runtime

After dispatch commit, the runtime claims a `PENDING` run for execution and
records `RUNNING` with the server-generated run identity. It then:

1. builds an execution plan only from the registry and admitted job data;
2. starts the process with argv, explicit cwd, and explicit environment;
3. sends the private start envelope and closes or manages stdin according to
   the selected delivery mode;
4. parses stdout as bounded NDJSON and retains only a bounded stderr tail;
5. applies timeout or cancellation through the platform runtime;
6. normalizes exactly one terminal outcome; and
7. settles the run through the shared report transaction.

The process runtime never invokes `codex_decide`, selects a tool, chooses a
job state, or interprets worker text as an instruction.

### 6.3 Report settlement transaction

For a valid pipe result or `run_report` request, one immediate transaction:

```text
validate report envelope and bounded fields
validate run/job/cycle/worker binding
validate lease signature, expiry, and unconsumed state
consume the lease atomically
update the one run from its expected non-terminal state to terminal state
store advisory verdict/failure metadata only
append run.report or the bounded failure audit action
if all runs for the job/cycle are terminal:
  transition QA_RUNNING -> EVIDENCE_READY without authoritative status
  append one mechanical settlement audit action
store/replay the operation response
COMMIT
```

If lease consumption or the expected run-state update affects zero rows, the
operation returns a deterministic conflict or duplicate result and performs no
second mutation. A report for a wrong job, cycle, run, actor, expired lease, or
advanced job is rejected without changing the job or run.

### 6.4 Status reads

`run_status` is read-only. It returns bounded run metadata and never returns a
lease, executable definition, environment, raw stdout, or unbounded stderr.
The principal and observer may read permitted job/run status. A worker does not
receive a general cross-job run listing; its report response is sufficient for
its own terminal acknowledgement.

## 7. Lease model

Each admitted run receives one lease bound to `(lease_id, run_id, job_id,
cycle, actor_id, expires_at)`. The lease is the exact opaque, signed,
run-scoped envelope defined in `docs/WORKER_PROTOCOL.md` §3.1. It is not a
principal identity and it does not confer decision authority.

The database stores the existing lease metadata and `consumed_at`. The
existing local lease-key mechanism authenticates the envelope. Its canonical
payload includes the server-generated nonce, and the database value must match
the presented payload before consumption. The worker's transport session is
separate from the lease and is provisioned outside the dispatch request. The
implementation must not persist a reusable plaintext principal token in the
run or lease row.

Rules:

- a lease is created in the same transaction as its run;
- a lease has one worker actor and one run binding;
- an expired lease is rejected and retained for historical attribution;
- a consumed lease cannot settle a second report;
- a lease from another job, cycle, run, or worker actor is rejected;
- lease validation and consumption happen in the same write transaction as
  report settlement;
- a lease is never returned to the Codex dispatch caller;
- no lease operation writes `jobs.authoritative_status`.

## 8. MCP candidate surface

The following are proposed Phase 6 tools. They are not registered by this
planning branch.

### `qa_dispatch`

Caller: verified `codex` principal with `qa:request`.

Proposed input:

```text
{
  job_id,
  cycle,
  expected_version,
  requests: [
    { worker_id, task, params?, timeout_ms? }
  ],
  idempotency_key?,
  session_hint?
}
```

Proposed output contains only run identifiers, worker identifiers, initial
run statuses, cycle, `QA_RUNNING`, version, and a server-generated
`request_id`. It never returns a lease, command, environment, or raw worker
output.

### `run_report`

Caller: verified `worker` actor with `work:report` plus one valid unconsumed
lease for the bound run.

Proposed input:

```text
{
  lease,
  verdict: PASS | FAIL | INCONCLUSIVE,
  summary,
  usage?
}
```

The report contains no evidence or artifact collections in Phase 6. The
response identifies the run, terminal status, whether the report was accepted,
whether it was a deterministic duplicate, and a server-generated
`request_id`. It never contains an authoritative job status created from the
worker verdict.

### `run_status`

Caller: verified principal or observer with `job:read` for permitted jobs.

Proposed input: `{ job_id, cycle?, run_id? }`.

Proposed output contains bounded run summaries: `run_id`, `job_id`, `cycle`,
`worker_id`, status, advisory verdict, failure class, attempt, and lifecycle
timestamps. It does not expose executable policy, environment, lease material,
raw streams, or later-phase evidence/artifact data.

No worker-administration, arbitrary process-launch, evidence, artifact,
recovery, or second-decision tool is part of the Phase 6 baseline.

## 9. Protocol and process-runtime boundary

The normative wire contract is separated into `docs/WORKER_PROTOCOL.md` so
that a worker implementation can be reviewed without treating the architecture
document as an executable specification.

The process runtime must guarantee:

- argv-array invocation with no shell string;
- explicit cwd and environment allowlist;
- bounded stdin, stdout, stderr, line count, and message count;
- one documented start envelope and one terminal result;
- deterministic mapping for malformed, missing, timed-out, cancelled, and
  non-zero-exit outcomes;
- process-tree termination on Windows and process-group termination on POSIX;
- a bounded grace period followed by force termination;
- no inherited parent environment by default;
- no raw transcript persistence;
- no interpretation of worker text as a command, path, tool selection, or
  lifecycle decision.

The runtime is not a worker scheduler. It starts only the runs admitted by the
transaction and does not create an implicit queue, reaper, or autonomous retry
loop.

## 10. Persistence and audit treatment

### 10.1 Persistence decision

The planning baseline reuses schema-v6 `worker_runs` and `leases` without
migrations. `request_json` carries only a bounded normalized dispatch request;
it does not carry an executable shell string or unbounded worker output.

The existing `evidence` and `artifacts` tables are not written by Phase 6.
Worker summaries remain run metadata and do not become evidence records. A
later Phase 7 plan owns evidence/artifact admission and storage.

### 10.2 Idempotency and CAS

`qa_dispatch` uses the existing actor-scoped idempotency pattern and requires
`expected_version`. Reports use the lease binding plus a deterministic
operation key where the transport supplies one. A duplicate report is a
stable replay/duplicate response, not a second update.

Every job lifecycle mutation increments the job version through the existing
transaction path. A stale dispatch or stale settlement never creates a partial
run set, a second lease, or an authority decision.

### 10.3 Audit actions

Phase 6 proposes adding only the actions required to explain its lifecycle:

```text
qa.dispatch
run.start
run.report
run.failed
run.timeout
run.cancelled
run.duplicate_rejected
lease.issued
lease.consumed
lease.rejected
system.runs_settled
```

The exact action catalogue and detail bounds must be reconciled with the
existing audit writer during implementation review. Every action must preserve
the existing hash-chain, redaction, request-id, actor, run, job, and cycle
attribution rules.

## 11. Failure, timeout, cancellation, and retry semantics

| Event | Run result | Job result | Automatic retry |
|---|---|---|---|
| Worker cannot start | `FAILED / SPAWN_FAILED` | Remains non-authoritative; settles when all runs terminate | No |
| Valid result, exit 0 | `SUCCEEDED` with advisory verdict | May become `EVIDENCE_READY` after all runs settle | No |
| Non-zero exit | `FAILED` with bounded failure class | Non-authoritative only | No |
| Missing or malformed terminal message | `MALFORMED`, verdict `NONE` | Non-authoritative only | No |
| Runtime deadline | `TIMEOUT` | Non-authoritative only | No |
| Explicit job cancellation | `CANCELLED` for live runs | Existing `codex_decide(CANCEL)` owns job authority | No |
| Controlled shutdown | `CANCELLED` if termination is acknowledged | No automatic authority change | No |
| Duplicate report | Original terminal result, `duplicate=true` | No second job mutation | No |
| Stale/expired report | Rejected | No mutation | No |

The Phase 6 baseline deliberately prefers explicit re-dispatch by Codex over
hidden retries. Restart-time orphan recovery, stale-run reaping, and job-level
recovery are deferred to Phase 8.

## 12. Work packages and dependency order

| Package | Deliverable | Depends on |
|---|---|---|
| WP0 | Freeze Phase 6 scope, terms, authority boundary, and review packet | — |
| WP1 | Strict worker registry schema, loader, protection, and startup gate | WP0 |
| WP2 | Versioned NDJSON protocol schema and bounded parser contract | WP0 |
| WP3 | Run/lease repository contract reusing schema-v6 structures | WP0, WP1 |
| WP4 | Lease envelope, binding, expiry, single-use, and rejection contract | WP2, WP3 |
| WP5 | Pure process adapter planner and shared process runtime contract | WP1, WP2 |
| WP6 | Atomic `qa_dispatch` transaction and non-authoritative dispatch transition | WP3, WP4, WP5 |
| WP7 | Report normalization and atomic run settlement | WP2, WP3, WP4, WP6 |
| WP8 | Timeout, process failure, cancellation, and no-retry semantics | WP5, WP7 |
| WP9 | `qa_dispatch`, `run_report`, and `run_status` MCP registration | WP6, WP7, WP8 |
| WP10 | HTTP/stdio parity, actor visibility, and integration tests | WP9 |
| WP11 | Full regression, documentation traceability, independent review, and closure | WP1–WP10 |

No package is authorized to begin until the explicit Phase 6 implementation
decision is recorded after independent planning review.

## 13. Test and acceptance matrix

Stable test IDs are assigned now so the implementation report can map every
claim to evidence. The tests below are planned, not yet implemented.

### Registry and startup

| ID | Acceptance case |
|---|---|
| P6-REG-001 | Valid enabled process worker loads from the protected registry |
| P6-REG-002 | Missing registry fails the Phase 6 startup gate |
| P6-REG-003 | Malformed registry fails closed |
| P6-REG-004 | Duplicate worker IDs are rejected |
| P6-REG-005 | Unknown adapter or delivery mode is rejected |
| P6-REG-006 | Missing/disabled/non-worker actor binding is rejected |
| P6-REG-007 | Worker capability set cannot include `job:decide` |
| P6-REG-008 | Request-supplied executable, cwd, or environment is ignored/rejected |
| P6-REG-009 | Worker path and cwd policy are bounded to the approved local policy |

### Protocol and runtime

| ID | Acceptance case |
|---|---|
| P6-PRO-001 | Valid start/ready/result sequence produces one successful run |
| P6-PRO-002 | Progress is bounded and non-terminal |
| P6-PRO-003 | Valid PASS, FAIL, and INCONCLUSIVE results remain advisory |
| P6-PRO-004 | Malformed JSON produces `MALFORMED` and no success |
| P6-PRO-005 | Unknown message type is rejected deterministically |
| P6-PRO-006 | Oversized line is rejected without unbounded buffering |
| P6-PRO-007 | Message-count or total-output cap is enforced |
| P6-PRO-008 | Missing terminal result produces `MALFORMED`/`NONE` |
| P6-PRO-009 | Duplicate terminal result is rejected without a second settlement |
| P6-PRO-010 | Non-zero exit maps to bounded `FAILED` metadata |
| P6-PRO-011 | Timeout terminates the process tree/group and maps to `TIMEOUT` |
| P6-PRO-012 | Explicit cancellation terminates the process and maps to `CANCELLED` |
| P6-PRO-013 | stderr retention is bounded and never replaces the primary result |
| P6-PRO-014 | Parent environment is not inherited beyond the allowlist |
| P6-PRO-015 | Windows and POSIX runtime mappings satisfy the same observable contract |

### Dispatch and state lifecycle

| ID | Acceptance case |
|---|---|
| P6-DIS-001 | Eligible `IN_PROGRESS` job dispatches one registered worker |
| P6-DIS-002 | Eligible `REPAIR` job dispatches one registered worker |
| P6-DIS-003 | Wrong job state is refused before run/lease creation |
| P6-DIS-004 | Wrong cycle is refused before run/lease creation |
| P6-DIS-005 | Stale job version is refused with no partial rows |
| P6-DIS-006 | Cycle at `max_cycles` is refused before run/lease creation |
| P6-DIS-007 | Unknown or disabled worker is refused |
| P6-DIS-008 | Duplicate worker IDs in one dispatch are refused |
| P6-DIS-009 | Multi-run dispatch creates all rows or none |
| P6-DIS-010 | Dispatch idempotency replays the original bounded response |
| P6-DIS-011 | Dispatch moves the job to `QA_RUNNING` without authority status |
| P6-DIS-012 | Process spawning occurs only after dispatch commit |

### Lease and report settlement

| ID | Acceptance case |
|---|---|
| P6-LSE-001 | Lease binds exactly to run, job, cycle, and worker actor |
| P6-LSE-002 | Wrong job/cycle/run binding is rejected |
| P6-LSE-003 | Wrong worker actor is rejected |
| P6-LSE-004 | Expired lease is rejected without mutation |
| P6-LSE-005 | Consumed lease cannot be reused |
| P6-LSE-006 | Lease consumption and run update are atomic |
| P6-LSE-007 | Lease material is never returned by `qa_dispatch` |
| P6-REP-001 | Valid worker report settles one run |
| P6-REP-002 | Worker report cannot write authoritative job status |
| P6-REP-003 | Duplicate report returns deterministic duplicate response |
| P6-REP-004 | Report after job/cycle advancement is rejected |
| P6-REP-005 | Report for a missing run is rejected |
| P6-REP-006 | Final required report moves `QA_RUNNING` to `EVIDENCE_READY` once |
| P6-REP-007 | Partial terminal reports leave the job in `QA_RUNNING` |
| P6-REP-008 | A failed/timeout/malformed run still settles non-authoritatively |
| P6-REP-009 | Concurrent final reports create one settlement only |

### MCP actor and transport surface

| ID | Acceptance case |
|---|---|
| P6-MCP-001 | Principal sees exactly the approved Phase 6 additions plus prior tools |
| P6-MCP-002 | Observer sees `run_status` but not dispatch or report mutation tools |
| P6-MCP-003 | Worker sees only the report path permitted by its lease |
| P6-MCP-004 | Worker cannot call `codex_decide` or any principal-only operation |
| P6-MCP-005 | HTTP and stdio expose the same Phase 6 schemas and visibility |
| P6-MCP-006 | All responses carry server-generated request IDs |
| P6-MCP-007 | Lease, executable, environment, and raw stream data are not leaked |
| P6-MCP-008 | No Phase 7/8/9 tools appear in the Phase 6 inventory |

### Concurrency, cancellation, and regression

| ID | Acceptance case |
|---|---|
| P6-CON-001 | Concurrent dispatch CAS permits one winner |
| P6-CON-002 | Concurrent reports do not double-consume a lease |
| P6-CON-003 | Report racing with Codex cancellation has one deterministic winner |
| P6-CON-004 | Replayed idempotency key never duplicates runs or audits |
| P6-CON-005 | SQLite transaction failure leaves no partial dispatch/settlement |
| P6-CON-006 | Multiple runs settle only after the last terminal outcome |
| P6-REG-010 | Entire Phase 1–5 regression suite remains green |
| P6-REG-011 | Schema version and canonical definitions remain unchanged in the no-migration baseline |
| P6-REG-012 | Existing `codex_decide` authority tests remain green and sole-writer proof remains intact |

### Scope and governance

| ID | Acceptance case |
|---|---|
| P6-SCP-001 | No evidence or artifact write path is introduced |
| P6-SCP-002 | No remote/cloud/browser/Gemini integration is introduced |
| P6-SCP-003 | No reaper, restart recovery, or autonomous retry loop is introduced |
| P6-SCP-004 | No migration or schema change appears unless separately approved after review |
| P6-SCP-005 | Every implementation claim maps to a work package and test ID |
| P6-GOV-001 | Independent review is completed before implementation authorization |
| P6-GOV-002 | Exact implementation head is independently reviewed before merge |

## 14. Required documentation artifacts

The documentation-only Phase 6 planning snapshot consists of:

1. `docs/PHASE6_PLAN.md` — this plan, including scope, decisions, packages,
   tests, and gates;
2. `docs/WORKER_PROTOCOL.md` — the normative bounded NDJSON contract;
3. `docs/ARCHITECTURE.md` — the proposed Revision 9 Phase 6 delta, explicitly
   marked as proposed and not implementation authorization;
4. `README.md` — status-only update identifying Phase 6 as planning-only.

The same snapshot carries status-only reconciliation in
`docs/PHASE5_PLAN.md` and `docs/PHASE5_IMPLEMENTATION_REPORT.md`. Those two
files are included for provenance and Phase 5 closure context; they introduce
no Phase 6 design or source behavior.

The snapshot must also record the exact Phase 5 base SHA, the planning branch,
the changed-path set, the persistence decision, the actor boundary, the
candidate MCP surface, and the explicit `PHASE 6 IMPLEMENTATION AUTHORIZED:
NO` status.

No source file, migration, schema definition, package manifest, or MCP tool
registration is part of this planning snapshot.

## 15. Risks and pre-implementation gates

There is no blocker to preparing this planning baseline. The following are
implementation gates that must be resolved during independent review and Codex
adjudication:

1. confirm that schema-v6 `worker_runs` and `leases` can represent every
   approved invariant without a migration;
2. verify that the strict `workers.json` schema in §5 is implemented without
   widening it or moving executable policy into Phase 5 `config.json`;
3. approve the two local report delivery modes and their lease handoff;
4. approve exact protocol bounds and malformed-output behavior;
5. approve whether progress is runtime-only and non-durable;
6. approve the multi-run final-settlement rule;
7. approve cancellation interaction with `codex_decide(CANCEL)`;
8. approve the no-autonomous-retry policy;
9. approve the exact audit action catalogue and actor attribution;
10. verify equivalent Windows/POSIX process termination semantics;
11. verify that Phase 7 evidence/artifact ownership remains untouched.

The former F-01 schema deferral is closed by D6-16 in this documentation-only
amendment. Because the planning snapshot changed after the independent review,
the corrected snapshot requires a targeted independent re-review before final
Codex adjudication.

Any unresolved item that changes authority, persistence, or phase ownership is
blocking for implementation authorization. Planning may continue while the
independent reviewer records the item, but implementation may not begin until
Codex adjudicates it.

## 16. Independent-review packet and decision sequence

The independent reviewer should receive exactly this planning snapshot:

- `docs/PHASE6_PLAN.md`;
- `docs/WORKER_PROTOCOL.md`;
- `docs/ARCHITECTURE.md` with the proposed Revision 9 delta;
- `README.md` status context;
- `docs/PHASE5_PLAN.md` and `docs/PHASE5_IMPLEMENTATION_REPORT.md` for the
  synchronized Phase 5 closure context;
- the exact base SHA `530e2441636e6517096b1319c4510b1e56626592`;
- the exact documentation-only changed-path list;
- an instruction to review planning only, with no edits, implementation,
  migration, tool registration, push, PR, or merge.

The reviewer must classify each finding as blocking, non-blocking, or rejected,
and must distinguish facts verified from the snapshot from assumptions that
remain unverified. The reviewer must not issue implementation authorization.

After review, Codex adjudicated every finding, closed F-01 through the
documentation correction, and issued the following separate decision for the
implementation branch:

```text
AUTHORIZE PHASE 6 IMPLEMENTATION: YES
```

## 17. Current implementation status

```text
PHASE 5 BASELINE: COMPLETE AND PUBLISHED
PHASE 6 PLANNING BASELINE: REVIEWED AND ADJUDICATED
PHASE 6 IMPLEMENTATION AUTHORIZED: YES — Codex decision recorded
PHASE 6 IMPLEMENTATION: IN PROGRESS ON codex/phase6-implementation
PHASE 6 IMPLEMENTATION BRANCH: NOT MERGED
PHASE 7 STARTED: NO
```

**PHASE 6 IMPLEMENTATION AUTHORIZED — SOURCE WORK IN PROGRESS**
