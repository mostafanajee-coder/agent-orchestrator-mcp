# AOM — Phase 9 Hardening and Documentation Plan

> **Status: governing planning scope with a locally completed implementation.**
> This document defines the Phase 9 hardening and normative-documentation
> boundary. The plan itself did not authorize source changes; a separate Codex
> decision authorized implementation on the dedicated branch, followed by a
> separate fast-forward and publication after implementation review. It does
> not authorize deployment or later-phase implementation.

## 1. Authority and authoritative baseline

Phase 8 is complete, merged, published, and closed. This Phase 9 plan starts
from the exact published Phase 8 `main` state:

| Item | Verified value |
|---|---|
| Authoritative base branch | `main` |
| Authoritative base commit | `3f03168c161a941c4f7055629e6f433c636e62a7` |
| `origin/main` at planning snapshot | `3f03168c161a941c4f7055629e6f433c636e62a7` |
| Base tree | `8d34fe5c26d0b0f392cdab750cc8e14d3ab61c80` |
| Phase 8 implementation | merged and published |
| Phase 8 CI | passed on Windows and Ubuntu |
| Phase 9 implementation branch | `codex/phase9-implementation` |
| Phase 9 implementation head | `f17ba7788c6b364646eaf7e31c12422bc4d1e20c` |
| Phase 9 implementation tree | `503ab723ac23abe12ed5a85cae82db0900b2edc6` |
| Phase 9 implementation | complete, merged, and published |
| Local `main` after Phase 9 publication | `398785ea48926b52829a0fd1fa4c6d8d8c6e0ef8` |
| `origin/main` after Phase 9 publication | `398785ea48926b52829a0fd1fa4c6d8d8c6e0ef8` |
| Phase 9 implementation authorization | `YES` — dedicated branch only |

The previous planning report proposed a nested security-document path. The
architecture's repository layout defines `SECURITY.md` at the repository root;
this plan uses that path and does not create a second security document
location.

## 2. Objective and invariants

### 2.1 Objective

Phase 9 closes the V1 hardening and normative-documentation gap without adding
new product capabilities:

> **Make the published V1 baseline consistently rate-controlled, redacted,
> cross-platform-verified, and normatively documented while preserving every
> authority, lifecycle, worker, evidence, artifact, lease, audit, and recovery
> invariant from Phases 4–8.**

### 2.2 Invariants that must not change

- Codex remains the sole authoritative decision maker.
- `codex_decide` remains the sole authoritative decision path.
- Worker output remains advisory.
- Phase 8 recovery, reaper, shutdown, lease, and `STALLED` behavior remains
  mechanical and non-authoritative.
- Rate limiting may delay or reject a request, but cannot create, alter, infer,
  or partially apply an authority decision.
- Redaction changes representation or exposure only; it does not create a new
  data model or authority path.
- Worker protocol version remains 1 and no new worker message type is added.
- No new MCP business capability or public capability is added.
- Schema remains version 7 unless an independent review proves an unavoidable
  requirement; no migration is assumed or silently introduced.
- Phase 10 and all post-V1 integrations remain outside the plan.

## 3. Scope

### 3.1 In scope

1. A shared, authenticated per-token request-admission limiter.
2. An explicit redaction and data-classification contract covering every
   established output and persistence sink.
3. Normalization of `WORKER_PROTOCOL.md` as the AOM V1 worker protocol.
4. Creation of the root `SECURITY.md` normative security/trust-boundary guide.
5. README, Architecture Revision 12, and governance-status cleanup.
6. A sanitized two-session Codex authority/attribution drill.
7. Windows and POSIX regression verification for the published Phases 4–8.
8. Supporting tests only for the approved hardening/documentation behavior.

### 3.2 Explicit exclusions

- Schema redesign, schema version 8, migration 008, or any other migration.
- New MCP business tools, new public capabilities, or new worker message types.
- Remote/cloud workers, browser/CDP integrations, Gemini/`agy` integration,
  OAuth servers, TLS, remote networking, or multi-machine operation.
- Autonomous retries, distributed scheduling, general queues, circuit breakers,
  or broad observability/telemetry platforms.
- Artifact retention/pruning, backup/restore, database maintenance, or service
  installation/deployment.
- Rewriting historical Phase 4–8 records merely to make their wording current.
- Phase 10 or other post-V1 implementation.

## 4. Proposed impact boundary

| Area | Phase 9 proposal |
|---|---|
| Source | Narrow limiter, redaction, and safe-error corrections only |
| Configuration schema | No change; rate values are fixed server-owned defaults |
| Database schema | No change; remain v7 |
| Migrations | None |
| MCP business tools | None |
| Public capabilities | None |
| Worker protocol | Version 1; wire vocabulary unchanged |
| Documentation | `PHASE9_PLAN.md`, Revision 12, root `SECURITY.md`, normalized `WORKER_PROTOCOL.md`, README |
| Verification | 64-case Phase 9 matrix plus complete Phases 4–8 regression |

The exact implementation source paths are intentionally not frozen by this
planning document. They must be derived from the current source after the
planning snapshot is independently reviewed and implementation is separately
authorized.

## 5. Rate-limit contract

### 5.1 Ownership and placement

Rate limiting belongs to a shared authenticated MCP admission layer. It must
run after successful bearer verification and before any tool handler, request
body processing that can be avoided, domain transaction, or runtime mutation.
It must not be implemented inside `decide`, job, run, evidence, artifact,
recovery, or system-actor code.

HTTP and stdio must expose equivalent admission semantics. The implementation
may use one shared limiter abstraction with transport-specific presentation of
the rejection.

### 5.2 Identity and fixed V1 policy

The bucket key is the verified persistent `token_id`.

It is not keyed by actor ID, client-provided labels, `session_hint`, or IP
address. This preserves independent budgets for two Codex sessions mapped to
the same principal actor.

Proposed fixed V1 policy:

- capacity: 30 request credits;
- refill: 1 credit per second;
- cost: 1 credit for every authenticated MCP request;
- `tools/list` and `ping` count like every other authenticated request;
- limiter state is in memory only;
- restart resets the limiter;
- no rate-limit table, persistence, migration, or audit row for each rejection;
- internal startup, recovery, reaper, and shutdown operations do not consume an
  MCP request budget.

These values are the approved V1 policy used by the local implementation. The
implementation does not make them runtime-configurable; any change requires a
separate architecture decision.

### 5.3 Rejection behavior

An exhausted bucket produces a bounded `RATE_LIMITED` result with an optional
bounded `retry_after_ms`. It must:

- enter no tool handler;
- open no domain mutation transaction;
- consume no idempotency key;
- mutate no job, run, lease, evidence, or artifact;
- create no decision or authoritative status;
- expose no credential or internal path.

HTTP uses status 429 with a bounded `Retry-After` header; stdio uses the same
semantic error in the MCP response. The exact rejection shape is frozen by the
implementation without changing the MCP business-tool catalogue.

Unknown or malformed credentials remain governed by the existing authentication,
loopback, Host/Origin, body, and rejected-auth protections. No pre-auth global
limiter is introduced in Phase 9.

## 6. Redaction and data classification

Phase 9 must produce one sink manifest and verify it against source behavior.
No sink is considered covered merely because another sink uses the same helper.

| Data class | Required treatment |
|---|---|
| Raw bearer token | secret; never persisted, logged, or returned |
| `Authorization` header value | secret; never persisted, logged, or returned |
| Token digest/hash | sensitive credential derivative; internal only |
| `token_id` | non-secret identifier; retain where verified attribution requires it |
| Session label | bounded attribution metadata; never an authority input |
| Lease HMAC key | secret; never exposed |
| Complete opaque lease | runtime credential; only approved worker path may receive it |
| Lease MAC/nonce | lease-sensitive; exclude from generic outputs and logs |
| Audit detail | recursive redaction and existing size bounds |
| Worker stderr | bounded first, then redacted before retention or exposure |
| Worker stdout | protocol-validated, bounded, and redacted before textual sinks |
| MCP error | stable safe code/message; no stack, SQL, credential, or raw path |
| State/secrets/database absolute paths | hidden or replaced by logical labels in generic errors |
| Authorized job workspace | preserve in established authorized success responses |
| Artifact relative metadata | preserve existing contract; never expose server absolute path |
| Evidence/detail | preserve trust and bounds; remove known runtime secrets |
| UUIDs and safe identifiers | preserve where the contract requires; do not confuse with secrets |

At minimum, the sink manifest covers:

1. audit detail;
2. service stderr;
3. retained worker stderr;
4. worker protocol diagnostics;
5. evidence detail/text;
6. artifact metadata and labels;
7. MCP success responses;
8. MCP error responses;
9. startup failures;
10. shutdown and recovery diagnostics;
11. HTTP authentication rejection;
12. stdio authentication rejection;
13. README examples and test fixtures.

Redaction must not erase `token_id` or verified session attribution merely
because those identifiers are related to credentials. The bearer is secret;
the token ID is attribution metadata.

## 7. Normative Worker Protocol document

`WORKER_PROTOCOL.md` must be presented as the **AOM V1 Worker Protocol** while
retaining the established version-1 wire behavior. It must document, without
implementing new behavior:

1. trust and authority boundary;
2. protocol version 1 and UTF-8 NDJSON framing;
3. private start envelope;
4. lease identity versus transport/session identity;
5. `ready`, `progress`, `result`, and `error` messages;
6. Phase 7 evidence/artifact messages;
7. ordering and terminal rules;
8. process-exit interpretation;
9. line, output, message, stderr, and time limits;
10. stdout/stderr handling and redaction;
11. cancellation and Phase 8 shutdown/orphan behavior;
12. malformed-output behavior;
13. compatibility/evolution rules;
14. local-only and non-remote scope;
15. explicit advisory/no-authority disclaimer;
16. change-control and review requirements.

Historical phase references may remain where they explain provenance, but the
active document status must clearly identify the V1 protocol and must not imply
that Phase 9 adds a wire message or changes the protocol version.

## 8. Root SECURITY.md

Phase 9 creates `SECURITY.md` at the repository root. It is documentation only
and must not expose secrets or operational credentials. It must cover:

- authority and worker trust boundaries;
- local transport and authentication/token lifecycle;
- verified multi-session attribution;
- lease trust and storage protection;
- Windows ACL and POSIX permission policy;
- state-root, SQLite, WAL, and migration protection;
- workspace admission and artifact path safety;
- worker executable/environment and protocol bounds;
- rate-limit ownership and limits;
- redaction/data classification;
- audit hash-chain purpose and limitations;
- startup recovery, reaper, `STALLED`, cancellation, and shutdown semantics;
- dependency/build verification;
- unsupported remote exposure and explicit security non-goals;
- post-V1 boundaries and change-control requirements.

The audit ledger must be described as tamper-evident within its model. It must
not be described as preventing an actor with unrestricted storage rewrite access
from reconstructing the ledger.

## 9. Two-session verification drill

The drill uses an isolated test state and two distinct valid persistent tokens:

- Session A → actor `codex`, token ID A, label A;
- Session B → actor `codex`, token ID B, label B.

The evidence package may contain only safe identifiers, request/decision/audit
sequence IDs, result classes, and redaction assertions. It must never contain a
bearer, token digest, complete lease, Authorization header, or lease-key data.

Required checks:

1. A and B resolve to the same principal actor.
2. A and B have distinct verified token IDs and labels.
3. Both have the same principal capabilities and tool visibility.
4. A-authorized action is attributed to A.
5. B-authorized action is attributed to B.
6. A stale-version race cannot create two accepted mutations.
7. Forged `session_hint` cannot change identity or authority.
8. Exhausting A's bucket does not throttle B's bucket.
9. Audit inspection exposes safe attribution without credential material.
10. The sanitized drill record contains no secret bytes.

## 10. Cross-platform and regression gates

Windows verification must retain owner-only ACL behavior, path normalization,
process-tree termination, safe path exposure, HTTP/stdio parity, rate limits,
and redaction behavior.

POSIX verification must retain directory/file permissions, symlink containment,
process-group termination, HTTP/stdio parity, rate limits, and redaction.

Every supported CI platform must pass typecheck, lint, complete test suite,
build, and dependency audit. Phases 4–8 must remain green and no authoritative
or recovery semantics may regress.

## 11. Work packages and gates

| WP | Scope | Authorization |
|---|---|---|
| WP0 | Freeze Phase 9 inventory, base, and scope | planning only |
| WP1 | Draft `PHASE9_PLAN.md` and Architecture Revision 12 | planning only |
| WP2 | Freeze shared per-token rate-limit contract | planning only |
| WP3 | Freeze redaction classification and sink manifest | planning only |
| WP4 | Normalize `WORKER_PROTOCOL.md` | planning only |
| WP5 | Draft root `SECURITY.md` | planning only |
| WP6 | Define two-session, platform, regression, and 64-case evidence gates | planning only |
| WP7 | Freeze documentation snapshot and independent architecture review | required before implementation authorization |
| WP8 | Codex adjudication, corrections, and targeted re-review if needed | required before implementation authorization |
| WP9 | Implement shared rate-limit admission | completed locally under explicit authorization |
| WP10 | Implement redaction/error-shaping corrections | completed locally under explicit authorization |
| WP11 | Finalize normative documentation without scope expansion | completed locally; report recorded |
| WP12 | Execute two-session and Windows/POSIX regression gates | Windows and POSIX gates passed |
| WP13 | Independent implementation review | completed; accepted |
| WP14 | Codex final merge gate and post-merge closure | complete; published |

WP13 independent implementation review is complete. WP14 local fast-forward,
publication, and post-merge closure are complete.

## 12. Acceptance matrix

The exact planned matrix contains **64 cases**:

```text
RATE 10 + REDACTION 14 + WORKER PROTOCOL 8 + SECURITY DOCUMENTATION 6
+ TWO SESSION 10 + PLATFORM 8 + REGRESSION/SCOPE 8 = 64
```

### Rate limiting — P9-RATE-01 through P9-RATE-10

| ID | Acceptance condition |
|---|---|
| P9-RATE-01 | First 30 immediate requests for one valid token fit the fresh bucket |
| P9-RATE-02 | Next request with an empty bucket receives bounded `RATE_LIMITED` |
| P9-RATE-03 | Bucket refills at one request credit per second |
| P9-RATE-04 | Token A exhaustion does not consume Token B's bucket |
| P9-RATE-05 | HTTP and stdio use the same authenticated-token policy |
| P9-RATE-06 | Rejection occurs before tool/domain mutation |
| P9-RATE-07 | Rate rejection consumes no idempotency record |
| P9-RATE-08 | Later retry uses ordinary authority/CAS rules |
| P9-RATE-09 | Internal recovery/reaper actions are not MCP-rate-limited |
| P9-RATE-10 | Restart resets limiter state and creates no persistent record |

### Redaction — P9-RED-01 through P9-RED-14

| ID | Acceptance condition |
|---|---|
| P9-RED-01 | Bearer value is absent from every tested sink |
| P9-RED-02 | Authorization header value is absent |
| P9-RED-03 | Token digest is absent from external/log/error surfaces |
| P9-RED-04 | Safe `token_id` remains available for verified attribution |
| P9-RED-05 | Complete lease value is absent from generic sinks |
| P9-RED-06 | Lease-key/MAC-sensitive material is absent |
| P9-RED-07 | Audit detail receives recursive redaction |
| P9-RED-08 | Worker stderr is bounded and redacted before retention |
| P9-RED-09 | MCP errors contain no raw exception/stack/credential |
| P9-RED-10 | Internal state/secrets/database paths are hidden in generic errors |
| P9-RED-11 | Authorized workspace metadata is not incorrectly destroyed |
| P9-RED-12 | Worker/process text cannot persist a known runtime secret |
| P9-RED-13 | Redaction remains correct after bounded stream assembly |
| P9-RED-14 | Benign UUIDs/token IDs are not treated as bearer secrets |

### Worker Protocol — P9-WP-01 through P9-WP-08

| ID | Acceptance condition |
|---|---|
| P9-WP-01 | Document identifies AOM V1 and protocol version 1 |
| P9-WP-02 | Existing Phase 6 message types are normative |
| P9-WP-03 | Phase 7 evidence/artifact messages are normative |
| P9-WP-04 | Published size/count/runtime limits match established contracts |
| P9-WP-05 | Lease identity is distinct from principal/session identity |
| P9-WP-06 | Phase 8 recovery/shutdown adds no wire message |
| P9-WP-07 | Remote/cloud transport remains excluded |
| P9-WP-08 | Documentation normalization changes no wire behavior |

### Security documentation — P9-SEC-01 through P9-SEC-06

| ID | Acceptance condition |
|---|---|
| P9-SEC-01 | Authority and worker trust boundaries are documented |
| P9-SEC-02 | Token/lease/secret lifecycle is documented without secret examples |
| P9-SEC-03 | Windows and POSIX storage protections are documented |
| P9-SEC-04 | Transport, workspace, process, artifact, and rate boundaries are documented |
| P9-SEC-05 | Audit tamper-evidence and limitations are accurate |
| P9-SEC-06 | Recovery, shutdown, non-goals, and post-V1 exclusions are documented |

### Two-session drill — P9-SES-01 through P9-SES-10

| ID | Acceptance condition |
|---|---|
| P9-SES-01 | Two distinct valid token IDs resolve to `codex` |
| P9-SES-02 | Distinct verified labels remain distinguishable |
| P9-SES-03 | Both sessions receive the same principal tool visibility |
| P9-SES-04 | Session A decision records A attribution |
| P9-SES-05 | Session B decision records B attribution |
| P9-SES-06 | Shared stale-version race yields one accepted mutation |
| P9-SES-07 | Forged `session_hint` changes neither identity nor authority |
| P9-SES-08 | Token A rate exhaustion does not throttle Token B |
| P9-SES-09 | Audit query exposes safe attribution without credentials |
| P9-SES-10 | Drill evidence contains no bearer/digest/lease secret |

### Platform — P9-PLAT-01 through P9-PLAT-08

| ID | Acceptance condition |
|---|---|
| P9-PLAT-01 | Windows owner-only ACL regression passes |
| P9-PLAT-02 | POSIX directory/file permission regression passes |
| P9-PLAT-03 | Windows path and exposure-redaction cases pass |
| P9-PLAT-04 | POSIX path and exposure-redaction cases pass |
| P9-PLAT-05 | Windows process-tree termination regression passes |
| P9-PLAT-06 | POSIX process-group termination regression passes |
| P9-PLAT-07 | Rate-limit behavior is identical after authentication on both platforms |
| P9-PLAT-08 | Phase 8 recovery/shutdown regressions pass on both CI platforms |

### Regression and scope — P9-REG-01 through P9-REG-08

| ID | Acceptance condition |
|---|---|
| P9-REG-01 | Phase 4 authority/auth regression remains green |
| P9-REG-02 | Phase 5 job lifecycle regression remains green |
| P9-REG-03 | Phase 6 worker/lease/runtime regression remains green |
| P9-REG-04 | Phase 7 evidence/artifact/manifest regression remains green |
| P9-REG-05 | Phase 8 recovery/reaper/audit-query regression remains green |
| P9-REG-06 | Schema remains v7 with no Phase 9 migration |
| P9-REG-07 | No Phase 9 business tool appears in the production inventory |
| P9-REG-08 | No Phase 10, remote, retry, scheduling, telemetry, or deployment feature appears |

## 13. Risks and unresolved decisions

The following record the planning risks and their current disposition:

1. The exact source admission hook for identical HTTP/stdio rate-limit behavior
   was selected after source inspection and implemented in the local branch.
2. The sink inventory was checked and the identified redaction gaps were closed
   in the local branch.
3. The fixed 30/1 policy remains fixed and is not runtime-configurable in V1;
   tuning is change-controlled and not runtime-configurable in V1.
4. Root `SECURITY.md` is a new documentation artifact and must not be confused
   with a deployment or security-service integration.
5. Any requirement for a new index, capability, migration, message, or tool is
   an architecture-plan change and must return to review before implementation.

No unresolved architecture blocker remains. The source hook, sink manifest, and
rate-limit behavior are recorded in
[`docs/PHASE9_IMPLEMENTATION_REPORT.md`](PHASE9_IMPLEMENTATION_REPORT.md) and
were independently implementation-reviewed before the local fast-forward.

## 14. Governance and authorization

The required sequence is:

1. Freeze this documentation-only snapshot from published `main`.
2. Verify the changed paths are limited to the planning/documentation package.
3. Submit the exact snapshot to one independent architecture reviewer.
4. Require a complete read manifest and finding-by-finding verdict.
5. Codex classifies every finding as blocking, non-blocking, rejected, or
   explicitly deferred.
6. Apply documentation-only corrections if required.
7. Perform targeted re-review if a correction materially changes architecture.
8. Freeze the corrected Phase 9 planning baseline.
9. Record a separate decision:

   ```text
   AUTHORIZE PHASE 9 IMPLEMENTATION: YES / NO
   ```

10. If and only if that decision is `YES`, create a separately frozen
    implementation branch from the then-authoritative `main`.
11. Run the approved implementation, 64-case matrix, prior regressions, and
    Windows/POSIX CI.
12. Obtain independent implementation review and Codex final merge approval.
13. Perform post-merge Phase 9 closure before any later planning.

Current governance state:

```text
PHASE 8: COMPLETE, MERGED, PUBLISHED, AND CLOSED
PHASE 9 PLAN: GOVERNING BASELINE
PHASE 9 IMPLEMENTATION: COMPLETE AND MERGED INTO LOCAL main
PHASE 9 IMPLEMENTATION AUTHORIZED: YES — DEDICATED BRANCH ONLY
PHASE 9 IMPLEMENTATION REVIEW: ACCEPTED
PHASE 9 LOCAL MERGE: COMPLETE — FAST-FORWARD TO bea75982
PHASE 9 REMOTE PUBLICATION: COMPLETE — origin/main at 398785ea
PHASE 10: NOT STARTED
```

**PHASE 9 POST-MERGE CLOSURE — COMPLETE**
