# AOM — Phase 9 Implementation Report

## 1. Status and authority

This report records the independently reviewed Phase 9 implementation snapshot.
After that review, the accepted branch was fast-forwarded into local `main`.
The post-merge state is recorded in
[`docs/PHASE9_POST_MERGE_CLOSURE.md`](PHASE9_POST_MERGE_CLOSURE.md).
No remote publication, pull request, or deployment has occurred.

| Item | Verified value |
|---|---|
| Implementation branch | `codex/phase9-implementation` |
| Authoritative Phase 8 `main` base | `3f03168c161a941c4f7055629e6f433c636e62a7` |
| Corrected Phase 9 planning snapshot | `a75ec06542660cd4d3a338bed514186549a381bd` |
| Implementation commit | `f17ba7788c6b364646eaf7e31c12422bc4d1e20c` |
| Implementation tree | `503ab723ac23abe12ed5a85cae82db0900b2edc6` |
| `main` during implementation | `3f03168c161a941c4f7055629e6f433c636e62a7` |
| `origin/main` during implementation | `3f03168c161a941c4f7055629e6f433c636e62a7` |
| Phase 9 implementation authorization | `YES` — dedicated local branch only |
| Phase 9 merge authorization at review snapshot | `NO`; local fast-forward was authorized afterward |
| Phase 10 | Not started |

The implementation was authorized by the principal Codex decision after the
Phase 9 planning review. The authorization is limited to the Phase 9 scope and
does not authorize a merge or publication.

## 2. Implemented scope

### 2.1 Shared authenticated request admission

- Added `src/mcp/admission.ts` with a process-local per-token token bucket.
- The fixed V1 policy is 30 credits per verified `token_id`, refilled at one
  credit per second, with one credit per authenticated MCP request.
- HTTP applies the limiter after bearer verification and before body parsing or
  MCP/domain dispatch.
- Stdio wraps the common transport and applies the same policy to requests and
  notifications while forwarding responses without charging them.
- Exhaustion returns the bounded `RATE_LIMITED` semantic error. HTTP presents
  it as status 429 with a bounded `Retry-After` value.
- Rejections do not enter a tool handler, open a domain transaction, consume an
  idempotency key, mutate durable state, or create an audit row.
- Limiter state is memory-only and restarts reset it.

### 2.2 Redaction and safe exposure

- Added `src/security/redaction.ts` as the shared redaction helper.
- Audit detail and bounded audit text use recursive redaction, absolute-path
  hiding, and ephemeral per-event secret values.
- Worker stderr and terminal summaries are redacted before retention or audit
  exposure; the complete lease is supplied only as an ephemeral redaction
  value.
- Evidence detail, evidence text, artifact metadata, and package-manifest
  metadata are redacted before retention or returned to readers. Existing
  safe identifiers such as `token_id`, job IDs, run IDs, and artifact IDs are
  preserved.
- Phase 7/8/6 and authority MCP error shaping now redacts absolute paths and
  credential-shaped text while retaining stable typed error codes.
- Existing authorized workspace success metadata and relative artifact paths
  remain available; generic errors do not expose protected absolute paths.

### 2.3 Verification coverage

- Added HTTP and stdio rate-limit integration tests.
- Added limiter and redaction unit tests.
- Added a two-session drill proving that distinct token IDs resolve to the same
  `codex` principal, remain separately attributable, race safely on CAS, and
  receive independent limiter buckets.
- Added worker-output retention tests proving that lease material and
  credential-shaped text do not reach evidence, artifact metadata, or audit
  detail.
- No migration, schema version change, capability, MCP business tool, worker
  message, protocol-version, remote/cloud integration, scheduler, retry loop,
  telemetry platform, deployment, or Phase 10 feature was added.

## 3. Changed-path boundary

The source/test implementation commit contains exactly these 23 paths:

```text
src/authority/audit.ts
src/cli.ts
src/domain/artifacts.ts
src/domain/auditQuery.ts
src/domain/decide.ts
src/domain/evidence.ts
src/domain/runs.ts
src/mcp/admission.ts
src/mcp/http.ts
src/mcp/stdio.ts
src/mcp/tools/codexDecide.ts
src/mcp/tools/jobLifecycle.ts
src/mcp/tools/phase6.ts
src/mcp/tools/phase7.ts
src/mcp/tools/phase8.ts
src/security/redaction.ts
src/workers/processRuntime.ts
test/integration/phase9RateLimitHttp.test.ts
test/integration/phase9RateLimitStdio.test.ts
test/store/phase7EvidenceArtifacts.test.ts
test/store/phase9TwoSession.test.ts
test/unit/rateLimiter.test.ts
test/unit/redaction.test.ts
```

The implementation commit contains no `src/store` or migration path. The
documentation follow-up is limited to the Phase 9 status/report documents and
does not alter the source implementation boundary.

## 4. Verification results

All commands below were run against the Phase 9 implementation branch in the
Windows workspace:

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test` through `npm run ci` | PASS — 59 files, 556 passed, 7 skipped |
| `npm run build` through `npm run ci` | PASS |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities |
| Phase 9 targeted tests | PASS — 6 files, 14 tests |
| `git diff --check` | PASS |

The complete CI command also preserved the previously published Phase 4–8
regression suite. The local run is Windows evidence; POSIX-specific execution
and CI evidence must still be supplied by the supported Ubuntu gate before a
final merge decision. No POSIX result is inferred from the Windows run.

## 5. Governance and remaining gates

The implementation branch is ready for one independent implementation review.
That review must use the final documentation commit containing this report and
the exact source ancestry recorded above. It must verify scope, security
properties, HTTP/stdio parity, redaction sinks, two-session attribution, and
the complete prior regression set. After the review, Codex must adjudicate its
findings and issue a separate final merge decision.

At the time of this implementation report, before the subsequent local
fast-forward:

```text
PHASE 9 IMPLEMENTATION: COMPLETE LOCALLY
PHASE 9 IMPLEMENTATION REVIEW: PENDING
PHASE 9 MERGE: NOT YET AUTHORIZED AT REPORT TIME
PHASE 9 PUSH/PR: NOT PERFORMED
PHASE 10: NOT STARTED
```
