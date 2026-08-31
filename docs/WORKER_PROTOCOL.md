# AOM — PHASE 6 WORKER PROTOCOL

> Proposed normative contract for Phase 6 only. This document is planning
> material; it does not activate a worker, register an MCP tool, or authorize
> implementation.

Version: **1**
Owner: Phase 6 worker-runtime planning
Repository: `C:\AgentProjects\agent-orchestrator-mcp`
Governing plan: `docs/PHASE6_PLAN.md`
Implementation authorization: **NO**

## 1. Purpose and boundary

The protocol carries a bounded task invocation to one registered local worker
and carries bounded progress or result messages back to the orchestrator. A
worker result is advisory runtime data. It is never a job decision and never
changes an authoritative job milestone.

Phase 6 protocol messages do not carry evidence or artifact collections. Those
payloads belong to later phases and must not be smuggled into a generic
`params`, `detail`, or free-form message field.

The protocol is intended for the generic local `process` adapter. External,
cloud, browser, and remote worker transports are outside this contract.

## 2. Framing

- Encoding is UTF-8 without a required byte-order mark.
- Each message is exactly one JSON object terminated by one LF byte. CRLF is
  accepted only as line framing and is normalized before parsing.
- A message must fit within **65,536 bytes**, including framing.
- A run may emit at most **256 messages** and **4 MiB** of stdout in total.
- Retained stderr is limited to **65,536 bytes** and is not parsed as protocol.
- JSON nesting, string, array, and object bounds are enforced by the parser.
- The parser never evaluates a field as a command, path, executable, tool
  name, or lifecycle transition.
- Unknown message types, malformed JSON, invalid field types, over-sized
  fields, and invalid ordering are protocol failures.

The implementation may terminate a noisy process early once a bound is
exceeded. It must retain a bounded diagnostic and settle the run as
`MALFORMED`, never as a successful result.

## 3. Private start envelope

The orchestrator sends one start envelope to the worker process. The envelope
is runtime input, not an MCP response to the Codex caller.

Proposed shape:

```json
{
  "type": "start",
  "protocol_version": 1,
  "run_id": "uuid",
  "job_id": "uuid",
  "cycle": 0,
  "worker_id": "local-worker",
  "task": "bounded task text",
  "params": {},
  "workspace": "C:\\AgentProjects\\example",
  "deadline_at": "2026-08-31T12:00:00Z"
}
```

The following rules apply:

- `run_id`, `job_id`, `cycle`, and `worker_id` are server-owned bindings;
- `task` and `params` originate from the admitted dispatch request but are
  bounded and normalized before delivery;
- `workspace` is the canonical admitted workspace, not an arbitrary path;
- `deadline_at` is server-derived and is not extended by the worker;
- a pull-mode process may receive an additional opaque run lease and local
  report endpoint in its private runtime envelope; that material is never
  returned to the Codex dispatch caller;
- the worker cannot change the binding by echoing different values.

The exact private-envelope representation is an implementation detail, but the
semantic bindings above are normative.

## 4. Worker-to-orchestrator messages

### 4.1 `ready`

Optional first response after `start`:

```json
{
  "type": "ready",
  "protocol_version": 1,
  "run_id": "uuid",
  "worker_id": "local-worker"
}
```

`ready` is non-terminal. Its identifiers must match the private start
envelope. A worker that emits `ready` more than once is malformed.

### 4.2 `progress`

Optional bounded non-terminal update:

```json
{
  "type": "progress",
  "seq": 1,
  "message": "bounded progress text"
}
```

Rules:

- `seq` is a positive integer strictly increasing within the run;
- `message` is at most **1,024 bytes**;
- progress is runtime-visible only in Phase 6 and is not persisted as evidence;
- progress cannot change the run status, job state, lease, or authority;
- progress after a terminal message is invalid.

### 4.3 `result`

Required terminal success-path message:

```json
{
  "type": "result",
  "verdict": "PASS",
  "summary": "bounded result summary",
  "usage": {
    "input_units": 10,
    "output_units": 20
  }
}
```

Rules:

- `verdict` is one of `PASS`, `FAIL`, or `INCONCLUSIVE`;
- `summary` is non-empty and at most **2,048 bytes**;
- `usage` is optional and contains only bounded numeric metadata;
- exactly one result is permitted;
- a valid result is accepted only if process/runtime completion rules also pass;
- a result is advisory and cannot change `authoritative_status`;
- `evidence`, `artifacts`, executable definitions, and arbitrary nested output
  are not valid result fields.

### 4.4 `error`

Optional terminal failure-path message:

```json
{
  "type": "error",
  "class": "MODEL_ERROR",
  "message": "bounded diagnostic"
}
```

The initial bounded failure classes are:

```text
SPAWN_FAILED
TRANSIENT
AUTH_REQUIRED
MALFORMED_OUTPUT
TIMEOUT
MODEL_ERROR
```

`error` is terminal. The runtime maps it to `FAILED` with the corresponding
`failure_class`, except that a runtime deadline maps to `TIMEOUT` and a
controlled stop maps to `CANCELLED`. The worker message never selects a job
decision.

## 5. Ordering and terminal rules

The valid pipe-mode sequence is:

```text
start (orchestrator -> worker)
  -> ready?
  -> progress*
  -> result | error
  -> process completion
```

The following are invalid:

- a result or error before a valid start binding;
- more than one terminal message;
- progress after a terminal message;
- a second ready message;
- a result with an unknown verdict;
- a result that exceeds its bound;
- a process that exits without a terminal result or error;
- a worker that emits evidence/artifact messages in the Phase 6 protocol;
- a worker that attempts to send a command, executable, path, or tool choice.

Invalid sequences settle as `MALFORMED` with `worker_verdict = NONE`, unless a
more specific runtime condition such as timeout occurred first. The
orchestrator does not reinterpret malformed output as success.

## 6. Process completion mapping

The normalized run result is determined by the runtime, not by the worker's
claim alone:

| Runtime observation | Run status | Advisory verdict |
|---|---|---|
| Valid result and exit code 0 | `SUCCEEDED` | Reported verdict |
| Explicit error message | `FAILED` | `NONE` |
| Non-zero exit without accepted result | `FAILED` | `NONE` |
| Invalid, oversized, or incomplete protocol | `MALFORMED` | `NONE` |
| Wall-clock deadline | `TIMEOUT` | `NONE` |
| Explicit controlled stop | `CANCELLED` | `NONE` |
| Spawn failure | `FAILED` | `NONE` |

A non-zero exit with a result is not automatically success; the runtime's
selected adapter policy must define whether the result is accepted, and the
default Phase 6 policy is to require exit code 0 for `SUCCEEDED`.

## 7. Pull-mode report envelope

For a registered local `mcp_pull` worker, the private start envelope provides
an opaque lease and the configured local report route. The worker submits:

```json
{
  "lease": "opaque-run-scoped-lease",
  "verdict": "FAIL",
  "summary": "bounded result summary",
  "usage": {
    "input_units": 10,
    "output_units": 20
  }
}
```

The `run_report` MCP operation validates the worker actor, lease binding,
expiry, single-use state, and bounded report fields. It then calls the same
settlement function used by pipe-mode results. A worker never supplies a job
status or decision in the report.

The pull route is local-only. No public remote callback, cloud endpoint, or
worker-discovery mechanism is introduced by this protocol.

## 8. Limits and resource behavior

The initial proposed limits are:

| Resource | Limit |
|---|---:|
| Line including framing | 65,536 bytes |
| Total stdout | 4 MiB |
| Protocol messages | 256 |
| Stderr retained | 65,536 bytes |
| Progress message | 1,024 bytes |
| Result summary | 2,048 bytes |
| Task text | 8,192 bytes |
| Parameter JSON | 32,768 bytes |
| Default runtime | 300,000 ms |
| Hard runtime ceiling | 900,000 ms |

The limits are server-owned. A dispatch request may choose a timeout only
within the registered worker and global ceilings. A worker cannot enlarge any
limit in a message.

## 9. Lease and identity semantics

The lease binds a report to one run, job, cycle, and worker actor. It is not a
general session identity and carries no authority to decide a job.

- an expired lease is rejected;
- a consumed lease is rejected on reuse;
- a lease for another run/job/cycle/actor is rejected;
- lease validation and consumption are atomic with report settlement;
- duplicate reporting returns a deterministic duplicate result and performs no
  second mutation;
- the worker does not receive a principal decision capability;
- the report does not carry evidence or artifact fields in Phase 6.

## 10. Error handling

Protocol and runtime errors are bounded and classified. They must not expose
raw environment content, unbounded streams, executable policy, or internal
implementation details through the MCP response.

The worker receives no instruction to change job authority. Worker text is
treated as data, and the orchestrator does not interpret it as a command or
workflow transition.

## 11. Compatibility and evolution

`protocol_version` is required on `start` and `ready`. A future incompatible
version must be rejected before the worker runs. Additive message fields are
allowed only after an explicit protocol revision and independent review.

The protocol is intentionally narrower than the later V1 design material in
`docs/ARCHITECTURE.md`: evidence, artifacts, recovery, retry scheduling, and
external adapters require their own phase ownership and review.

## 12. Implementation and review gate

This contract becomes implementable only after:

1. the Phase 6 plan and proposed Revision 9 are independently reviewed;
2. Codex adjudicates every finding;
3. any persistence/configuration gap is resolved in the documents;
4. Codex records `AUTHORIZE PHASE 6 IMPLEMENTATION: YES`; and
5. an implementation branch is frozen from the approved `main` base.

Until all five conditions are satisfied:

```text
PHASE 6 IMPLEMENTATION AUTHORIZED: NO
```
