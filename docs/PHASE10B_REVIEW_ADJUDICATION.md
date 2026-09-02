# AOM Phase 10B — Codex Adjudication of Independent Opus Review

Status: documentation-only adjudication. This file records decisions on the
independent Opus security review; it does not authorize implementation.

## 1. Adjudication basis

The independent review was supplied as the complete
`OPUS_P10B_SECURITY_REVIEW.md` report and read to EOF. It reviewed the exact
Phase 10B planning snapshot at:

- Branch: `codex/phase10b-scoped-delegation-plan`
- Reviewed commit: `fe5cb110126a24f92cb1d62a07d737db10063dea`
- Reviewed tree: `10983bd0976fd90f9e6c7f9ca302109156a76454`
- Baseline: `751e99c58e020b3f9de75a0757473369f9f26662`

The review verdict was `PASS WITH REQUIRED CHANGES`, with the C-first
server-side delegation model accepted, full-principal-bearer removal required,
Gateway containment conditional, `codex_decide` viable, one blocking finding,
four high-severity findings, and implementation not ready/authorized.

The report is treated as an advisory independent review, not as an authority
to implement. Its source-grounded claims were re-checked against the current
AOM baseline before the decisions below.

## 2. Snapshot and review-scope verification

| Check | Result | Evidence/qualification |
| --- | --- | --- |
| Branch | VERIFIED | Local branch is `codex/phase10b-scoped-delegation-plan`. |
| Reviewed HEAD | VERIFIED | Local HEAD equals `fe5cb110...63dea`. |
| Reviewed tree | VERIFIED | Local tree equals `10983bd...76454`. |
| Baseline parent | VERIFIED | Local parent equals `751e99c...f26662`. |
| Working tree before adjudication | VERIFIED CLEAN | No pre-existing changes were present. |
| Four-file planning scope | VERIFIED | Baseline diff contains only the four Phase 10B planning documents. |
| Complete report read | VERIFIED | Supplied report contains 499 lines and was read in full. |
| Reviewer process authenticity | QUALIFIED | The report's target and claims match local evidence; an external model's execution cannot be cryptographically attested from this repository. |
| Gateway changes | VERIFIED UNCHANGED FOR THIS TASK | This adjudication does not modify or operate the Gateway. |

## 3. Source re-verification of major review claims

| Claim | Result | Source-grounded conclusion |
| --- | --- | --- |
| A. `state.ts` actor/cardinality behavior | VERIFIED | `validateActorRows` requires exactly one enabled `codex` principal and exactly one enabled `system` actor with no public capabilities. |
| B. Observer capability set | VERIFIED | Current `observer` role permits only `job:read`; it has no write, worker, or authority capability. |
| C. Observer transport token legal | VERIFIED STRUCTURALLY | `actor_tokens` may reference non-system actors, and startup usability is not restricted to principal tokens. Presence of a particular current observer row is not claimed without a DB inspection. |
| D. `codexDecide.ts` authority gate | VERIFIED | Tool visibility requires verified actor ID `codex`, principal role, and `job:decide`. |
| E. `decide.ts` authority choke point | VERIFIED | Domain `requireAuthority` repeats identity, role, capability, and canonicality checks before the transaction. |
| F. Literal `actor_id === 'codex'` coupling | VERIFIED | The literal coupling exists in both MCP tool registration and domain authority checks. |
| G. `actor_tokens` behavior | VERIFIED | Tokens store SHA-256 digests and verified session attribution; system tokens are rejected; actor role/capability checks are repeated on resolution. |
| H. Existing restricted caller identity | PARTIAL | Observer is safe for read-only transport hardening. No current identity has `delegation:request`; a distinct edge transport role/authentication class is required for future issuer admission. |

## 4. Finding-by-finding adjudication

| Finding | Reviewer severity | Codex decision | Rationale | Documentation change | Implementation gate |
| --- | --- | --- | --- | --- | --- |
| BLK-1 — issuer authentication and issuance policy/quota undefined | BLOCKING | ACCEPT WITH MODIFICATION | AOM must authenticate a non-principal edge transport identity for request-only admission, and AOM must enforce finite durable quotas before issuing any record. | Added the issuer model, `delegation:request` semantics, hard ceilings, tiers, quotas, and emergency disable. | Focused independent re-review before any issuer implementation. |
| H-1 — AOM cannot verify individual OAuth-session subject | HIGH | ACCEPT WITH MODIFICATION | The current architecture has no AOM-side OpenAI OAuth artifact verifier. A truthful S3 integration-bound model is safer than an invented per-session guarantee. | Removed per-session security claims; bind to registered integration and treat session labels as attribution only. | Re-review the downgraded claim and integration binding. |
| H-2 — OAuth revocation does not cascade | HIGH | ACCEPT WITH MODIFICATION | AOM can enforce an integration-generation cascade, but under S3 it cannot observe OAuth logout as an independently verified event. | Added durable integration generation, next-check invalidation, and explicit OAuth-revocation residual window. | Re-review revocation semantics and operational emergency procedure. |
| H-3 — read path retains principal bearer | HIGH | ACCEPT | Existing observer semantics are structurally read-only and startup-legal. Moving reads first materially reduces present blast radius without changing public tools. | Added Milestone A / `10B.0A` observer-token read hardening. | Separate bounded implementation check before delegation work. |
| H-4 — literal `codex` coupling | HIGH | ACCEPT WITH MODIFICATION | Delegated authority cannot be an additive wrapper; both MCP and domain gates require a reviewed core change. | Resolved delegated action as a `codex` principal act through constrained context and named the core-authority stage. | Dedicated T4 core-authority review; `codex_decide` remains blocked. |
| M-1 — backup/restore and clock behavior | MEDIUM | ACCEPT | Wall-clock expiry alone does not stop rollback/point-in-time resurrection. A fail-closed clock guard and post-restore authorization epoch are justified. | Added zero expiry grace, 30-second not-before tolerance only, rollback guard, and restore epoch. | Adversarial restore/clock tests before writes. |
| M-2 — issuance quota only a question | MEDIUM | ACCEPT | Unlimited automatic grants are a direct authority-amplification path under full Gateway compromise. | Promoted quota to a named security property and supplied tier ceilings. | Durable quota implementation and flooding tests. |
| M-3 — canonicalization needs adversarial tests | MEDIUM | ACCEPT | The design is sound only if every ambiguity class is tested rather than assumed. | Added explicit key/order/null/Unicode/UTF-8/number/schema-version tests. | 10B.3 adversarial test gate. |
| L-1 — delegation ID entropy unspecified | LOW | ACCEPT | Enumeration/guessing risk has a concrete minimum. | Delegation IDs require at least 128 bits of CSPRNG entropy. | Entropy and uniqueness test. |
| L-2 — audit reason codes | LOW | ACCEPT | Free text creates leakage and inconsistent queries. | Purpose/action/reason values are fixed, versioned enums with bounded detail. | Audit schema and leakage test. |
| L-3 — HTTP/stdio parity | LOW | ACCEPT | A transport difference could otherwise widen authority. | Identical authorization decisions for identical verified contexts are explicit. | Cross-transport parity test. |

No finding is silently ignored. The prior Opus verdict remains valid for the
old snapshot; this adjudication changes the planning documents only.

## 5. BLK-1 final resolution

### 5.1 Issuer authentication

After principal-bearer removal, the Gateway authenticates to a fixed AOM-local
issuer/request path using an AOM-issued restricted edge transport identity.
The future identity is conceptually a distinct `edge` role/authentication class
with only `delegation:request` admission. It is not the `codex` principal, does
not have `job:create`, `job:start`, `job:resume`, `qa:request`, `work:report`,
`job:decide`, `delegation:issue`, or direct mutation authority, and cannot
approve a delegation.

The current `observer` role is not overloaded with `delegation:request`.
Observer is reserved for the earlier read path and remains `job:read` only. A
future implementation must extend the role/authentication model or introduce
an equivalent restricted authentication class through a separately reviewed
source/schema change.

The restricted credential authenticates only this statement:

> This caller is the registered edge integration and may enter AOM's
> delegation-policy evaluation path.

It does not authenticate this statement:

> This caller may issue or approve an arbitrary delegation.

### 5.2 AOM-owned issuance decision

AOM alone evaluates whether a record is created. It evaluates operation class,
tier, integration state, resource constraints, canonical payload, lifecycle
state, approval class, quota, policy version, and authorization epoch. A
caller-supplied actor ID, capability list, session label, or hash cannot approve
issuance.

The restricted edge identity may be held by a compromised Gateway, so its
credential is not treated as an unstealable trust anchor. Security depends on
AOM-only issuance policy and the finite ceilings below. AOM counts authenticated
issuance attempts, including denied attempts, in durable rolling buckets. A
Gateway restart or cache deletion cannot reset them.

## 6. Issuance ceilings and risk matrix

The following are hard starting ceilings for one registered local integration.
They are not caller-configurable and may be reduced by review, but may not be
raised without a new security decision.

| Tier | Operation class | Automatic issuance | Approval | Max TTL | Uses | Max active | Issuance attempt quota |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T0 | Existing reads | Existing Stage-0 policy only | None beyond existing auth | Existing read policy | Non-mutating | N/A | No delegated write grant |
| T1 | Bounded `job_create` | Yes, only after operator bootstraps/enables T1 policy | No per-task Owner prompt | 5 minutes | 1 | 4 | 10 attempts / 10 minutes / integration |
| T2 | `job_start` / `job_resume` | No in initial design | Explicit owner approval | 2 minutes | 1 | 2 | 4 attempts / 10 minutes / integration |
| T3 | `qa_dispatch` / external work | No | Explicit owner approval | 60 seconds | 1 | 1 | 1 attempt / 30 minutes / integration |
| T4 | `codex_decide` | Never remotely automatic in this baseline | Future explicit authority/owner approval only | 30 seconds if later approved | 1 | 1 | No automatic issuance; hard emergency disable applies |

The values are justified by the product/security balance: T1 supports routine
autonomous work without an Owner-secret prompt on every task while bounding a
compromised edge process to a small short-lived burst. T2 and T3 advance
lifecycle or external work and therefore tighten time, active, and rate bounds.
T4 remains disabled rather than trading away sole-authority safety for
convenience.

In addition to the table, AOM enforces:

- one active T1 grant for a canonical payload/resource tuple;
- operation-class and resource-specific ceilings;
- maximum use count encoded by the record, never by Gateway state;
- a global emergency issuance disable;
- durable quota state and active-grant state;
- no per-ChatGPT-session security quota under S3, because that subject is not
  independently verifiable. Integration identity is the hard security bucket.

Owner approval is required initially for T2/T3 and would be required for any
future T4. Routine T1 policy issuance is the autonomy-preserving exception,
subject to the hard AOM ceiling. Approval never bypasses global disable,
operation bounds, or one-use rules.

## 7. H-1 subject-binding decision

Choose **S3 — integration-bound subject**.

AOM does not currently have a trustworthy, independently validated OpenAI
OAuth artifact and must not invent one or become coupled to OAuth token
introspection merely to make a security claim sound stronger. The authoritative
subject is the AOM-registered edge integration/transport identity. A Gateway
session ID or ChatGPT session label may be retained as untrusted attribution,
but it cannot authorize, isolate, revoke, or supply a security-grade quota.

The result is deliberately narrower in claim and stronger in honesty:

- cross-integration use is rejected;
- individual ChatGPT OAuth sessions are not claimed to be isolated by AOM;
- OAuth revocation alone is not claimed to be an AOM-visible revocation event;
- short tiered TTLs, one-use grants, integration revocation, and emergency
  issuance disable bound the residual risk.

## 8. H-2 revocation cascade

Each delegation binds to the current AOM-owned `integration_generation`.
Disabling/revoking the integration increments that generation. Every AOM
authorization check reads the current generation and rejects older grants. This
is immediate at the next check and does not require mass-updating or deleting
historical rows.

Because of S3, the Gateway cannot be trusted to tell AOM that one ChatGPT OAuth
session logged out. If individual OAuth revocation must be acted on, the
operator revokes the AOM integration or its restricted edge identity. The
remaining OAuth-only window is bounded by the tier TTL and one-use policy; it
is not silently presented as zero. A future S1/S2 artifact could add individual
session cascade, but it is not part of this adjudicated baseline.

## 9. H-3 principal-bearer reduction

Adopt the reviewer's recommendation as an early hardening stage:

- **Milestone A / 10B.0A:** current Stage-0 reads use a separate existing
  observer token with `job:read` only. The public tools remain exactly `ping`,
  `job_list`, `job_get`, and `run_status`.
- No observer token receives `delegation:request`, write capability, worker
  capability, or authority capability.
- **Milestone B:** before any public write, the Gateway possesses no direct full
  AOM principal bearer or fallback path. The old credential is revoked/rotated
  and its absence/use failure is tested.

Milestone A reduces today's read-path blast radius. It does not by itself
solve write delegation. No write may ship while Milestone B is incomplete.

## 10. H-4 and delegated `codex_decide` semantics

Adopt H-4 with a core-change qualification. The future implementation must
change both the MCP gate in `src/mcp/tools/codexDecide.ts` and the domain choke
point in `src/domain/decide.ts`; the literal `actorId === 'codex'` check cannot
remain the only representation of an accepted authority context.

The semantic decision is **A: a principal act through a constrained delegated
authority path**. It is not B, a second independent policy-mediated authority
system. The distinction is:

- `transport_actor`: restricted edge identity;
- `authority_principal`: the sole `codex` principal;
- `auth_mode`: reviewed delegated authority;
- `delegation_id`: exact one-use authorization record.

The decision row continues to attribute authority to `codex`; audit/provenance
must additionally record the verified transport/delegation context without
exposing secrets. The future T4 transaction must consume the exact payload-
bound grant, validate evidence/lifecycle/version, write decision/job/idempotency
/audit atomically, and reject any mismatch. `codex_decide` remains local-only
until that core change and its independent high-risk review pass.

## 11. Codex name versus authority semantics

| Concept | Adjudicated meaning |
| --- | --- |
| Actor ID | Historical V1 database identity `codex`; exactly one enabled principal. |
| Principal role | The sole authority role, requiring `job:decide`. |
| `job:decide` | Existing principal capability; not granted to the edge identity. |
| `codex_decide` | Existing authority tool name and choke point; future delegated access needs a core review. |
| Codex development governance | Codex remains the development/merge/authorization authority for this project. |
| ChatGPT runtime controller | Intended final runtime controller, operating through the same sole-principal authority model rather than a second principal. |

The actor name is not an executable requirement. No `chatgpt` principal is
created.

## 12. Backup and clock policy

- AOM server UTC wall-clock is the expiry source.
- Expiry has zero positive grace; skew must never extend validity.
- A maximum 30-second tolerance may apply only to `not_before` scheduling, not
  to expiry or a committed mutation.
- A persisted high-water time detects rollback. A backward jump greater than 30
  seconds enters a fail-closed clock guard for new issuance and delegated
  mutation until operator correction/acknowledgment.
- Restore requires a trusted authorization/deployment epoch not restored from
  the same database snapshot, or an explicit operator rotation immediately
  after restore. Every delegation is bound to that epoch.
- If epoch verification fails, issuance and delegated mutation are denied.
- A backup restored before consumption/revocation must not revive a grant;
  pre-restore grants are invalidated by the new epoch. Preserving them would
  require an authenticated journal outside this phase.

## 13. Canonicalization and low-severity hardening

The existing AOM-side canonicalization design is retained. Before any write,
tests must adversarially cover:

- recursive key ordering and duplicate keys;
- unknown fields;
- omitted versus default and omitted versus explicit `null`;
- Unicode normalization/code-point and invalid UTF-8 behavior;
- array ordering/set semantics;
- integer, float, exponent, and negative-zero representation;
- schema/policy-version mismatch;
- exact operation/tool/resource/cycle/version/payload binding.

Delegation IDs require at least 128 bits of CSPRNG entropy and uniqueness.
Audit action, purpose, and reason fields are fixed versioned enums; sensitive
free text is not an authorization input. HTTP and stdio must make identical
authorization decisions for the same verified context and request.

## 14. Revised implementation sequence

These are future gates, not current authorization:

1. **10B.0 — Adjudication and focused re-review.** Review these corrections;
   no source/schema work.
2. **10B.0A — Observer read hardening.** Replace the Stage-0 read bearer with
   observer `job:read` only; no public tool change.
3. **10B.1 — Internal context/policy model.** Define edge identity,
   `delegation:request`, S3 binding, quotas, generations, epochs, and context
   separation without public writes.
4. **10B.2 — Durable delegation and quota records.** After migration approval,
   add immutable caveats, status, consumption, revocation, generation/epoch,
   quota, and provenance constraints.
5. **10B.3 — Adversarial and atomicity tests.** Include issuer flooding,
   canonicalization, replay, TOCTOU, rollback/restore, revocation races,
   source/raw-SQL integrity, and HTTP/stdio parity.
6. **10B.4 — Preview-only T1.** Exercise `job_create` policy without durable
   mutation.
7. **10B.5 — Milestone B.** Remove/revoke the full principal bearer from the
   Gateway and prove no fallback path exists.
8. **10B.6 — T1 live gate.** Expose only bounded one-use `job_create`, creating
   `CREATED` with no start, worker, evidence, artifact, or authority action.
9. **10B.7 — T2 lifecycle gate.** Separately review `job_start`/`job_resume`.
10. **10B.8 — T3 worker gate.** Separately review `qa_dispatch` and lease
    isolation.
11. **10B.9 — T4 core-authority gate.** Modify and review `decide.ts` and
    `codexDecide.ts`; keep `codex_decide` blocked until approved.

The non-negotiable ordering rule is: **no public write before Milestone B**.

## 15. Independent re-review gates

One focused independent architecture/security re-review is required now,
covering at minimum:

- BLK-1 restricted issuer identity, request-only capability, quota buckets,
  active limits, TTLs, approval policy, and emergency disable;
- H-1 S3 integration-bound subject claim and the removal of unsupported
  per-session assertions;
- H-2 integration-generation cascade and explicit OAuth-revocation residual
  window;
- H-3 ordering of observer read hardening and full principal-bearer removal;
- H-4 principal-act semantics and the named core-authority change;
- M-1 restore epoch/clock guard and M-2/M-3 testability.

Later independent reviews are mandatory before:

- any public T1 write;
- T2/T3 exposure;
- the T4 `codex_decide` core change, which requires its own high-risk review
  even if lower tiers pass.

## 16. Remaining blockers

The previous single blocker is addressed at the architecture level, but the
architecture is **not implementation-ready yet**. The remaining gate is the
focused independent re-review of this corrected design. Implementation also
needs later decisions on the concrete local edge-credential transport, the
exact actor/schema representation of the restricted edge identity, durable
quota-bucket schema, non-restored epoch operational storage, audit provenance
schema, and T4 owner/authority approval procedure.

These are bounded design-to-implementation gates, not permission to start
source work. No implementation, migration, public write, Gateway change,
Funnel change, Plugin change, push, PR, merge, or deployment is authorized.

## 17. Changed document set

This adjudication updates only the Phase 10B planning documents:

- `docs/PHASE10B_SCOPED_DELEGATION_PLAN.md`
- `docs/PHASE10B_THREAT_MODEL.md`
- `docs/PHASE10B_ALTERNATIVES.md`
- `docs/PHASE10B_EXTERNAL_REVIEW_PACKET.md`
- `docs/PHASE10B_REVIEW_ADJUDICATION.md`

## FINAL — Architecture adjudication after focused re-review

### 18. Final re-review decision

The focused independent Opus re-review is acknowledged as `PASS`. Its closure
claims are accepted: BLK-1 is closed at the architecture level, the C-first
opaque server-side model is accepted, the restricted edge identity and S3
integration-bound subject model are accepted, the observer read hardening is
safe to implement first, and no new blocking finding was introduced.

This is an architecture acceptance and implementation-planning decision. It is
not source authorization, schema authorization, public-write authorization,
Gateway authorization, or authority authorization.

### 19. U-1/U-2/U-3 disposition

- **U-1 accepted as a normative invariant:** the edge integration cannot
  self-provision a new actor, integration identity, or quota domain through any
  MCP/request path. Actor/integration provisioning remains a separately
  controlled local administration path. Identity proliferation must not reset
  quotas.
- **U-2 accepted as a system assumption:** quota, generation, epoch, and
  one-use atomicity rely on a single-writer AOM instance. Any future multi-node
  AOM requires a new review of serialization, quota atomicity,
  `integration_generation`, authorization epoch, and one-use consumption.
- **U-3 accepted as deny-by-default:** a future `edge` transport actor is not
  accepted by any existing authority gate merely because its name or role is
  present. Each edge gate must explicitly allow only the request-only issuer
  operation; all principal, worker, system, lifecycle, and decision gates deny
  it unless separately reviewed.

### 20. Final authorization-epoch direction

Choose **Option A with mandatory Option C procedure**: a small AOM-owned epoch
state record lives outside the restorable SQLite backup set, with Windows
current-user/admin ACL protection appropriate to the AOM installation. The
epoch is an opaque non-secret identifier; it does not require a secret merely
to name the authorization generation. The backup procedure must explicitly
exclude this state from the database snapshot.

Every delegation binds to the current epoch. After any point-in-time restore,
the operator must rotate the epoch before AOM accepts delegation issuance or
delegated mutation. If the epoch file is missing, unreadable, changed
unexpectedly, or cannot be reconciled with the active deployment, AOM fails
closed. A restored database therefore cannot revive a pre-consumption or
pre-revocation delegation. The exact path/ACL and rotation command are
implementation-bound decisions; they are not being created here.

### 21. Final restricted-edge identity representation

Choose **Option D — hybrid**:

1. Use the existing `observer` actor/token, with its existing `job:read` only
   semantics, for `10B.0A` Stage-0 read transport hardening.
2. Use a separate future non-principal `edge` transport identity for the AOM
   issuer-request path. It is represented in the AOM identity/audit model so
   it can be independently revoked and attributed, but it receives only the
   conceptual `delegation:request` admission capability.
3. Do not add `delegation:request` to `observer`, and do not create a separate
   authority system outside AOM actor/policy enforcement.

The current source has no `edge` role or `delegation:request` capability. A
future source/schema change must add explicit deny-by-default handling and
prove that the edge identity is rejected by all existing principal, worker,
system, lifecycle, and `codex_decide` gates.

### 22. Final `delegation:request` semantics

`delegation:request` means only that the authenticated edge integration may
enter AOM's issuance-policy evaluation path. It never means that the caller
may receive the requested capability, issue a record, approve a record, choose
the authority principal, refresh a record, widen caveats, or bypass quotas.
AOM independently evaluates operation, tier, integration state, resource,
canonical payload, approval, policy generation, epoch, and quota before it
creates a delegation.

### 23. Final quota atomicity direction

The likely future persistence design is a durable quota-bucket record keyed by
registered integration, tier, and a fixed rolling-window bucket, plus the
delegation active-state records. AOM uses `BEGIN IMMEDIATE` to authenticate the
request, count the attempt, check the per-tier and active-grant ceilings,
create the delegation if allowed, and update all quota state as one unit.

The same transaction boundary must prevent two concurrent requests from both
passing the active limit. Authenticated denied attempts consume the request
rate budget; successfully issued records consume the active-grant budget. A
quota-store read/write failure denies issuance and never falls back to a
principal bearer. This likely requires schema support, but no schema is added
in this adjudication.

### 24. Milestone-B bypass matrix

Before any public write, implementation evidence must prove the compromised
Gateway cannot authenticate as the principal through **any** supported path:

| Bypass vector | Required proof |
| --- | --- |
| AOM principal bearer in Gateway environment | Variable absent; process inspection and sanitized configuration check show no principal credential. |
| Principal bearer in durable Gateway state | State inventory contains no principal bearer; encrypted state cannot be used as an edge fallback. |
| Legacy configuration fallback | Old variable/file names and compatibility branches are absent or hard-fail. |
| Bootstrap token fallback | Bootstrap/initial token cannot authenticate the public edge path. |
| Recovery/admin token fallback | Recovery/admin credentials are not accepted by public or issuer routes. |
| Alternate public transport | HTTP, stdio exposure, and any other supported transport cannot select principal authentication. |
| Debug/admin route | No debug/admin route can forward or mint principal authority. |
| Old token still valid | The old principal token is revoked/rotated and a direct use test fails. |
| Alternate MCP endpoint | Discovery, legacy, and alternate paths cannot bypass the restricted route. |
| Accidental actor-token fallback | Missing/invalid edge identity never falls back to `codex`. |

Pass condition: a fully compromised Gateway cannot directly authenticate as the
AOM principal by any supported path. Milestone B must pass before `10B.6`
public T1 and must not be inferred from a successful read test.

### 25. Accepted residuals

**S3 shared-integration residual:** accepted for the planning baseline and
future T1 consideration. Multiple ChatGPT conversations/sessions using the
same integration are not cryptographically isolated by AOM. They share quota
and revocation domain; attribution is integration-level; Gateway-supplied
session labels are advisory. This must remain visible in product/security
documentation and must not later be upgraded to per-session security.

**T1 automatic residual:** accepted for a future separately authorized T1
stage only. A compromised edge may obtain some automatic T1 grants within the
finite AOM quota. The worst-case intended effect is a bounded number of inert
`CREATED` jobs because T1 has no auto-start, worker dispatch, lifecycle
mutation, evidence/artifact mutation, or authority. Higher tiers require
separate grants/approval, and Milestone B must already pass. T1 is not
authorized now.

### 26. Final staging and first candidate

The accepted staged sequence is:

1. `10B.0` — this final adjudication and focused re-review;
2. `10B.0A` — observer/read-path hardening;
3. `10B.1` — internal AuthorizationContext and issuance-policy foundations;
4. `10B.2` — delegation records, issuer boundary, generation, epoch, and
   quota structures;
5. `10B.3` — adversarial, security, quota, restore, rollback, and concurrency
   tests;
6. `10B.4` — preview-only T1;
7. `10B.5` — Milestone B full principal-bypass removal;
8. `10B.6` — bounded public T1 `job_create`;
9. `10B.7` — T2 lifecycle delegation;
10. `10B.8` — T3 worker dispatch;
11. `10B.9` — T4 `codex_decide` core-authority change and high-risk review.

**FIRST IMPLEMENTATION CANDIDATE: `10B.0A`**. It can be implemented
independently as a read-only credential migration with no public tool change,
no delegation system, no write, no worker, and no authority change. It still
requires a separate explicit implementation authorization.

### 27. `10B.0A` rollback and future live test

Before `10B.0A`, preserve the existing Phase 10A/10A.1 Git tags, the Gateway
baseline, the current Plugin configuration, and the current Funnel hostname.
Use a reversible configuration/credential cutover. If observer migration or
validation fails, restore the existing private read connectivity and keep all
writes blocked. Do not permanently delete the principal credential until
Milestone B has separately validated and removed every bypass path.

The minimal future live test is the existing ChatGPT Plus Stage-0 Read Plugin
calling `ping` through the same public endpoint, followed by `job_list` only
after ping succeeds and is separately allowed. Verify the same four-tool
surface, no OAuth reconfiguration where avoidable, restricted actor identity
in Gateway logs, and no principal credential use. No test in this plan
authorizes the live change.

### 28. Final T4 boundary and implementation governance

No work in `10B.0A` through `10B.8` may silently modify
`src/domain/decide.ts` or `src/mcp/tools/codexDecide.ts` for delegated authority.
`10B.9` is the only planned T4 core-authority stage and requires its own
independent high-risk review. The semantic rule remains a principal act of the
sole `codex` authority through a verified delegated context, not a second
authority system.

Architecture acceptance does not authorize implementation. Every stage needs
an explicit implementation prompt, bounded scope, tests, a commit boundary,
user authorization, and a stop before the next stage. No automatic continuation
to the next stage is permitted.

### 29. Final status

- Architecture blockers after focused re-review: **0**.
- Implementation-bound decisions remain and must be resolved before their
  relevant later stage, especially epoch storage/rotation, edge identity
  schema, quota persistence/atomicity, Milestone-B evidence, and T4 approval.
- First implementation candidate: **10B.0A read-path hardening**.
- Implementation, public write, authority, Gateway, Funnel, Plugin, push, PR,
  merge, and deployment: **not authorized**.
