# AOM — Phase 10 External Deterministic Browser Worker Plan

> **Status: documentation-only planning.** This document proposes the first
> post-V1 integration boundary. It does not authorize source changes, worker
> configuration changes, migrations, MCP tool registration, deployment, push,
> pull-request creation, or merge.

## 1. Authority and authoritative baseline

Phase 9 is complete, independently implementation-reviewed, merged, and
published. This Phase 10 planning branch starts from the exact published
`main` state:

| Item | Verified value |
|---|---|
| Authoritative base branch | `main` |
| Authoritative base commit | `c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8` |
| Authoritative base tree | `f3759e83ef167f0076e02b033bd5e06f9e90f3ff` |
| `origin/main` | `c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8` |
| Phase 9 source implementation | `f17ba7788c6b364646eaf7e31c12422bc4d1e20c` |
| Phase 9 published closure | `c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8` |
| Planning branch | `codex/phase10-authority-plan` |
| Phase 10 implementation authorization | `NO` |
| Phase 10 implementation | `NOT STARTED` |

The Phase 9 post-merge record is
[`docs/PHASE9_POST_MERGE_CLOSURE.md`](PHASE9_POST_MERGE_CLOSURE.md). The
published V1 architecture explicitly orders the external browser worker before
the later `agy` adapter. No browser-worker executable, version, invocation
contract, or credentials are assumed by this plan.

## 2. Objective

Phase 10 will determine whether one external deterministic browser worker can
be connected through the already-published local worker pipeline without
expanding AOM's authority, persistence, transport, or protocol core.

The success condition is:

> A browser worker may produce bounded deterministic observations, assertions,
> and artifacts through the existing worker/run/evidence/artifact contracts;
> it may never decide a job, select arbitrary execution policy, receive
> principal authority, or require an AOM core redesign.

The architectural stop rule is mandatory: if the integration requires changes
to `src/domain/`, `src/store/`, authoritative transitions, durable schema, or
the authority model, implementation must stop and return to architecture review.

## 3. Candidate selection

| Candidate | Decision |
|---|---|
| External deterministic browser worker | **Selected for Phase 10 planning** because the published architecture orders it first after V1 and treats it as an external process worker. |
| `agy`/Gemini adapter | Deferred until after browser integration; its installed invocation and input contract still require empirical verification. |
| Remote or cloud workers | Excluded; they change the local trust and transport boundary. |
| Browser credentials or third-party login automation | Excluded; they introduce secret custody and irreversible-action concerns. |
| Artifact retention, dashboard, backup, or maintenance work | Deferred; these are not the ordered first post-V1 integration. |

Selecting the browser worker is a planning decision only. It does not identify
an executable or claim that an external worker is currently compatible.

## 4. Scope

### 4.1 In scope

1. Identify the exact external browser-worker executable, version, and owner.
2. Record a safe empirical invocation contract without retaining credentials or
   uncontrolled output.
3. Determine whether the worker can operate as one existing local `process`
   worker-registry entry.
4. Define the AOM-to-worker task boundary using declarative operations only.
5. Define destination and host allowlist ownership.
6. Map browser results to Worker Protocol V1.
7. Map screenshots and structured captures to existing artifact admission.
8. Map assertions and observations to existing evidence admission.
9. Preserve existing run, lease, timeout, cancellation, recovery, redaction,
   and rate-limit behavior.
10. Define worker trust classification and the treatment of nondeterministic
    browser output.
11. Define deterministic local integration fixtures and supported platforms.
12. Define incompatibility, timeout, malformed-output, and unavailable-worker
    behavior.
13. Update the architecture and governance record for the first post-V1
    integration.

### 4.2 Explicit exclusions

Phase 10 must not include:

- `agy`/Gemini or any LLM interpretation inside the browser worker;
- remote, cloud, hosted, or multi-machine browser workers;
- remote MCP exposure or a second control plane;
- browser credentials, cookies, secrets, login automation, or third-party
  account actions;
- irreversible external actions such as purchases, submissions, deletion, or
  account changes;
- arbitrary JavaScript evaluation supplied by a job;
- arbitrary URLs, hosts, executable paths, commands, or browser flags supplied
  by a job;
- plugin frameworks, dynamic worker loading, or worker self-registration;
- new authoritative decisions, capabilities, actor roles, or trust classes;
- schema changes, migrations, new MCP business tools, or new worker messages;
- changes to the AOM Worker Protocol version;
- automatic retries, scheduling, queue redesign, telemetry, dashboards,
  deployment, installation services, artifact pruning, or backup rotation;
- Phase 11 or later post-V1 integrations;
- rewriting historical Phase 3–9 records except for factual status links.

## 5. Authority and trust invariants

The following are non-negotiable acceptance conditions:

1. Codex remains the only authoritative decision-maker.
2. `codex_decide` remains the only authoritative decision path.
3. Browser PASS is advisory evidence and never approval.
4. Browser FAIL is advisory evidence and never rejection.
5. Browser execution cannot write an authoritative job status.
6. Codex selects a registered `worker_id`; job input cannot select an
   executable or adapter.
7. The browser worker receives only its worker-scoped permissions and never
   `job:decide` or principal authority.
8. Worker identity remains separate from principal/session identity.
9. Existing run and lease bindings remain server-owned and unchanged.
10. Evidence trust is assigned by AOM, not by worker output.
11. Artifact paths, sizes, and hashes remain server-controlled/computed.
12. Phase 8 recovery may orphan, stall, time out, or cancel a run mechanically;
    it never makes an authoritative decision.
13. Phase 9 admission and redaction remain active and unchanged.
14. Worker output is data, not instructions to AOM.
15. Browser-specific behavior remains outside AOM authority and store layers.
16. A failure to meet these invariants is an architecture blocker, not a
    reason to widen implementation scope.

## 6. Required external-worker evidence

No external worker contract is invented in this plan. Before implementation
authorization, the following evidence must be recorded for the exact worker:

| Evidence | Required question |
|---|---|
| Identity | What executable, release/version, and operator-owned location are used? |
| Invocation | What exact argv/stdin/stdout/exit-code contract does it support? |
| Input | Does it accept a declarative task envelope without arbitrary code or command selection? |
| Output | Can it emit Worker Protocol V1 messages, or can an external wrapper translate them without changing AOM core? |
| Limits | Does it respect the existing line, output, message, timeout, and stderr bounds? |
| Destination policy | Who owns the host/destination allowlist, and is rejection enforced before navigation? |
| Artifacts | Can screenshots/captures be produced through the existing server-controlled staging path? |
| Evidence | Can assertions be bounded, attributable, and classified without trusting worker-selected authority? |
| Failure | How are missing executable, incompatible version, browser crash, timeout, malformed output, and cancellation reported? |
| Platform | Which Windows and POSIX environments are supported and tested? |
| Data handling | Does the worker operate without credentials, cookies, uncontrolled environment inheritance, or secret logging? |

The evidence must contain safe metadata only. It must not include bearer tokens,
cookies, browser profiles, private URLs, credentials, or raw uncontrolled
worker transcripts.

## 7. Proposed declarative task boundary

The following is a planning candidate for an AOM-facing browser task. It must
be reconciled with the verified external-worker contract before the Phase 10
plan is frozen. It is data passed inside the existing worker request, not a new
Worker Protocol message:

```json
{
  "contract_version": 1,
  "destination_id": "named-local-fixture",
  "steps": [
    { "op": "navigate", "destination_id": "named-local-fixture" },
    { "op": "wait_for", "selector": "#ready", "timeout_ms": 5000 },
    { "op": "assert_text", "selector": "#status", "contains": "ready" },
    { "op": "assert_url", "destination_id": "named-local-fixture" },
    { "op": "screenshot", "label": "ready-state" }
  ]
}
```

The candidate operation vocabulary is deliberately small:

| Operation | Meaning | Boundary |
|---|---|---|
| `navigate` | Navigate to a configured destination ID | No arbitrary URL or host |
| `wait_for` | Wait for a bounded selector condition | No script evaluation |
| `assert_text` | Compare bounded visible text | Result remains advisory |
| `assert_url` | Confirm the current page matches a configured destination | No URL chosen by the job |
| `screenshot` | Request a bounded capture through existing artifact handling | Server owns staging and metadata |

No `eval`, arbitrary script, arbitrary command, credential, cookie, upload,
download, form submission, click, purchase, deletion, or account operation is
part of this candidate contract. If the actual worker requires any of those
for its minimum operation, Phase 10 must return to architecture review.

The final plan must define byte/count bounds for every task field, the maximum
step count, selector/text restrictions, destination-name grammar, and the
owner of each validation. Existing AOM request and worker-runtime ceilings
remain upper bounds; they may not be silently enlarged.

## 8. Registry and executable ownership

The preferred integration uses one existing `workers.json` entry with the
existing local process adapter. The operator-owned registry remains the only
source of executable path, argv template, environment allowlist, timeout, and
worker enablement. Job input supplies only a registered worker ID and bounded
task data.

The plan must resolve all of the following before implementation authorization:

- whether the browser worker is already directly V1-compatible;
- whether a small external compatibility wrapper is needed;
- if a wrapper is needed, where it lives outside `domain/` and `store/`;
- whether browser-specific destination policy lives in the external worker's
  protected configuration or in an additional operator-owned configuration;
- how startup validates version and policy without adding a new authority path;
- how a disabled, missing, or incompatible worker fails closed.

No new AOM capability, actor, MCP tool, schema table, or migration is justified
merely to register a browser worker.

## 9. Worker Protocol V1 mapping

The existing protocol remains version 1 and unchanged:

- `start` is the existing private orchestrator-to-worker envelope;
- `ready`, `progress`, `result`, and `error` retain their current semantics;
- Phase 7 `evidence` and `artifact` messages retain their current semantics;
- malformed, oversized, incomplete, non-zero, timed-out, or cancelled output
  remains non-successful;
- worker diagnostics remain bounded and subject to Phase 9 redaction;
- no new message type or protocol version is introduced.

If the external worker cannot meet this mapping, any adapter must remain an
explicitly bounded compatibility layer outside AOM authority and persistence.
The adapter must not reinterpret a browser observation as an authoritative
decision.

## 10. Evidence and artifact mapping

Browser assertions enter through the existing evidence path with server-owned
`job_id`, `cycle`, `run_id`, source actor, trust, and bounds. Screenshots and
structured captures enter through existing artifact staging and registration:

- the server controls the staging root and final relative path;
- the server computes byte count and SHA-256;
- the worker cannot select an absolute storage path;
- artifact labels and worker text remain redacted before exposure;
- an artifact does not imply that the browser assertion is true;
- package and delivery behavior remain existing Codex-authority transitions.

The plan must explicitly distinguish deterministic fixture observations from
live-site observations. Public or mutable sites are not acceptance fixtures.

## 11. Lifecycle, recovery, and failure behavior

Browser runs use the existing `qa_dispatch` → run/lease → Worker Protocol V1
→ evidence/artifact → Codex decision flow. No separate browser lifecycle is
created.

| Condition | Required AOM treatment |
|---|---|
| Worker unavailable or disabled | Existing predictable worker failure; no authoritative change |
| Version/protocol mismatch | Reject before meaningful execution; no successful result |
| Browser startup failure | Existing run failure classification |
| Timeout | Existing `TIMEOUT` runtime settlement |
| Cancellation | Existing mechanical cancellation path |
| Crash/orphan | Existing Phase 8 recovery/reaper behavior |
| Malformed output | Existing `MALFORMED` behavior |
| Advisory PASS/FAIL | Evidence/run result only; Codex decides separately |
| External destination rejected | Bounded failure; no fallback navigation |
| Browser credential request | Reject; credentials are outside Phase 10 |

Automatic retries and replacement runs are explicitly excluded.

## 12. Schema, tool, and protocol impact

The proposed Phase 10 baseline is:

| Area | Decision |
|---|---|
| Database schema | No change |
| Schema version | Remain v7 |
| Migration | None |
| MCP business tool | None |
| Public capability | None |
| Worker actor model | Reuse existing worker model |
| Worker protocol | Version 1 unchanged |
| Worker message types | None added |
| Authority transitions | No change |
| Job lifecycle | No change |
| Run/lease lifecycle | Reuse existing behavior |
| Evidence/artifact schemas | Reuse existing behavior |
| Recovery/reaper | Reuse Phase 8 behavior |
| Rate limiting/redaction | Reuse Phase 9 behavior |

Any proposal that changes one of these values is a plan change requiring a new
architecture review.

## 13. Platform and fixture strategy

Acceptance fixtures must be deterministic and local. They should provide a
small static page or equivalent controlled target with stable selectors,
content, and capture output. They must not depend on public-site availability,
third-party accounts, network timing, or stored browser profiles.

The plan must define:

- the exact supported browser/worker platforms;
- Windows process-tree and path behavior;
- POSIX process-group and path behavior;
- browser binary ownership and version pinning;
- behavior when the browser executable is absent or unsupported;
- fixture startup and teardown without leaving processes or artifacts behind;
- complete Phase 4–9 regression execution.

A Windows result must not be presented as POSIX evidence, and a fixture pass
must not be presented as proof of compatibility with an unverified external
worker release.

## 14. Work packages and gates

| WP | Scope | Gate |
|---|---|---|
| WP0 | Record Phase 9 published baseline and clean starting point | documentation only |
| WP1 | Draft Phase 10 plan and proposed Revision 13 architecture delta | documentation only |
| WP2 | Identify the exact external browser worker and owner | blocking evidence |
| WP3 | Verify invocation, version, input, output, limits, and platform contract | blocking evidence |
| WP4 | Freeze AOM/external-worker trust and ownership boundary | architecture decision |
| WP5 | Freeze declarative task and destination-policy contract | architecture decision |
| WP6 | Map the contract to Worker Protocol V1 | scope gate |
| WP7 | Map assertions/captures to evidence/artifact admission | scope gate |
| WP8 | Freeze lifecycle, timeout, cancellation, recovery, and failure behavior | lifecycle gate |
| WP9 | Define deterministic fixtures and Windows/POSIX evidence | verification gate |
| WP10 | Freeze compatibility/version policy and non-goals | architecture gate |
| WP11 | Freeze the 48-case acceptance matrix | evidence gate |
| WP12 | Freeze the documentation-only planning snapshot | clean-tree gate |
| WP13 | Independent architecture review | required before authorization |
| WP14 | Codex adjudication and documentation corrections | required before authorization |
| WP15 | Targeted re-review if a substantive blocker changes the plan | conditional |
| WP16 | Separate Codex implementation-authorization decision | explicit YES/NO |
| WP17 | Future implementation and full regression review | not authorized by this plan |

WP17 is future work only. This document authorizes none of it.

## 15. Acceptance matrix

The exact planned matrix contains **48 cases**:

```text
BASE 4 + REGISTRY 6 + CONTRACT 8 + PROTOCOL 6
+ EVIDENCE/ARTIFACT 6 + AUTHORITY 6 + LIFECYCLE 6
+ PLATFORM/REGRESSION 6 = 48
```

### BASE — P10-BASE-01 through P10-BASE-04

| ID | Acceptance condition |
|---|---|
| P10-BASE-01 | Published Phase 9 baseline and current main are recorded exactly |
| P10-BASE-02 | Phase 10 planning snapshot is documentation-only |
| P10-BASE-03 | Schema remains v7 and no migration is proposed |
| P10-BASE-04 | No Phase 11 or later feature appears |

### REGISTRY — P10-REG-01 through P10-REG-06

| ID | Acceptance condition |
|---|---|
| P10-REG-01 | Exactly one external browser worker is represented by an operator-owned registry entry |
| P10-REG-02 | Codex selects only the registered worker ID |
| P10-REG-03 | Job input cannot replace executable, argv, environment, or timeout policy |
| P10-REG-04 | Disabled or missing worker fails predictably without authority change |
| P10-REG-05 | Version/protocol incompatibility is detected before meaningful execution |
| P10-REG-06 | Browser registration requires no authority or store modification |

### CONTRACT — P10-CON-01 through P10-CON-08

| ID | Acceptance condition |
|---|---|
| P10-CON-01 | Browser task uses a bounded declarative operation set |
| P10-CON-02 | Arbitrary JavaScript is not admitted |
| P10-CON-03 | Destination policy rejects non-admitted destinations |
| P10-CON-04 | Worker cannot change run, job, cycle, or destination binding |
| P10-CON-05 | Worker/job cannot select arbitrary executables or flags |
| P10-CON-06 | Credentials, cookies, and secret-bearing browser state are excluded |
| P10-CON-07 | Irreversible external actions are excluded |
| P10-CON-08 | Browser policy remains external/config-owned rather than authority-owned |

### PROTOCOL — P10-PRO-01 through P10-PRO-06

| ID | Acceptance condition |
|---|---|
| P10-PRO-01 | Worker communicates using protocol version 1 |
| P10-PRO-02 | Existing line, output, message, stderr, and timeout bounds remain unchanged |
| P10-PRO-03 | No new worker message type is required |
| P10-PRO-04 | Malformed browser output remains non-successful |
| P10-PRO-05 | Existing result/error semantics are sufficient |
| P10-PRO-06 | Phase 9 redaction applies to browser diagnostics and output |

### EVIDENCE/ARTIFACT — P10-EA-01 through P10-EA-06

| ID | Acceptance condition |
|---|---|
| P10-EA-01 | Screenshot uses existing artifact admission |
| P10-EA-02 | Artifact path remains server-controlled and relative |
| P10-EA-03 | Artifact bytes and hash remain server-computed |
| P10-EA-04 | Browser assertions use existing evidence admission |
| P10-EA-05 | Worker cannot self-select principal trust or authority |
| P10-EA-06 | Fixture input/version identifies the corresponding assertion step |

### AUTHORITY — P10-AUTH-01 through P10-AUTH-06

| ID | Acceptance condition |
|---|---|
| P10-AUTH-01 | Browser PASS cannot approve a job |
| P10-AUTH-02 | Browser FAIL cannot reject a job |
| P10-AUTH-03 | Browser worker cannot access `codex_decide` |
| P10-AUTH-04 | Browser worker receives no principal capability |
| P10-AUTH-05 | Codex remains the sole authoritative decision actor |
| P10-AUTH-06 | No browser-output field selects an authoritative transition |

### LIFECYCLE — P10-LIFE-01 through P10-LIFE-06

| ID | Acceptance condition |
|---|---|
| P10-LIFE-01 | Browser dispatch uses existing `qa_dispatch` |
| P10-LIFE-02 | Run settlement uses existing Phase 6 rules |
| P10-LIFE-03 | Timeout uses existing runtime semantics |
| P10-LIFE-04 | Cancellation uses existing runtime semantics |
| P10-LIFE-05 | Restart/orphan handling uses existing Phase 8 rules |
| P10-LIFE-06 | No automatic retry or replacement run is introduced |

### PLATFORM/REGRESSION — P10-PLAT-01 through P10-PLAT-06

| ID | Acceptance condition |
|---|---|
| P10-PLAT-01 | Windows AOM regression suite remains green |
| P10-PLAT-02 | POSIX AOM regression suite remains green |
| P10-PLAT-03 | Unsupported browser-worker platform is reported explicitly |
| P10-PLAT-04 | Complete Phase 4–9 regressions remain green |
| P10-PLAT-05 | Production MCP tool inventory is unchanged |
| P10-PLAT-06 | No `agy`, cloud, remote-worker, scheduler, telemetry, deployment, or Phase 11 feature appears |

## 16. Blocking decisions and risks

The following decisions are blocking before implementation authorization:

1. Exact external worker identity, version, owner, and executable location.
2. Exact invocation and Worker Protocol V1 compatibility.
3. Exact declarative operation schema and bounds.
4. Destination/host allowlist ownership and enforcement evidence.
5. Screenshot/evidence compatibility with existing admission paths.
6. Supported Windows/POSIX worker and browser versions.
7. Version mismatch and unavailable-worker behavior.
8. Proof that no credentials or arbitrary code are required.

Primary risks are external contract drift, browser nondeterminism, destination
policy ambiguity, trust overstatement, platform mismatch, and pressure to add
credentials or arbitrary actions. Each risk is an architecture or scope gate,
not permission to widen implementation.

## 17. Governance and authorization

The required sequence is:

1. Keep Phase 9 published state unchanged.
2. Review this documentation-only Phase 10 proposal independently.
3. Resolve every blocking external-worker decision with safe evidence.
4. Apply documentation-only corrections if required.
5. Freeze the exact planning snapshot with base SHA, planning SHA, tree SHA,
   changed paths, and clean tree.
6. Obtain independent architecture review of that exact snapshot.
7. Codex adjudicates every finding.
8. Conduct targeted re-review if a substantive architecture blocker changes.
9. Codex records a separate decision:

   ```text
   AUTHORIZE PHASE 10 IMPLEMENTATION: YES / NO
   ```

10. Only an explicit `YES` permits a separately frozen implementation branch.
11. Future implementation must remain within this plan and pass all 48 cases
    plus complete Phase 4–9 regressions.
12. Independent implementation review and a separate Codex merge/publication
    gate are required afterward.

Documentation approval never authorizes implementation.

## 18. Current decision

```text
PHASE 9: COMPLETE, MERGED, PUBLISHED, AND CLOSED
PHASE 10: PLANNING ONLY
PHASE 10 IMPLEMENTATION: NOT STARTED
PHASE 10 IMPLEMENTATION AUTHORIZED: NO
PHASE 10 PLAN: PROPOSED FOR INDEPENDENT ARCHITECTURE REVIEW
```

**PHASE 10 PLAN READY FOR INDEPENDENT ARCHITECTURE REVIEW**
