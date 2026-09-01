# AOM — Phase 8 Implementation Report

## A. Authorization and exact implementation boundary

Codex authorized Phase 8 implementation after the independent architecture
review returned `READY FOR CODEX ADJUDICATION` with no blocking findings.

```text
AUTHORIZE PHASE 8 IMPLEMENTATION: YES
IMPLEMENTATION BRANCH: codex/phase8-implementation
PHASE 9: NOT STARTED
MERGE/PUSH/DEPLOYMENT: NOT AUTHORIZED
```

The implementation branch started from the reviewed planning snapshot:

| Item | Value |
|---|---|
| Planning snapshot | `809d698c164ad614e2365778e85e40dc65be872b` |
| Authoritative Phase 7 base | `d0ce68cb7fa2c0bdeb4e9de8ed15fd611bc253c3` |
| Implementation commit | `d46e956026ae351c4aee7d353b4971924e00b717` |
| Implementation tree | `f77619aa3b2f9443aaa960b196fb488fe7ad3ffb` |
| Branch | `codex/phase8-implementation` |
| Reviewed merge into local `main` | `130d6988422ad38dcd5513361e049d0171386613` |
| Remote publication | complete at `70390e414e73175d21943f32f14f43d664f3098b` |

No schema migration was added. The implementation remains limited to the
approved Phase 8 resilience boundary.

## B. Implemented capabilities

### 1. Startup recovery

`openPhase4Runtime` now runs fail-closed startup reconciliation after the
existing database, audit-chain, and authority checks and before a transport
can be created.

- Previous `PENDING`/`RUNNING` runs become terminal `ORPHANED` runs.
- An active run belonging to an already authoritative `JOB_CANCELLED` job is
  mechanically settled as `CANCELLED`.
- Affected active workflow jobs move to the existing non-authoritative
  `STALLED` state with a bounded reason.
- Recovery does not adopt an old process, create a decision, change an
  authoritative status, or create replacement work.
- Recovery is processed in batches of at most 100 rows and is state-idempotent.
- `run.orphaned`, `run.timeout`, `run.cancelled`, and `system.stall` events are
  appended through the existing hash-chained audit writer.

### 2. Reaper

`Phase8Lifecycle` owns one per-process timer with a 30-second default interval.
Each pass examines at most 100 active rows and reconciles only mechanically
unsafe state:

- lost runtime ownership → `ORPHANED`;
- expired lease or effective deadline → `TIMEOUT`;
- stale active job policy → `TIMEOUT` plus `STALLED` where applicable;
- already-authoritatively-cancelled work → `CANCELLED`.

The reaper never increments a cycle, creates a replacement run, schedules a
retry, or invokes an authoritative decision transition. Report/reaper races
are protected by immediate transactions and state predicates.

### 3. Graceful shutdown

`ProcessRuntime` now distinguishes service shutdown from authoritative job
cancellation.

- New dispatches are rejected once shutdown begins.
- Owned workers receive a graceful termination request first and a bounded
  force-termination fallback after the runtime grace period.
- A valid worker result that completes during the drain is retained.
- Unsettled runtime work is reconciled as `ORPHANED`, not as `JOB_CANCELLED`.
- The explicit Codex `CANCEL` path remains the only source of authoritative
  `JOB_CANCELLED`.
- The lifecycle drain defaults to 5 seconds and is capped at 30 seconds.

### 4. Bounded `audit_query`

Phase 8 registers one read-only MCP operation through the same HTTP/stdio
server factory:

- visible only to a verified `codex` principal with `job:read`;
- hidden from workers and the system actor;
- observer access is not added implicitly;
- default page size 100, maximum 200;
- opaque sequence cursor capped at 2,048 bytes;
- initial filters are `job_id` and `session_token_id` plus the cursor;
- optional range-chain verification checks only the bounded requested range and
  its predecessor anchor;
- output excludes hashes, session hints, raw worker streams, credentials, and
  lease material;
- detail values are recursively redacted and capped at 4 KiB;
- the query performs no mutation or repair.

## C. Changed paths in the implementation commit

The source/test implementation commit changes exactly these 15 paths:

- `src/authority/audit.ts`
- `src/authority/runtime.ts`
- `src/cli.ts`
- `src/domain/auditQuery.ts`
- `src/domain/recovery.ts`
- `src/domain/runs.ts`
- `src/mcp/http.ts`
- `src/mcp/server.ts`
- `src/mcp/stdio.ts`
- `src/mcp/tools/phase8.ts`
- `src/workers/processRuntime.ts`
- `test/integration/phase8Http.test.ts`
- `test/integration/phase8Runtime.test.ts`
- `test/store/phase8Recovery.test.ts`
- `test/unit/phase4Matrix.test.ts`

No migration file, deployment file, remote worker, retry scheduler, or Phase 9
feature was added.

## D. Verification evidence

Executed locally on the Windows development environment:

```text
npm run typecheck   PASS
npm run lint        PASS
npm run test        PASS — 54 test files; 548 passed; 7 skipped
npm run build       PASS
npm audit --omit=dev PASS — 0 vulnerabilities
```

The new Phase 8 tests cover startup recovery, authoritative-cancellation
cleanup, stale/deadline/ownership reaping, bounded audit pagination and
redaction, HTTP audit visibility, and interrupted process shutdown.

## E. Review and merge status

The local implementation received an independent implementation review with no
blocking findings and passed the Codex final merge gate. It was then
fast-forwarded into local `main` and published to `origin/main`. No deployment
was performed.

```text
PHASE 8 ARCHITECTURE REVIEW: ACCEPTED
PHASE 8 IMPLEMENTATION: COMPLETE LOCALLY
PHASE 8 IMPLEMENTATION REVIEW: ACCEPTED
PHASE 8 FINAL MERGE GATE: PASSED
PHASE 8 MERGE: YES — LOCAL FAST-FORWARD
PHASE 8 PUSH: YES
PHASE 9 STARTED: NO
```

The next governance step, if desired, is a separate remote-publication check
and Push gate. Phase 9 planning must not begin automatically after publication.
