# AOM Phase 10B — Server-Verified Scoped Delegation Plan

Status: architecture and threat-model planning only. This document is not an
implementation authorization, an API contract, or a migration specification.

## 0. Governance status

Phase 10A Stage-0 proved a read-only path from ordinary ChatGPT through the
Edge Gateway and Tailscale Funnel to the loopback AOM service. It deliberately
kept all write tools, worker dispatch, and `codex_decide` outside the public
surface. The reason is still open: the Gateway has access to a full AOM
principal bearer, while the public edge session is only intended to be a
read-only ChatGPT session. An edge allowlist is useful containment, but it is
not an AOM authorization boundary.

Phase 10B designs the missing server-verified delegation boundary. It does not
implement it, expose a write tool, change the live Gateway, change Funnel, or
authorize ChatGPT write access.

The final product goal remains that ChatGPT is the runtime controller while
Codex remains the development-governance authority and the AOM `codex`
principal remains the sole V1 authority identity. No second ChatGPT principal
or competing authority system is proposed.

### 0.1 Planning gate

| Item | State |
| --- | --- |
| Phase 10B source implementation | Not started |
| Schema/migration change | Not started |
| Public write exposure | Not authorized |
| `codex_decide` exposure | Not authorized |
| Gateway source/runtime change | Not authorized |
| Funnel/ChatGPT Plugin change | Not authorized |
| Independent architecture/security review | Required and not performed by this document |
| Codex adjudication | Required after independent review |
| User implementation authorization | Required after adjudication |

## 1. Verified planning baseline

The AOM planning branch was created from the exact Phase 10A closure commit.
The Gateway is a separate repository and is not modified by this planning
task.

### 1.1 AOM

- Repository: `C:\AgentProjects\agent-orchestrator-mcp`
- Baseline commit: `751e99c58e020b3f9de75a0757473369f9f26662`
- Baseline tree: `b7b66fb35ae311a0d6d14ae8723e0d3b6fb5d712`
- Planning branch: `codex/phase10b-scoped-delegation-plan`
- Starting branch state: clean before documentation additions
- Remote: `https://github.com/mostafanajee-coder/agent-orchestrator-mcp`

### 1.2 Gateway

- Repository: `C:\AgentProjects\aom-edge-gateway`
- Reviewed Stage-0 baseline: `4aa100ff078c6e18c7ebbf5b3621a4f077b4154f`
- Gateway tree: `98216c7b31f15c85c29db47de2c5c62ce0fbbbe1`
- Existing branch: `codex/phase10a-stage0-gateway`
- Gateway changes in this task: none

The Phase 10B branch is a documentation branch. It must not be pushed or
turned into an implementation branch until the separate governance gates have
completed.

## 2. Objective and precise security statement

### 2.1 Objective

Replace the unsafe implication that an internet-facing Gateway can exercise
the AOM principal simply because it has a principal bearer. A future Gateway
request must carry a narrowly scoped, AOM-verifiable delegation. The Gateway
may request or transport a delegation, but it must not be able to mint a
broader authority, edit its caveats, turn one resource into another, or turn a
read session into a principal session.

### 2.2 Security statement

If the Gateway, its process, its OAuth state, or its public edge session is
fully compromised, Phase 10B must prevent that compromise from producing an
unbounded AOM principal credential. A compromised Gateway may exercise only a
currently valid delegation that AOM itself issued, and only within the exact
operation, tool, resource, normalized request, lifecycle preconditions, time
window, use count, audience, and policy version recorded by AOM. For a
mutating operation, validation and consumption of the delegation must be
atomic with the domain mutation and its audit event.

This statement does not claim protection from compromise of AOM itself, the
host account that can administer AOM, or a legitimate Codex principal acting
within its authority. Those are separate trust assumptions.

## 3. Scope and non-goals

### 3.1 In scope for planning

- AOM-owned delegation issuance, verification, consumption, and revocation
  semantics.
- Binding a delegation to an edge session, AOM audience, operation, resource,
  request arguments, lifecycle state, and policy version.
- Replay and time-of-check/time-of-use resistance.
- A Gateway-compromise analysis.
- The special treatment required for `codex_decide`.
- A design-only schema and audit impact assessment.
- A risk-tiered implementation and review sequence.
- A first low-risk candidate for a future, separately authorized write.

### 3.2 Explicit non-goals

This phase does not:

- add a `delegations` table or any migration;
- add or rename an MCP tool;
- implement cryptography, signing, or verification code;
- change the actor/capability catalogue;
- expose `job_create`, `job_start`, `job_resume`, `qa_dispatch`, or
  `codex_decide` through the Gateway;
- redesign worker execution, browser automation, or remote workers;
- change OAuth provider behavior or ChatGPT configuration;
- modify or restart AOM, Gateway, Tailscale, or the live Plugin;
- create a Gateway branch, push, PR, merge, or deployment;
- authorize any public write or authority action.

## 4. Existing AOM authentication and authority model

This section records the model that the delegation design must preserve. It is
based on the current AOM baseline, not on a proposed implementation.

### 4.1 Actors and capabilities

The capability catalogue in `src/authority/capabilities.ts` is explicit:

`job:create`, `job:read`, `job:decide`, `qa:request`, `work:report`,
`evidence:add`, and `artifact:register`.

The V1 roles are principal, worker, observer, and system. The `codex`
principal is the one enabled authority actor. The `system` actor is internal
and has no transport token or capabilities. Role capability sets are
canonicalized and checked against the role; the principal must include
`job:decide`, while the system actor must have an empty capability set.

`src/authority/state.ts` enforces exactly one enabled `codex` principal and
one enabled `system` actor. It rejects system tokens, invalid token digests,
disabled/expired token records, and noncanonical capability data.

### 4.2 Persistent sessions

`actor_tokens` stores token digests and session attribution, not plaintext
bearers. `src/mcp/persistentAuth.ts` hashes the presented token, joins the
matching token to its actor, rejects invalid or system identities, and returns
verified actor ID, role, capabilities, token ID, session label, and expiry.

The token row identifies the authenticated session. It does not create a new
authority principal. Multiple sessions may map to the same `codex` actor, and
the session label is attribution only.

### 4.3 Three existing authority layers

The current server uses three complementary controls:

1. **Authentication:** the bearer resolves to a verified actor/token record.
2. **Visibility:** the request-specific MCP server registers only tools allowed
   to that actor.
3. **Handler enforcement:** the domain handler repeats the role, actor, and
   capability checks before performing work.

The edge Gateway's allowlist is outside these AOM layers. It can hide a tool
before forwarding, but it cannot turn a principal bearer into a lesser AOM
identity. Phase 10B must add a fourth property: AOM itself must verify the
delegation context at the final enforcement point.

### 4.4 Existing authoritative choke point

`src/mcp/tools/codexDecide.ts` exposes `codex_decide` only to a verified
`codex` principal with `job:decide`. `src/domain/decide.ts` repeats the
identity, role, capability, canonicality, job cycle, version, transition, and
evidence checks. The decision, job update, audit entry, and idempotency record
are performed through the immediate transaction path.

This is the boundary the future delegation context must enter. A delegation
must never be treated as a second route around `requireAuthority`.

### 4.5 Existing worker and lifecycle boundaries

Job lifecycle writes require the `codex` principal and `job:create`. QA
dispatch requires that principal and `qa:request`; worker reports require a
worker actor and `work:report`; readers are limited to principal/observer
`job:read`. Worker leases are already bound to run, job, cycle, and actor and
are consumed atomically in `BEGIN IMMEDIATE` transactions.

Phase 10B must preserve the difference between an AOM delegation to a
controlled client and a worker lease. A delegation is not a worker identity,
does not grant `work:report`, and does not replace an existing lease nonce.

## 5. Exact confused-deputy root cause

The Stage-0 topology is:

`ChatGPT edge session -> Funnel -> Gateway -> AOM loopback`

The Gateway authenticates the ChatGPT-facing session and applies a fixed
read-only public allowlist. To call AOM, however, it forwards using a full
`codex` principal bearer held in the Gateway's local configuration/state. AOM
therefore sees the principal bearer, not an independently verifiable fact that
the operation was authorized for this particular ChatGPT session, operation,
resource, or request payload.

That creates a confused deputy:

- ChatGPT is the untrusted/requesting edge client for the purpose of AOM
  authorization.
- The Gateway is a network-facing deputy with a credential stronger than the
  edge session.
- AOM trusts the stronger credential and cannot distinguish a request
  selected by the legitimate Gateway flow from one selected by a compromised
  Gateway process.
- A Gateway allowlist reduces accidental exposure but is not cryptographic or
  server-authoritative. A process compromise, configuration mistake, future
  allowlist change, or proxy bug can reuse the bearer against any AOM route it
  can reach.

The OAuth client ID, redirect URI, PKCE state, Owner secret, Tailscale identity,
and ChatGPT session are not substitutes for AOM authority. They establish
different relationships and must not be conflated.

## 6. Required security properties

Any implementation claiming to satisfy Phase 10B must demonstrate all of the
following. A missing property is a blocking security finding, not a tuning
issue.

1. **AOM issuance:** only an AOM-owned policy/issuer can create a delegation.
2. **No edge minting:** Gateway code cannot mint a valid broader delegation.
3. **Exact scope:** a delegation names one approved operation/tool and cannot
   be interpreted as a general capability grant.
4. **Resource binding:** where applicable, it binds to exact job, run, cycle,
   worker, or other resource identifiers.
5. **Request binding:** AOM computes the hash of its own validated,
   canonicalized request; a Gateway-supplied hash is not authoritative.
6. **Audience binding:** a proof for one AOM instance/environment is rejected
   by another audience.
7. **Subject binding:** the adjudicated baseline is integration-bound (S3),
   because AOM does not independently validate a ChatGPT OAuth artifact. AOM
   must bind a delegation to the verified registered edge integration identity
   and must not claim per-ChatGPT-session isolation. A copied grant cannot be
   moved to another integration.
8. **Time bounds:** issued/not-before/expiry windows are checked by AOM with a
   defined clock-skew rule and fail closed on invalid timestamps.
9. **Replay resistance:** one-time operations are atomically consumed; a
   repeated request cannot repeat the mutation.
10. **TOCTOU resistance:** delegation checks and the domain write share the
    same transaction and expected-version/precondition checks.
11. **Revocation:** AOM can revoke one delegation, a session's delegations, or
    an emergency policy generation without relying on Gateway memory.
12. **Restart durability:** revocation and consumption state survive process
    restarts and are unavailable when the authoritative store is unavailable.
13. **Auditability:** issuance, denial, use, consumption, replay, mismatch,
    expiry, and revocation are attributable without logging tokens/proofs.
14. **Least privilege:** a delegation cannot add capabilities to the actor or
    bypass role compatibility.
15. **Fail closed:** malformed, missing, stale, ambiguous, or unverifiable
    delegation context is denied before the domain mutation.
16. **Transport independence:** HTTP/stdio differences cannot change the
    delegation semantics or widen authority.

### 6.1 Normative issuance-quota property

**A valid transport identity cannot obtain unbounded delegated authority merely
by repeatedly requesting valid low-tier grants, including when the Gateway is
fully compromised.** AOM must enforce a durable, server-side issuance policy
before creating a delegation. The policy is keyed at least by the registered
edge integration/transport identity, operation tier, and bounded time window;
it counts denied as well as accepted issuance attempts so an attacker cannot
flood the policy with syntactically valid requests.

The hard ceiling includes all of the following:

- per-integration/edge-identity rolling issuance quotas;
- per-tier rolling quotas and maximum concurrently active grants;
- maximum TTL and maximum uses per tier;
- operation-class and resource-specific ceilings;
- a global emergency issuance disable that is evaluated by AOM;
- durable counters or equivalent state that do not reset on Gateway restart.

The selected S3 subject model does **not** make a caller-supplied ChatGPT
session ID a trustworthy quota key. A per-session quota may be added only as
telemetry or after an S1/S2 subject proof exists; the integration quota remains
the security ceiling in this baseline.

## 7. Trust-boundary model

```text
  ChatGPT / public client
          |
          | OAuth edge session; not an AOM principal
          v
  Tailscale Funnel (transport only)
          |
          v
  Edge Gateway
    - validates the public edge session locally
    - authenticates to AOM as a restricted edge transport identity
    - applies public allowlist
    - requests/transports delegation
    - MUST NOT mint or widen delegation
          |
          | loopback request carrying restricted edge identity + AOM-issued delegation
          v
  AOM authentication and delegation verifier  <--- AOM-owned policy/store
          |
          +--> MCP visibility and handler capability checks
          |
          +--> domain transaction + audit + idempotency
          v
  SQLite authority/lifecycle state

  Separate trusted paths:
    Codex/local principal -----------------------> AOM principal authority
    AOM runtime/system --------------------------> mechanical settlement only
    Worker process -- lease-scoped report path --> AOM worker boundary
```

### 7.1 Boundary rules

- Funnel carries bytes and TLS identity; it is not an authority issuer.
- OAuth authenticates the edge integration; it is not a replacement for the
  AOM actor/capability model.
- Gateway policy is a pre-filter. AOM remains the final verifier.
- AOM's delegation issuer/verifier is inside the AOM trust boundary.
- The Gateway must not hold an AOM root signing key, database write access, a
  full principal bearer after the removal milestone, or a credential that AOM
  interprets as unrestricted `codex` authority.
- The AOM system actor remains internal-only and cannot become the subject of
  client-issued authority.

## 8. Recommended delegation model

### 8.1 C-first hybrid: server-side opaque delegation record

The canonical recommendation is a server-side delegation record owned and
enforced by AOM, returned to the Gateway as an opaque handle and, if later
useful, accompanied by an AOM-generated integrity proof. The opaque record is
the authority source. A proof is only an integrity/transport optimization; it
never replaces the AOM record, policy checks, revocation state, or atomic use
consumption.

The first implementation should use the server-side record alone unless a
separately reviewed performance need justifies a proof. If a proof is added,
only AOM may issue it, the Gateway must not possess the issuer key, and AOM
must still perform the same server-side caveat and state checks.

This is intentionally not “a signed token stored and trusted by the Gateway.”
The Gateway is a bearer of a narrow AOM result, not an authority validator.

### 8.2 Why the handle is safer

An opaque, unpredictable delegation ID avoids placing mutable authority
claims in edge-visible text. AOM can look up current status, subject binding,
resource binding, policy generation, use count, and revocation state. The
Gateway cannot edit those values locally and cannot create a valid row by
choosing an ID. A unique ID plus an AOM-owned record also gives a durable
one-time consumption point.

### 8.3 What the model does not mean

- It does not give the Gateway a new principal.
- It does not turn the ChatGPT OAuth client into `codex`.
- It does not make a delegation equal to `job:decide` in the abstract.
- It does not allow the Gateway to select a different tool or resource.
- It does not allow a worker to request a principal delegation.
- It does not authorize implementation or public exposure in this phase.

### 8.4 Issuer authentication is request-only

After the principal-bearer removal milestone, the Gateway must authenticate to
the AOM issuer with a separate AOM-issued **restricted edge transport
identity**. The identity is not the `codex` principal, has no `job:decide`,
`job:create`, `job:start`, `job:resume`, `qa:request`, `work:report`, or other
direct mutation capability, and cannot access a delegation-issue or approval
primitive.

The conceptual capability `delegation:request` is an admission right to enter
AOM's issuance-policy evaluation path. It means only:

> “This caller is the registered edge integration and may ask whether a
> bounded grant is policy-issuable.”

It does not mean:

> “This caller may issue, approve, refresh, widen, or choose any delegation.”

AOM is the only issuer. AOM evaluates the requested operation, tier, resource,
integration state, quota, approval class, policy generation, and current
authorization epoch before creating a record. The request credential may be a
bearer held by the Gateway and therefore remains usable by a compromised
Gateway; the security boundary is the AOM-only policy and its hard ceilings,
not an assumption that the Gateway credential is unstealable.

The existing `observer` role is suitable for the earlier read-only Stage-0
hardening because it is structurally limited to `job:read`. It must not be
silently given `delegation:request`. A future implementation should use a
distinct edge transport role/identity (or a separately justified equivalent)
so read-only observer semantics and issuer admission semantics remain
separate. The current role/capability source is not changed in this planning
phase.

## 9. Delegation lifecycle

### 9.1 Request and issuance

1. The edge Gateway authenticates the ChatGPT-facing session and applies its
   public policy. This is a Gateway-side edge-session fact, not an AOM-verified
   per-session subject claim.
2. The Gateway sends AOM a delegation request over the approved local trust
   path. The request identifies the authenticated edge integration, intended
   operation, exact resource, normalized arguments or a server-computable
   request, audience, purpose, and requested lifetime. A session label may be
   carried for attribution only and is not a security binding under S3.
3. AOM authenticates the issuer path as the restricted edge transport identity
   and checks `delegation:request` admission. A client-supplied string such as
   `actor_id=codex` is never enough.
4. AOM evaluates the operation tier, integration policy, resource ownership,
   lifecycle state, issuance quota, requested bounds, approval requirements,
   policy generation, and authorization epoch.
5. AOM rejects anything outside the allowed issuance policy. It records a
   denial without storing secrets.
6. If approved, AOM creates a unique delegation record in its durable store,
   assigns the final caveats, and returns only the opaque handle and safe
   metadata needed by the Gateway.

Issuance is not execution. A delegation may be issued and then become
expired, revoked, or unusable before presentation.

### 9.2 Presentation and verification

1. The Gateway presents the opaque handle with the exact operation/resource
   request to AOM.
2. AOM resolves the record and checks status, audience, integration subject,
   integration generation, operation/tool, resource, policy generation,
   authorization epoch, not-before/expiry, use count, and lifecycle
   preconditions.
3. AOM parses and validates the actual domain input and computes the canonical
   request hash itself.
4. AOM rejects any mismatch before invoking the domain mutation.
5. For read-only operations, the record may be non-consuming only if the risk
   tier explicitly permits that behavior. For writes, consumption is part of
   the same immediate transaction as the write.

### 9.3 Consumption and completion

For a one-time write, AOM changes the record from available to consumed and
performs the domain update, idempotency write, and audit append in one
transaction. A failure rolls back both consumption and the domain operation,
unless the operation has an explicitly documented durable failure outcome.

For bounded multi-use read or low-risk operations, AOM atomically decrements
`uses_remaining` and records each use. It must never infer a use count from
Gateway memory.

### 9.4 Expiry and revocation

Expiry is a server-side rejection condition. Expired records remain available
for bounded audit/forensics retention if policy requires, but retention never
restores validity. Revocation is also server-side and durable.

The adjudicated subject model is integration-bound. AOM stores an
`integration_generation` (or equivalent current-generation record) and binds
each delegation to the generation observed at issuance. Disabling or revoking
the edge integration increments that generation. Every delegation check reads
the current generation transactionally, so all older delegations fail at the
next AOM authorization check without requiring physical deletion or a mass
update.

Under S3, AOM does not independently receive or validate an OpenAI OAuth
session revocation event. OAuth logout/revocation alone therefore cannot be
claimed to cascade to one individual ChatGPT session. The operator must revoke
the AOM edge integration/transport identity (or disable issuance) to invalidate
all bound delegations. Short tiered TTLs and one-use rules bound the residual
window while the integration-level action is performed. A future S1/S2 proof
could add per-session cascade, but it is not assumed here.

### 9.5 Restart and unavailable-store behavior

The AOM store is the source of truth for delegation status, use count, and
revocation. AOM restart must not reset them. If the store or delegation
verification state is unavailable, the request fails closed. The Gateway must
not fall back to its old principal bearer for the same operation.

## 10. Delegation field and caveat model

The following is a design model, not a final database schema or API. Fields
are included only when they enforce a stated security property.

| Field | Required semantics |
| --- | --- |
| `delegation_id` | Unique, opaque, non-secret identifier; never reused. |
| `issuer` | AOM-owned issuer identity/version; not caller-selected authority. |
| `subject_type` | Explicitly identifies an edge session/client subject, never an implicit principal. |
| `subject_id` | Server-verified edge-session identifier or stable integration binding. |
| `audience` | Exact AOM instance/environment; cross-environment replay is denied. |
| `operation` | One canonical domain operation, not a wildcard capability. |
| `tool` | Exact MCP tool where a tool mapping exists; AOM cross-checks it. |
| `resource_type` | Job, run, worker, or other approved resource class. |
| `resource_id` | Exact resource identifier; absent only for a reviewed non-resource operation. |
| `cycle` | Exact lifecycle cycle when the operation is cycle-sensitive. |
| `expected_version` | Exact optimistic-concurrency version where the operation mutates state. |
| `request_hash` | AOM-computed hash of validated canonical input. |
| `preconditions` | Server-defined lifecycle/state conditions, not free-form client policy. |
| `capability_floor` | Maximum permitted AOM capability, checked against the actor/policy; never a grant to exceed the actor. |
| `issued_at` / `not_before` / `expires_at` | Bounded validity interval with defined clock rules. |
| `max_uses` / `uses_remaining` | Atomic use bound; writes normally use one. |
| `consumed_at` | Immutable terminal use timestamp for one-time records. |
| `revoked_at` / `revocation_reason` | Durable administrative invalidation without secret detail. |
| `policy_version` | The issuance/verification policy generation used for fail-closed invalidation. |
| `parent_id` / `delegation_depth` | Optional constrained lineage; no unbounded delegation chains. |
| `purpose` | Human/audit classification such as `chatgpt_edge_low_risk`. |
| `approval_class` | Required approval level; high-risk values cannot be downgraded by the client. |
| `proof_key_id` | Optional AOM-side key version only; never the key material. |
| `created_at` | Durable creation/audit timestamp. |

### 10.1 Fields intentionally absent

- No plaintext AOM bearer.
- No raw OAuth credential or Owner secret.
- No Gateway-selected `actor_id` that silently confers authority.
- No unconstrained `scopes: ['*']` or wildcard tool list.
- No client-selected `request_hash` accepted as proof.
- No arbitrary URL, filesystem path, SQL fragment, shell command, or adapter
  path.
- No worker lease nonce in the delegation record; lease secrets remain in the
  worker-run path.

## 11. Request binding and canonicalization

### 11.1 AOM-owned canonical request

AOM must hash the parsed and validated domain input after applying documented
defaults. The Gateway may send an advisory digest for diagnostics, but AOM
must recompute and compare internally; a caller-provided digest is never the
source of truth.

The canonicalization algorithm must be versioned and shared by the verifier
and issuer. At minimum it must:

- recursively sort object keys;
- preserve array order unless the schema explicitly defines an array as a
  set, in which case the set rule is versioned;
- distinguish omitted fields from explicit `null` where the schema does;
- apply defaults before hashing;
- reject NaN, Infinity, invalid dates, duplicate object keys, invalid UTF-8,
  and ambiguous number encodings;
- encode the canonical representation as UTF-8;
- include operation name, tool mapping, schema version, policy version, and
  all resource/lifecycle preconditions in the hashed envelope;
- reject unknown fields rather than silently dropping them.

The hash is a binding, not an authorization decision. A matching hash does
not bypass role, actor, capability, lifecycle, revocation, or transaction
checks.

### 11.2 Exact `codex_decide` binding

The authority operation must bind at least:

`job_id`, `cycle`, `expected_version`, exact decision kind, validated
rationale, ordered evidence references, request/idempotency identity, policy
version, and the required approval class.

The verifier must reject a delegation issued for `APPROVE` when the presented
decision is `REJECT`, reject a different job/cycle/version, and reject any
change to evidence references or other hashed input. The delegation must be
single-use. It must not be represented as generic `job:decide` permission.

## 12. Replay and TOCTOU model

### 12.1 Replay

Every delegation ID is unique. A one-time operation is accepted only while
the server-side record is available and unused. A successful use atomically
marks it consumed. A second concurrent or later presentation receives a
deterministic rejection and creates an audit event without repeating the
domain action.

Idempotency and delegation consumption are related but distinct:

- idempotency answers whether the same valid request can safely return the
  original result;
- delegation consumption answers whether this authority grant may be used
  again.

The implementation must define the interaction explicitly. A replay with the
same request hash may return an idempotent result only if the operation's
policy allows that outcome; it must never silently re-authorize a new mutation
with an already-consumed delegation.

### 12.2 TOCTOU

For a mutating operation AOM must use an immediate transaction to:

1. load the delegation row;
2. check status, binding, expiry, policy generation, use count, and
   preconditions;
3. load the current domain row;
4. verify cycle/version/state and the AOM-computed request hash;
5. atomically consume or decrement the delegation;
6. apply the domain mutation with the expected version;
7. write idempotency and append-only audit records;
8. commit as one unit.

If any step fails, no accepted authority mutation is produced. A race must
not permit one caller to validate an old version and another caller to use the
same delegation against a new version.

### 12.3 Concurrency acceptance cases

- Two identical presentations of a one-use delegation: exactly one succeeds.
- Two different payloads with one delegation: at most one can succeed, and a
  payload mismatch is rejected.
- A valid presentation racing revocation: the documented transaction order
  decides deterministically; no request may be reported successful without an
  accepted committed state.
- A valid presentation racing a job state/version transition: stale version
  fails with no authority mutation.
- AOM restart after issue but before use: record remains available/expired as
  stored, never reset.
- AOM restart after consumption: second use remains rejected.

## 13. Revocation and emergency controls

Revocation must be owned by AOM and durable in the authoritative store.

### 13.1 Required scopes of revocation

1. Revoke one delegation ID.
2. Revoke all delegations for one edge session.
3. Revoke all delegations for one Gateway/integration instance.
4. Invalidate a policy generation globally for the integration.
5. Disable new issuance while preserving audit evidence.

Revocation must not delete the historical record required for audit. It changes
the record to an invalid state and stores a bounded reason code. Secret values,
raw bearer tokens, proofs, and raw request bodies are not recorded.

### 13.2 Failure policy

- If AOM cannot read revocation state, deny the operation.
- If the Gateway cannot refresh or present a delegation, it must not use a
  legacy full-principal fallback for a newly delegated write.
- If a policy version is unknown or newer than the verifier understands, deny.
- Expired/revoked records may be retained for audit but never reactivated by
  a Gateway restart or cache restore.
- If the current integration generation does not match the delegation, deny.
- If the authorization epoch cannot be verified after restore or clock guard,
  deny issuance and delegated mutation.

## 14. OAuth-to-AOM relationship

OAuth is an edge-session bootstrap mechanism. It proves that the ChatGPT
integration completed the Gateway's configured client/redirect/PKCE/Owner
authorization flow. It does not prove that a particular AOM job mutation or
authority decision is approved. Under the adjudicated S3 model, AOM does not
validate the OAuth artifact and therefore makes no per-ChatGPT-session
authorization claim.

The correct relationship is:

`OAuth edge session -> Gateway policy -> registered edge identity -> AOM issuance policy -> AOM operation`

The following values must remain separate and must never be copied into audit
or delegation fields as if they were AOM authority:

- OAuth client ID and redirect URI;
- PKCE state/verifier;
- Gateway Owner secret;
- Tailscale identity/token;
- ChatGPT access/session token;
- AOM principal bearer.

The eventual design should remove the full principal bearer from the
internet-facing Gateway. This is split into two milestones: read-path
reduction first, then complete removal before any public write. During a
migration period, retaining it means the confused-deputy risk remains open and
no write exposure may be declared safe.

## 15. Gateway-compromise analysis

### 15.1 Current Stage-0 maximum authority

If the Stage-0 Gateway is fully compromised, the attacker may obtain the
Gateway's local AOM principal bearer and attempt any AOM request that the
Gateway can reach. The current public allowlist limits normal intended
exposure to read projections, but it is not sufficient containment against a
compromised deputy. Stage-0 therefore correctly keeps all writes and
`codex_decide` blocked.

### 15.2 Target maximum authority after Phase 10B

After the full-principal bearer is removed, a fully compromised Gateway may:

- observe or replay any currently held edge session material to the extent the
  edge session itself permits;
- authenticate as the registered restricted edge integration and request
  delegations according to the AOM issuance policy and finite quotas;
- use an unexpired, unrevoked delegation within its exact caveats;
- cause bounded denial-of-service or repeated rejected requests.

It must not be able to:

- mint a delegation;
- widen a delegation's operation, resource, arguments, lifetime, or uses;
- use a read delegation as a write or authority credential;
- create a second principal or system actor;
- call `codex_decide` without its separate exact authority gate;
- use a worker lease as a principal delegation;
- proxy arbitrary AOM URLs or paths;
- recover validity from a restart, cache, or stale OAuth transaction.

### 15.3 Residual risks

A compromised Gateway can still spend already-issued bounded delegations and
can request whatever low-risk policy intentionally permits until its durable
integration/tier quotas are exhausted. Under S3, OAuth revocation by itself
does not provide AOM-visible per-session invalidation; integration revocation
does. Short lifetimes, one-time use, exact resource binding, generation
checks, and AOM-side rate limits reduce but do not eliminate this risk. Phase
10B must state this residual risk honestly rather than claiming that
delegation makes an internet-facing process trusted.

### 15.4 Precise post-hardening security property

Assume the Gateway is fully compromised. The attacker can read Gateway
memory, bypass Gateway allowlists, generate arbitrary local requests, replay
observed delegation handles, invoke the request-only issuer interface, and lie
about public request parameters. After Milestone B, the attacker must still be
unable to:

- authenticate directly as the AOM principal;
- mint arbitrary delegations or exceed AOM issuance ceilings;
- widen an issued delegation or change its operation, resource, audience,
  policy generation, authorization epoch, lifetime, or use count;
- alter the exact payload for a bound operation;
- bypass atomic use counts or replay a consumed grant;
- revive a revoked, expired, restored-invalidated, or policy-invalid grant;
- invoke T4 without its separate exact authority and approval gate.

The attacker may still spend a currently valid, bounded grant, request grants
that the integration policy automatically permits until quotas are exhausted,
and cause denial of service. Because S3 is integration-bound, the attacker
may also cause actions under the integration's permitted routine policy; the
design does not claim that it can distinguish individual ChatGPT OAuth
sessions.

## 16. Special treatment of `codex_decide`

`codex_decide` is the highest-risk operation because it can grant authoritative
job statuses such as approval, delivery, completion, or cancellation. It must
not be the first delegated write and must not be unlocked by a broad
`job:decide` capability claim.

The eventual path must require all of the following:

- AOM-verified issuer and subject context;
- a restricted edge transport identity with request-only admission, not a
  principal-equivalent credential;
- exact target `job_id`, cycle, and expected version;
- exact decision kind and validated payload hash;
- evidence reference validation at AOM;
- a single-use delegation or equivalent atomic approval record;
- explicit approval class that cannot be downgraded by the Gateway;
- a formally reviewed delegated-authority context that preserves the existing
  sole-principal invariant;
- one immediate transaction covering delegation consumption, decision row,
  job update, idempotency, and audit;
- append-only attribution of the edge session and delegation ID without
  exposing secrets;
- independent high-risk review and explicit implementation authorization.

**Adjudicated semantic rule:** a delegated `codex_decide` is a principal act
performed through a constrained delegated-authority path. It is not a new
independent policy-mediated authority mode and does not create a second
principal. The authority on whose behalf the action executes remains the sole
`codex` principal; the transport caller is the restricted edge identity. The
domain choke point in `src/domain/decide.ts` and the MCP gate in
`src/mcp/tools/codexDecide.ts` must therefore be changed in a later, separately
reviewed core-authority stage to accept a verified delegated context rather
than treating `actor_id === 'codex'` as the only possible representation.

That future core change must preserve `decisions.actor_id = codex` for the
authority attribution while recording the verified transport/delegation
provenance separately. No delegated `codex_decide` design or exposure is
authorized in this planning task.

## 17. Principal identity and authorization context

The existing `codex` actor and `codex_decide` API names are not executable
identity dependencies; they are the established V1 authority model. Phase 10B
should not rename them. It should introduce a conceptual authorization
context at the domain boundary so the source can distinguish local principal
authentication from a future, explicitly approved server delegation.

### 17.1 Proposed conceptual context

```text
AuthorizationContext {
  transportActorId: "codex" | "edge" | "worker" | "observer" | "system"
  authorityPrincipalId: "codex" | null
  authMode: "local-principal" | "server-delegated"
  edgeIntegrationId: string | null
  edgeSessionId: string | null // attribution only under S3
  delegationId: string | null
  role: verified role or restricted edge transport role
  capabilities: canonical bounded set
  operation: exact operation
  resource: exact resource binding
  policyVersion: server policy version
  authorizationEpoch: deployment/restore epoch
  issuedAt: timestamp
  expiresAt: timestamp
  requestId: audit/idempotency identity
}
```

This is a design object, not a TypeScript instruction. Raw HTTP headers,
OAuth strings, opaque proofs, and Owner secrets must not flow into domain code.
The context must be produced by a verified AOM boundary and must be
unforgeable by ordinary request input.

### 17.2 Context rules

- `authMode=server-delegated` never means “all principal capabilities.”
- `transportActorId` identifies the caller; `authorityPrincipalId` identifies
  the sole principal on whose behalf an approved delegated authority act may
  execute. They must never be silently collapsed.
- Capabilities are a ceiling checked against the operation policy, not a grant
  selected by the Gateway.
- A delegated context must carry exact resource and request binding where a
  mutation is possible.
- Under S3, `edgeSessionId` is optional attribution and cannot authorize,
  isolate, or supply a per-ChatGPT-session quota.
- Existing local principal calls continue to use the current V1 checks.
- System and worker contexts remain disjoint from the delegated edge context.
- A conceptual `delegation:request` capability admits only policy evaluation;
  it does not issue or approve a delegation.

## 18. Design-only schema and migration impact

No schema is changed in Phase 10B planning. The following impact must be
reviewed before any migration is written.

### 18.1 Likely AOM records

A future implementation will likely need a durable delegation record with:

- opaque ID and unique constraint;
- issuer/subject/audience/policy version;
- exact operation/tool/resource/cycle/version binding;
- canonical request hash and schema version;
- precondition/purpose/approval metadata;
- issue/not-before/expiry/consumption/revocation state;
- bounded use count and lineage depth;
- immutable integration generation and authorization/restore epoch;
- creation and audit timestamps.

Indexes should support exact ID lookup, session lookup, resource lookup, active
expiry/revocation checks, and bounded audit queries. Indexes must not be used as
a substitute for transaction constraints.

### 18.2 Existing-row impact

The audit model currently attributes sessions with `session_token_id` and
records action, request, subject, state, and redacted detail. A future design
must decide whether to add a nullable `delegation_id` provenance column to
audit/decision records or to add a separate immutable provenance table. The
choice must preserve existing audit chain behavior and make delegation
attribution queryable without storing proofs.

Existing `actor_tokens` must not be overloaded to store mutable delegation
caveats. Actor tokens identify authenticated transport identities; delegation
records represent narrower, operation-specific grants. The current role and
capability enums have no `edge` role or `delegation:request` capability. A
future implementation must either add a separately reviewed restricted edge
role or prove an equivalent authentication class; it must not grant
`delegation:request` to all existing observers by accident.

### 18.3 Database invariants to require

- delegation IDs are unique and never reused;
- consumed one-use records cannot return to available;
- revoked records cannot be reactivated by ordinary application writes;
- expiry is checked against server time;
- uses cannot underflow or be incremented by a caller;
- resource/operation/request binding is immutable after issuance;
- integration generation and authorization epoch are checked on every use;
- audit provenance cannot be changed to another delegation/session;
- raw SQL attempts to widen or rewrite delegation authority fail or are
  rejected by the same integrity strategy used for durable AOM rows;
- migrations preserve the existing single-principal and system-actor gates.

### 18.4 Backup, restore, and clock policy

Delegation expiry is evaluated by AOM using its server UTC wall clock. There is
no positive expiry grace period: clock skew must never extend a delegation
beyond its recorded `expires_at`. The permitted skew is zero for expiry and
mutation authorization. A bounded 30-second tolerance may be used only when
validating a `not_before` value for local service scheduling, and it must never
rescue an expired record.

AOM persists a high-water observation of accepted server time. If the current
clock moves backwards by more than 30 seconds, AOM enters a fail-closed clock
guard: it stops new issuance and delegated mutations until the operator
corrects and acknowledges the clock. The verifier must not use a rollback to
extend validity. Small backward movement may be handled using the persisted
high-water time for expiry checks; it must not produce a later expiry.

A backup or point-in-time restore is treated as an authorization boundary
event, not as a way to preserve active grants. A trusted deployment/restore
epoch, kept outside the restorable database snapshot or explicitly rotated by
the operator after restore, is required. Every delegation is bound to the
current epoch; after restore, pre-restore delegations fail closed. If the
current epoch cannot be verified, AOM denies issuance and delegated mutation.
This prevents a restore of a pre-consumption or pre-revocation database from
resurrecting a grant. Preserving active grants across restore would require a
separate authenticated journal and is outside Phase 10B.

## 19. Audit and evidence design

The existing append-only audit writer already redacts sensitive detail and
records verified actor/session attribution. Phase 10B should extend the design
with bounded, non-secret events such as:

- `delegation.requested`;
- `delegation.issued`;
- `delegation.denied`;
- `delegation.used`;
- `delegation.consumed`;
- `delegation.expired`;
- `delegation.revoked`;
- `delegation.replay_rejected`;
- `delegation.scope_mismatch`;
- `delegation.resource_mismatch`;
- `delegation.payload_mismatch`;
- `delegation.session_mismatch`;
- `delegation.policy_mismatch`.

The action names and reason codes must be fixed, versioned enums. Free-form
purpose/reason text is not an authorization input and must not be used as an
unbounded audit field. Each event should include the verified edge
integration/delegation IDs where safe, operation and resource classification,
request ID, policy version, result, and a bounded enum reason code. An optional
session label is attribution only under S3.
It must not include:

- bearer tokens or OAuth credentials;
- Owner secrets or Tailscale values;
- opaque proof material or signing inputs;
- lease nonces;
- raw worker output;
- unrestricted request bodies or stack traces.

For a successful mutating operation, delegation consumption, domain result,
and audit provenance must commit together. A rejected presentation may be
audited without changing the domain state.

## 20. Risk tiers and future exposure order

The first delegated operation must not be selected by convenience alone. Each
tier has its own review and authorization gate.

| Tier | Example | Default delegation shape | Phase 10B stance |
| --- | --- | --- | --- |
| T0 | Existing read projections | Existing observer token; no delegated mutation | Already contained by Stage-0; read hardening comes first |
| T1 | Bounded `job_create` | Automatic only after operator policy bootstrap; TTL <= 5 minutes; one use; max 4 active; 10 issuance attempts per 10-minute rolling integration window | Candidate for first future live write |
| T2 | `job_start` / `job_resume` | Initial owner approval; TTL <= 2 minutes; one use; max 2 active; 4 attempts per 10-minute rolling integration window | Later, separate review |
| T3 | `qa_dispatch` | Explicit owner approval; TTL <= 60 seconds; one use; max 1 active; 1 attempt per 30-minute rolling integration window | Later; worker side effects require stronger gate |
| T4 | `codex_decide` | Never automatically remotely issuable in this baseline; if later approved, owner/authority approval, TTL <= 30 seconds, one use, max 1 active | Last; remains blocked in this phase |

No tier is exposed or implemented by this planning commit.

### 20.1 Quota semantics and rationale

The numeric values above are conservative starting ceilings for a single local
integration, not user-tunable authority. They are intentionally short and
finite: T1 permits routine work without an Owner-secret prompt on every task,
while still limiting a compromised Gateway to a small bounded burst; T2 and T3
are progressively tighter because they advance lifecycle or start external
work; T4 is disabled rather than made autonomous. Independent review may lower
these values, but implementation must not raise the hard maximum without a new
security decision.

The issuer enforces quotas in AOM using durable, atomically updated buckets or
an equivalent bounded counter. The quota key includes the registered edge
integration identity and tier. All attempts, including denied or malformed
issuance requests after cheap authentication, consume the request-rate budget;
only successfully issued records consume the active-grant budget. Each
operation class has a separate ceiling, and one resource/payload tuple cannot
have more than one active T1 grant. Quota state survives Gateway restart.

The S3 model cannot provide a security-grade per-ChatGPT-session quota because
AOM cannot verify that session identity. The integration quota is therefore the
hard ceiling. A per-session counter may be added only after an S1/S2 artifact
is available and may never weaken the integration ceiling.

Routine T1 issuance is policy-automatic only after an operator explicitly
bootstraps and enables the T1 policy. It does not require browser Owner-secret
approval for every routine request. T2/T3 require explicit approval in the
initial design. T4 is never remotely issuable until its core-authority and
approval semantics have passed a separate high-risk review. An emergency
disable overrides every tier, including owner-approved requests.

## 21. First low-risk future write candidate

The recommended first candidate is a narrowly bounded `job_create`, preferably
behind a dry-run/preview mode before a durable write. It should be admitted
only when all of these are true:

- AOM has issued a one-time delegation for `job_create`, not generic
  `job:create`.
- The request is bound to the AOM-verified edge integration identity and exact
  normalized title/spec/workspace/max-cycles/deadline/idempotency payload. Any
  session label is attribution only under S3.
- Workspace is selected from an AOM-owned allowlist; arbitrary paths are
  rejected.
- Max cycles, deadline, title/spec sizes, and all other bounds are server-side.
- The operation creates only a non-running `CREATED` job and cannot dispatch a
  worker, add evidence/artifacts, or make an authority decision.
- AOM consumes the delegation and creates the job/idempotency/audit records in
  one immediate transaction.
- The Gateway has no full principal bearer capable of bypassing this path.
- The request is subject to the T1 integration rolling quota, active-grant
  ceiling, one-resource/payload ceiling, and short TTL.

This candidate is safer than `job_start`, QA dispatch, or `codex_decide` because
it creates a bounded durable object without starting execution or changing
authoritative status. It is still not authorized by this document.

## 22. Final authority-operation path

The desired long-term path for an authority decision is:

```text
ChatGPT request
  -> Gateway edge-session validation
  -> restricted edge transport identity
  -> AOM delegation request for one exact approved operation
  -> AOM policy/issuer decision
  -> one-time delegation record
  -> Gateway presents exact job/cycle/version/payload
  -> AOM verifies all caveats and current lifecycle
  -> BEGIN IMMEDIATE
       consume delegation
       require reviewed authority context
       validate evidence and transition
       write decision/job/idempotency/audit
     COMMIT
  -> Gateway returns bounded result
```

The final step must remain a single AOM authority choke point. A Gateway
response of “allowed” is not evidence that AOM committed the decision. AOM
must return the committed result or a bounded failure. The authority principal
for this future path is still `codex`; the edge identity is only the transport
caller and the delegation is the exact principal authorization context.

ChatGPT may eventually operate the sole `codex` authority through this
controlled interface only after the core authority change, explicit approval,
and independent high-risk review. Until then, `codex_decide` stays local to the
existing principal path.

## 23. Proposed implementation and review stages

These are staged gates, not authorization.

### 10B.0 — Architecture adjudication and focused re-review

Record the Opus findings, adopt or reject each one explicitly, and obtain one
focused independent re-review of the corrected architecture. No source or
schema work is allowed in this stage.

### 10B.0A — Read transport identity hardening

Move the current Stage-0 read path from the `codex` principal bearer to a
separate existing observer token with `job:read` only. Keep the public surface
exactly `ping`, `job_list`, `job_get`, and `run_status`. Do not add
`delegation:request`, writes, authority, or a second principal. This is a
bounded pre-write hardening stage and requires its own implementation check.

### 10B.1 — Internal authorization context and policy model

Specify the restricted edge transport identity, conceptual
`delegation:request` admission capability, integration-bound subject model,
quota policy, generation/epoch checks, and delegated-authority context without
adding a public write route. Prove that principal, edge, worker, system, and
observer contexts cannot be confused.

### 10B.2 — Durable delegation records and issuer boundary

Only after migration approval: add the minimum AOM persistence and integrity
constraints for issue, revoke, consume, expiry, quota, integration generation,
restore epoch, and provenance. Implement the request-only issuer boundary; the
Gateway must not receive issue/approve authority. Do not expose a write tool.

### 10B.3 — Adversarial, quota, and concurrency tests

Test canonicalization ambiguity classes, cross-resource substitution, replay,
concurrent use, issuance flooding, quota reset attempts, revocation races,
OAuth/integration-generation behavior, backup/restore, clock rollback,
unavailable-store fail-closed behavior, policy versioning, raw-SQL integrity,
and HTTP/stdio parity. No public write exposure.

### 10B.4 — Preview-only first-write path

After a separate authorization, implement a dry-run/preview for the T1
`job_create` policy without durable mutation. Verify exact payload binding,
allowlisted workspace, bounds, quota decisions, and default-deny behavior.

### 10B.5 — Full principal-bearer removal before writes

Remove the full AOM principal bearer from the Gateway entirely, rotate/revoke
it, and prove the edge process cannot authenticate as `codex`. This is Milestone
B and an absolute prerequisite for any public write. No exception may use a
legacy principal fallback.

### 10B.6 — Bounded T1 `job_create` live gate

Only after Milestone B and a separate authorization, expose the one-time,
short-TTL, quota-bounded `job_create` mutation. It may create `CREATED` only;
it cannot start, dispatch, add evidence/artifacts, or decide.

### 10B.7 — T2 lifecycle delegation

Review and separately authorize `job_start`/`job_resume`, with exact job,
cycle, version, payload, one-time binding, and tighter quota/TTL.

### 10B.8 — T3 worker dispatch

Review and separately authorize `qa_dispatch` only after confirming that
delegation cannot grant worker authority or bypass lease controls.

### 10B.9 — T4 core-authority change

Conduct an independent high-risk review of the `decide.ts` and
`codexDecide.ts` authority-gate change, principal-act semantics, approval,
provenance, and failure behavior. Keep `codex_decide` blocked until this gate
passes.

Every stage requires its own evidence, review, and authorization. Approval of
the plan does not authorize the next stage's source changes.

## 24. Acceptance and negative-test outline

The eventual implementation review should include at least these categories:

### Issuance and binding

- issuer path cannot be invoked by an ordinary edge client;
- Gateway cannot select `codex` as a subject by request input;
- exact operation/tool/resource binding is immutable;
- unknown operation, tool, resource, field, or policy version is denied;
- oversized and ambiguous canonical inputs are denied;
- request hash is recomputed by AOM;
- cross-audience and cross-integration use is denied; no per-session claim is
  made under S3.

### Lifecycle and transaction

- expired/not-before/revoked/consumed records are denied;
- one-use concurrent presentations have one winner;
- stale job version causes no delegation-authorized mutation;
- failed domain validation does not consume unless the documented policy says
  the rejection is a terminal use;
- domain mutation, delegation use, idempotency, and audit are atomic;
- restart preserves all delegation state;
- unavailable store fails closed;
- restore epoch and clock-rollback guard prevent grant resurrection.

### Gateway compromise and transport

- a compromised Gateway cannot mint or widen a record;
- compromised-Gateway issuance attempts hit durable per-integration/per-tier
  quotas and active-grant ceilings;
- deleting/changing Gateway cache does not restore a delegation;
- HTTP and stdio cannot select different scopes;
- no arbitrary downstream URL/path proxy exists;
- old full-principal bearer is rejected/absent after the removal stage;
- read-only Stage-0 behavior remains unchanged until a separately approved
  write is exposed.

### Authority and worker isolation

- delegated edge context cannot call `codex_decide` by generic capability;
- worker context cannot issue or use an edge delegation;
- system actor cannot issue client authority or make a decision;
- `qa_dispatch` still requires its existing principal/lease gates;
- authority provenance records the verified delegation without exposing it.

## 25. Final review disposition and implementation-bound decisions

The focused independent re-review returned `PASS` with zero new blocking
findings. The architecture is accepted for implementation planning, but the
following decisions remain implementation-bound and are not source
authorization.

1. Issuer authentication is a future AOM-issued restricted edge transport
   identity with conceptual `delegation:request` admission only; AOM policy,
   not that credential, decides issuance.
2. Subject binding is S3 integration-bound because AOM does not independently
   validate an OpenAI OAuth artifact. Per-ChatGPT-session isolation is not
   claimed.
3. Integration-generation revocation cascades at the next AOM check. OAuth
   logout alone is not an AOM-visible revocation event under S3.
4. Delegated `codex_decide` is a principal act through a constrained path, and
   requires a core authority change plus a separate T4 review.
5. Read-path bearer reduction is scheduled first through an observer token;
   full principal-bearer removal is mandatory before public writes.
6. Quotas, TTLs, uses, approval classes, and emergency disable are specified
   in §20; numeric ceilings are hard starting limits subject to independent
   review, not caller-configurable values.

Remaining implementation-design questions are deliberately narrower: the
exact local transport for the restricted edge credential, the concrete schema
for durable quota buckets and restore epoch, audit provenance column/table
choice, and the operational approval procedure for T4. They are not permission
to begin implementation; the focused re-review must confirm that these
choices preserve the resolved security properties.

The final authorization-epoch direction is a small AOM-owned non-secret state
record outside the restorable SQLite backup set, protected by the local
installation's ACLs, plus mandatory operator rotation after any restore. AOM
fails closed when the epoch is missing or unverifiable. The final edge-identity
direction is hybrid: existing observer token for read hardening and a distinct
future non-principal edge identity for request-only issuer admission. The
edge cannot self-provision another integration/quota domain; quota, generation,
epoch, and one-use atomicity assume a single-writer AOM, and any future
multi-node deployment requires re-review. Unknown edge identities are denied
by every existing authority gate.

## 26. Decision summary

- Recommended model: AOM-owned server-side opaque delegation records,
  C-first, with an optional AOM-issued proof only after separate review.
- AOM remains the final authority verifier and transaction owner.
- Gateway is an edge-session broker using a restricted transport identity and
  request-only issuer admission, not an authority issuer.
- Observer-token read reduction is an early hardening milestone; complete full
  principal-bearer removal is required before any public write.
- `codex_decide` is a principal act through a reviewed delegated path, but its
  core authority change is the last/highest-risk gate.
- OAuth revocation is not claimed to be per-session AOM revocation under S3;
  integration-generation revocation is the server-enforced cascade.
- Focused independent re-review: **PASS**; architecture blockers: **0**.
- The final ChatGPT runtime-controller goal is preserved.
- No source, schema, migration, tool, runtime, Funnel, or Plugin change is
  authorized by this document.

## 27. Document set

This planning snapshot consists of:

- `docs/PHASE10B_SCOPED_DELEGATION_PLAN.md` — normative planning proposal;
- `docs/PHASE10B_THREAT_MODEL.md` — threats, assets, attack paths, and
  security acceptance properties;
- `docs/PHASE10B_ALTERNATIVES.md` — architectural comparison and selection;
- `docs/PHASE10B_REVIEW_ADJUDICATION.md` — finding-by-finding Codex decisions;
- `docs/PHASE10B_EXTERNAL_REVIEW_PACKET.md` — bounded handoff for an
  independent reviewer.

The documents are planning artifacts only. They do not supersede the
approved/current architecture document until independent review and Codex
adjudication explicitly accept a resulting architecture revision.
