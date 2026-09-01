# AOM — V1 WORKER PROTOCOL

> Normative AOM V1 worker protocol, retaining the published version-1 wire
> behavior from Phases 6–8 and the reviewed Phase 7 message extension. Phase 9
> may harden documentation and exposure boundaries but does not add messages or
> change the protocol version.

Version: **1**
Owner: AOM V1 worker-runtime contract
Repository: `C:\AgentProjects\agent-orchestrator-mcp`
Governing plans: `docs/PHASE6_PLAN.md`, `docs/PHASE8_PLAN.md`, and `docs/PHASE9_PLAN.md`
Current implementation: **Phase 8 complete and published; Phase 9 planning only**

## 1. Purpose and boundary

The protocol carries a bounded task invocation to one registered local worker
and carries bounded progress or result messages back to the orchestrator. A
worker result is advisory runtime data. It is never a job decision and never
changes an authoritative job milestone.

The Phase 6 baseline messages do not carry evidence or artifact collections.
Revision 10 adds the explicit Phase 7 message types in §12; they are not
accepted as arbitrary fields on a Phase 6 result.

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
- a pull-mode process may receive an additional opaque run lease and a
  runtime-selected local report route in its private envelope; that material
  is never returned to the Codex dispatch caller;
- the worker cannot change the binding by echoing different values.

The exact lease representation for pull mode is normative in §3.1. Other
private-envelope serialization details remain an implementation detail.

### 3.1 Exact lease envelope for `mcp_pull`

The run lease is an opaque two-part value:

```text
base64url(canonical_payload) + "." + base64url(mac)
```

The canonical payload contains exactly these fields:

```json
{
  "v": 1,
  "lease_id": "uuid",
  "run_id": "uuid",
  "job_id": "uuid",
  "cycle": 0,
  "actor_id": "worker-local",
  "expires_at": "2026-08-31T12:00:00Z",
  "nonce": "64-lowercase-hex-characters"
}
```

The payload is serialized with the repository's deterministic canonical JSON
rules. `mac` is the base64url encoding of an HMAC-SHA256 over the exact UTF-8
payload bytes using the existing local lease-key mechanism. The server creates
the 32-byte random nonce, stores its lowercase hexadecimal representation in
the existing `leases.nonce` field, and never accepts a nonce from the dispatch
request.

The worker's transport identity is separate from the lease. A pull-mode worker
uses its pre-provisioned worker actor session; that session material is not
placed in `workers.json`, the start envelope, or the lease. `run_report`
accepts the complete lease value and does not accept a separately supplied
nonce or binding override. The server verifies the MAC, exact database binding,
expiry, actor, and unconsumed state before consuming the lease atomically.

For `pipe` mode, the lease remains runtime-owned and is consumed by the shared
settlement path after a valid process result. It is not returned to the Codex
caller and need not be exposed to the child as a report credential.

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
the exact opaque lease from §3.1 and a runtime-selected local report route. The
worker submits:

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

The `run_report` MCP operation validates the worker actor, the complete lease
envelope, binding, expiry, single-use state, and bounded report fields. It then
calls the same settlement function used by pipe-mode results. A worker never
supplies a job status or decision in the report.

The pull route is local-only and is selected by the orchestrator. No public
remote callback, cloud endpoint, or worker-discovery mechanism is introduced
by this protocol.

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

The exact `workers.json` registry schema is defined in
`docs/PHASE6_PLAN.md` §5. This protocol does not add registry fields or permit
worker-supplied execution policy.

## 12. Phase 7 evidence/artifact extension

Revision 10 adds two non-terminal worker message types. They may appear before
the single terminal `result` or `error` message and are admitted only through
the Phase 7 domain validators.

### 12.1 `artifact`

```json
{
  "type": "artifact",
  "path": "result.txt",
  "kind": "report",
  "mime": "text/plain",
  "label": "worker result"
}
```

`path` is a relative path inside the server-created run staging directory. It
is not a final database path and cannot contain an absolute/device prefix,
traversal, alternate data stream, reserved device name, symlink, or reparse
point. `kind` is at most 64 bytes, `mime` 128 bytes, and `label` 256 bytes.

### 12.2 `evidence`

```json
{
  "type": "evidence",
  "kind": "assertion",
  "severity": "info",
  "summary": "bounded worker observation",
  "detail": { "source": "fixture" },
  "artifact_path": "result.txt"
}
```

`summary` is at most 2,048 bytes and serialized `detail` is at most 65,536
bytes. `artifact_path`, when present, must match one artifact message from the
same run. The server assigns the worker trust class and source actor; the
message cannot select either value.

### 12.3 Ordering and persistence

The Phase 7 pipe sequence is:

```text
start (with server-created artifact_staging_dir)
  -> ready?
  -> progress* | artifact* | evidence*
  -> result | error
  -> process completion
```

The runtime copies staged files into the global artifact root, computes their
byte count and SHA-256 digest, then records the artifact and evidence through
the shared admission path. A message never changes an authoritative job state,
creates a decision, or consumes the run lease. `mcp_pull` uses the same logical
contracts through the Phase 7 MCP operations.

The Phase 7 extension remains bounded by the Phase 6 line, output, and message
limits. Unknown fields and unknown message types remain invalid. A malformed
Phase 7 message cannot produce a successful run.

## 13. Implementation and review gate

This contract became implementable only after:

1. the Phase 6 plan and proposed Revision 9 are independently reviewed;
2. Codex adjudicates every finding;
3. any persistence/configuration gap is resolved in the documents;
4. Codex records `AUTHORIZE PHASE 6 IMPLEMENTATION: YES`; and
5. an implementation branch is frozen from the approved `main` base.

The conditions above are satisfied for the current implementation branch.
They do not authorize later-phase behavior or merge. Until the separate final
implementation review and merge gate succeed:

```text
PHASE 6 IMPLEMENTATION AUTHORIZED: YES — BRANCH ONLY
PHASE 7 IMPLEMENTATION AUTHORIZED: YES — codex/phase7-implementation only
PHASE 7 IMPLEMENTATION: COMPLETE AND PUBLISHED
PHASE 7 WINDOWS FIX: PUBLISHED AND VERIFIED
PHASE 8 IMPLEMENTATION AUTHORIZED: YES
PHASE 8 IMPLEMENTATION: COMPLETE AND MERGED LOCALLY
PHASE 8 REMOTE PUBLICATION: YES
PHASE 9 STARTED: NO
```

## 14. Phase 9 hardening boundary

Phase 9 may normalize this document as the AOM V1 Worker Protocol and add
explicit redaction, diagnostic, and security-documentation requirements. It
must not change protocol version 1, add a worker message type, broaden the
private start envelope, expose leases outside their approved worker path, or
create a new authority path. Phase 8 recovery, reaper, cancellation, shutdown,
and `STALLED` semantics remain as documented lifecycle effects around the same
wire contract.
