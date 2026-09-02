# AOM Phase 10B — Delegation Architecture Alternatives

Status: design comparison only. The recommendation is not an implementation
authorization.

## 1. Evaluation criteria

Each option is evaluated against the actual Phase 10A problem: an internet-
facing Gateway currently has a credential stronger than the public edge
session. The criteria are:

1. AOM remains the final enforcement point.
2. A fully compromised Gateway cannot mint broader authority.
3. Exact operation/resource/request binding is practical.
4. Replay, revocation, and concurrency are enforceable.
5. The design does not create a second authority principal.
6. The full principal bearer can eventually be removed from the Gateway.
7. HTTP/stdio parity and current local behavior can be preserved.
8. Audit provenance is durable without secret leakage.
9. High-risk `codex_decide` can remain independently gated.
10. Operational complexity is proportionate to the risk.

## 2. Option A — Keep the full principal bearer and expand the Gateway allowlist

### Description

Keep the current Gateway-to-AOM principal bearer and treat the Gateway's
allowlist, OAuth session, and route checks as the authorization model. Add
write tools gradually to the allowlist.

### Benefits

- Lowest implementation effort.
- No new AOM persistence or issuer flow.
- Familiar current transport behavior.

### Security failures

- Does not solve the confused deputy. A compromised Gateway still holds the
  principal credential.
- AOM cannot bind the operation to the edge session or exact grant.
- Future allowlist/configuration mistakes have principal-level impact.
- Revoking one edge session does not necessarily revoke the downstream
  principal bearer.
- Cannot honestly claim that a public write is server-verified scoped
  delegation.

### Decision

Rejected as the Phase 10B target. It may remain a temporary Stage-0 read-only
containment implementation, but no write exposure should use it.

## 3. Option B — AOM-issued signed self-contained delegation proof

### Description

AOM issues a signed proof containing subject, audience, operation, resource,
request hash, expiry, and use policy. The Gateway presents it later. AOM
verifies the signature and caveats.

### Benefits

- Compact transport and potentially low-latency verification.
- AOM remains the issuer if the signing key stays exclusively in AOM.
- Exact caveats can be represented in a versioned proof.
- Gateway need not call AOM for every issuance lookup if an approved verifier
  path exists.

### Risks and limitations

- A signature alone does not provide revocation or one-time use; those still
  require AOM state or a separate nonce-consumption store.
- Giving the Gateway the signing key would recreate the confused deputy and is
  unacceptable.
- Key rotation, audience, canonicalization, proof size, and algorithm
  migration increase complexity.
- A stateless-looking proof can encourage accidental trust outside AOM.

### Decision

Conditional component only. It may be an optimization after the server-side
record model is proven. It is not the canonical authority source for the first
implementation.

## 4. Option C — AOM-owned opaque server-side delegation record

### Description

AOM creates an opaque unique delegation ID and stores all caveats, lifecycle
state, use count, revocation, and provenance in its durable store. The Gateway
transports the ID; AOM resolves and enforces it on every use.

### Benefits

- Directly addresses the confused deputy.
- Gateway cannot mint a valid record by choosing an ID.
- Revocation, one-use consumption, policy generations, and audit are natural
  server-side state.
- Exact request/resource/lifecycle checks occur at the final AOM boundary.
- No root signing key is needed in the Gateway.
- Supports later removal of the full principal bearer.

### Costs and risks

- Requires a durable schema and migration after separate approval.
- Adds an AOM lookup and transaction path.
- Requires careful concurrency, retention, indexing, and provenance design.
- A compromised Gateway can still spend a valid bounded record.

### Decision

Recommended canonical model. Use this as the C-first foundation.

## 5. Option D — Restricted non-principal edge actor

### Description

Create a new AOM actor/role for the Gateway with a fixed set of non-authority
capabilities, while keeping `codex` principal authority local. The Gateway
authenticates as that actor.

### Benefits

- AOM sees a distinct identity rather than the principal.
- Existing role/capability checks can deny `codex_decide` and worker authority.
- The existing observer role is already legal for a separate Stage-0 read token.
- A future edge transport identity can authenticate the issuer-request path
  without being a principal or receiving direct mutation capability.

### Risks and limitations

- A role/capability grant is broader than an exact one-job/one-payload
  delegation unless every operation adds another binding layer.
- A compromised edge actor may perform all operations granted to the role until
  token revocation/expiry.
- Adds a second transport-facing actor and can blur the single-principal
  architecture.
- Does not by itself solve replay, resource binding, or TOCTOU.
- The current observer role has only `job:read`; adding `delegation:request` to
  it would silently change observer semantics and is not acceptable.
- A future edge role/capability requires a separate source/schema review.
- It is suitable for the early read-only identity reduction but insufficient
  for T1–T4 writes without a delegation record and AOM issuance policy.

### Decision

Not sufficient as the Phase 10B primary model. Use the existing observer role
for the bounded read-path reduction, and use a separately reviewed restricted
edge transport identity underneath Option C for issuer admission. It must not
replace exact server-side grants or create a competing authority principal.

## 6. Option E — Hybrid: server-side record plus AOM-issued proof

### Description

Use Option C as the canonical source of authority and optionally include an
AOM-issued integrity proof containing a versioned reference/caveat summary. AOM
still loads the record, checks current status/revocation/policy, recomputes the
request hash, and consumes the record transactionally.

### Benefits

- Keeps revocation and use state server-side.
- Can optimize transport or reduce accidental ID mix-ups.
- Allows future proof-based routing without giving the Gateway a signing key.
- Retains a simple security argument: the record, not the proof, authorizes.

### Costs and risks

- More moving parts than pure Option C.
- Duplicate representation can create proof/record mismatch bugs.
- Requires disciplined key management and versioning.
- A proof must never become a shortcut around record checks.

### Decision

Recommended only as a later optimization on top of Option C. The initial
implementation should avoid it unless a measured need and independent review
justify the added complexity. The plan calls this “C-first hybrid.”

## 7. Comparison table

| Criterion | A bearer + allowlist | B signed proof | C opaque record | D edge actor | E C + proof |
| --- | --- | --- | --- | --- | --- |
| Solves root confused deputy | No | Yes if key AOM-only | Yes | Partly | Yes |
| Gateway can mint authority | Holds bearer | No if no key | No | Can use role grant | No if no key |
| Exact request binding | Weak/edge-only | Strong if verified | Strong | Requires extra layer | Strong |
| Durable revocation | Token/process dependent | Needs state | Native | Token/process dependent | Native |
| One-use writes | Not native | Needs state | Native | Not native | Native |
| TOCTOU protection | Existing handler only | Needs AOM transaction | Native design | Needs extra layer | Native design |
| Full bearer removal | No | Yes | Yes | Yes for edge token | Yes |
| Risk of second authority | Existing confusion | Low | Low | Medium | Low |
| Implementation complexity | Low | Medium/High | Medium | Low/Medium | High |
| `codex_decide` suitability | Unsafe | Conditional | Conditional with T4 gate | Unsafe alone | Conditional with T4 gate |

## 8. Recommendation

Select Option C as the canonical Phase 10B architecture:

- AOM issues and owns the record.
- The Gateway receives only an opaque, bounded result.
- AOM verifies exact caveats and request binding.
- AOM consumes one-time grants atomically with mutations.
- AOM owns revocation and policy invalidation.
- The Gateway authenticates issuer requests as a restricted non-principal
  edge identity with conceptual `delegation:request` admission only.
- AOM applies finite per-integration/per-tier quotas, active-grant ceilings,
  short tiered TTLs, and a global emergency disable.
- The Gateway holds no root signing key and, at the hardening milestone, no
  full principal bearer.
- The default subject binding is integration-level (S3), not a claimed
  independently verified ChatGPT OAuth session.

Keep Option E as a future optimization path, not a prerequisite. Do not select
Option A for writes. Do not treat Option D as a substitute for exact
delegation. Keep Option B conditional on a complete revocation/use design.

The current observer identity is a separate early hardening measure for reads;
it is not the issuer credential and does not receive `delegation:request`.

## 8.1 Adjudicated trust decisions

- **Issuer authentication:** a future AOM-issued restricted edge transport
  identity, represented by a separately reviewed edge role/authentication
  class, authenticates the Gateway to the request-only issuer path. The
  credential proves registered integration identity only.
- **Issuance authority:** AOM policy alone decides whether a record is created.
  The request credential cannot issue, approve, refresh, or widen grants.
- **Subject binding:** S3 integration-bound is selected because AOM has no
  independent OpenAI OAuth artifact verifier in the current architecture.
- **Revocation:** AOM integration-generation revocation invalidates older
  records at the next check. OAuth logout alone is not asserted to be an
  AOM-visible per-session cascade under S3.
- **Authority semantics:** a future delegated `codex_decide` remains an act of
  the sole `codex` principal through a core-reviewed delegated context, not a
  second policy-mediated authority system.

## 9. Decision gates by operation

| Operation | Recommended mechanism | Gate |
| --- | --- | --- |
| Existing Stage-0 reads | Current read-only containment | No Phase 10B expansion |
| First future write (`job_create`) | Option C one-use exact record | Separate implementation and live-test authorization |
| Lifecycle (`job_start`/`job_resume`) | Option C exact job/cycle/version | Separate review |
| Worker dispatch | Option C plus existing QA/lease gates | Separate high-risk review |
| `codex_decide` | Option C plus exact T4 approval/authority semantics | Last and independently reviewed |

## 10. Final alternative verdict

The server-side opaque record is the smallest design that directly closes the
actual trust-boundary defect while preserving AOM as the final authority. The
optional proof is deliberately secondary. No alternative is implementation-
authorized by this document.

## 10.1 Final adjudication status

The focused independent re-review passed with zero new blocking findings. The
final selection remains Option C as the canonical server-side record, with the
hybrid identity arrangement of an existing observer token for read hardening
and a distinct future edge transport identity for request-only issuer
admission. S3 integration-bound subject binding, finite AOM quotas, mandatory
full-principal removal before writes, and the restore-epoch procedure are
accepted planning constraints. No alternative authorizes implementation.
