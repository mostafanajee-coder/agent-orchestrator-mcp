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
7. **Edge-session binding:** the proof is tied to a verified edge session or
   an equivalent server-issued subject; a copied proof cannot be moved to a
   different session without an explicitly designed policy.
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
    - validates edge session
    - applies public allowlist
    - requests/transports delegation
    - MUST NOT mint or widen delegation
          |
          | loopback request carrying edge identity + AOM-issued delegation
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
- The Gateway must not hold an AOM root signing key, database write access, or
  a credential that AOM interprets as unrestricted `codex` authority.
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

## 9. Delegation lifecycle

### 9.1 Request and issuance

1. The edge Gateway authenticates the ChatGPT-facing session and applies its
   public policy.
2. The Gateway sends AOM a delegation request over the approved local trust
   path. The request identifies the edge session, intended operation, exact
   resource, normalized arguments or a server-computable request, audience,
   purpose, and requested lifetime.
3. AOM authenticates the issuer path independently of the edge session. A
   client-supplied string such as `actor_id=codex` is never enough.
4. AOM evaluates the operation tier, edge-session policy, resource ownership,
   lifecycle state, requested bounds, approval requirements, and current
   policy generation.
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
2. AOM resolves the record and checks status, audience, subject/session,
   operation/tool, resource, policy generation, not-before/expiry, use count,
   and lifecycle preconditions.
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
restores validity. Revocation is also server-side and durable. Revoking a
session's edge token prevents new delegation issuance; existing delegations
are independently checked against their status and policy generation.

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

## 14. OAuth-to-AOM relationship

OAuth is an edge-session bootstrap mechanism. It proves that the ChatGPT
integration completed the Gateway's configured client/redirect/PKCE/Owner
authorization flow. It does not prove that a particular AOM job mutation or
authority decision is approved.

The correct relationship is:

`OAuth edge session -> Gateway policy -> AOM delegation request -> AOM policy -> AOM operation`

The following values must remain separate and must never be copied into audit
or delegation fields as if they were AOM authority:

- OAuth client ID and redirect URI;
- PKCE state/verifier;
- Gateway Owner secret;
- Tailscale identity/token;
- ChatGPT access/session token;
- AOM principal bearer.

The eventual design should remove the full principal bearer from the
internet-facing Gateway. During a migration period, retaining it means the
confused-deputy risk remains open and no write exposure may be declared safe.

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
- request delegations according to the AOM issuance policy;
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
can request whatever low-risk policy intentionally permits. Short lifetimes,
one-time use, exact resource binding, session revocation, and AOM-side rate
limits reduce but do not eliminate this risk. Phase 10B must state this
residual risk honestly rather than claiming that delegation makes an
internet-facing process trusted.

## 16. Special treatment of `codex_decide`

`codex_decide` is the highest-risk operation because it can grant authoritative
job statuses such as approval, delivery, completion, or cancellation. It must
not be the first delegated write and must not be unlocked by a broad
`job:decide` capability claim.

The eventual path must require all of the following:

- AOM-verified issuer and subject context;
- exact target `job_id`, cycle, and expected version;
- exact decision kind and validated payload hash;
- evidence reference validation at AOM;
- a single-use delegation or equivalent atomic approval record;
- explicit approval class that cannot be downgraded by the Gateway;
- the existing principal/authority invariants or a formally reviewed
  delegated authority context that preserves them;
- one immediate transaction covering delegation consumption, decision row,
  job update, idempotency, and audit;
- append-only attribution of the edge session and delegation ID without
  exposing secrets;
- independent final review and explicit implementation authorization.

The design must answer before implementation whether a delegated
`codex_decide` is a genuine act of the sole `codex` authority under an
approved controlled interface, or a new policy-mediated authority mode. It
must not silently reinterpret a ChatGPT session as the `codex` actor. If that
semantic question is unresolved, `codex_decide` remains local-only.

## 17. Principal identity and authorization context

The existing `codex` actor and `codex_decide` API names are not executable
identity dependencies; they are the established V1 authority model. Phase 10B
should not rename them. It should introduce a conceptual authorization
context at the domain boundary so the source can distinguish local principal
authentication from a future, explicitly approved server delegation.

### 17.1 Proposed conceptual context

```text
AuthorizationContext {
  principalActorId: "codex" | null
  authMode: "local-principal" | "server-delegated"
  edgeSessionId: string | null
  delegationId: string | null
  role: verified role
  capabilities: canonical bounded set
  operation: exact operation
  resource: exact resource binding
  policyVersion: server policy version
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
- Capabilities are a ceiling checked against the operation policy, not a grant
  selected by the Gateway.
- A delegated context must carry exact resource and request binding where a
  mutation is possible.
- Existing local principal calls continue to use the current V1 checks.
- System and worker contexts remain disjoint from the delegated edge context.

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
caveats. Actor tokens identify authenticated sessions; delegation records
represent narrower, operation-specific grants.

### 18.3 Database invariants to require

- delegation IDs are unique and never reused;
- consumed one-use records cannot return to available;
- revoked records cannot be reactivated by ordinary application writes;
- expiry is checked against server time;
- uses cannot underflow or be incremented by a caller;
- resource/operation/request binding is immutable after issuance;
- audit provenance cannot be changed to another delegation/session;
- raw SQL attempts to widen or rewrite delegation authority fail or are
  rejected by the same integrity strategy used for durable AOM rows;
- migrations preserve the existing single-principal and system-actor gates.

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

The exact action enum is a future implementation decision. Each event should
include verified session/delegation IDs where safe, operation and resource
classification, request ID, policy version, result, and bounded reason codes.
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
| T0 | Existing read projections | Non-mutating, short-lived or session-bound | Already contained by Stage-0; no expansion here |
| T1 | Bounded `job_create` | One-time, exact request, fixed workspace policy | Candidate for first future live write |
| T2 | `job_start` / `job_resume` | One-time, exact job/cycle/version, short TTL | Later, separate review |
| T3 | `qa_dispatch` | One-time or tightly bounded, exact worker registry and job state | Later; worker side effects require stronger gate |
| T4 | `codex_decide` | One-time exact payload plus explicit approval and authority review | Last; remains blocked in this phase |

No tier is exposed or implemented by this planning commit.

## 21. First low-risk future write candidate

The recommended first candidate is a narrowly bounded `job_create`, preferably
behind a dry-run/preview mode before a durable write. It should be admitted
only when all of these are true:

- AOM has issued a one-time delegation for `job_create`, not generic
  `job:create`.
- The request is bound to the verified edge session and exact normalized
  title/spec/workspace/max-cycles/deadline/idempotency payload.
- Workspace is selected from an AOM-owned allowlist; arbitrary paths are
  rejected.
- Max cycles, deadline, title/spec sizes, and all other bounds are server-side.
- The operation creates only a non-running `CREATED` job and cannot dispatch a
  worker, add evidence/artifacts, or make an authority decision.
- AOM consumes the delegation and creates the job/idempotency/audit records in
  one immediate transaction.
- The Gateway has no full principal bearer capable of bypassing this path.

This candidate is safer than `job_start`, QA dispatch, or `codex_decide` because
it creates a bounded durable object without starting execution or changing
authoritative status. It is still not authorized by this document.

## 22. Final authority-operation path

The desired long-term path for an authority decision is:

```text
ChatGPT request
  -> Gateway edge-session validation
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
must return the committed result or a bounded failure.

If the governance decision is that ChatGPT may operate the sole `codex`
authority through this controlled interface, that decision must be explicit,
auditable, and separately approved. Until then, `codex_decide` stays local to
the existing principal path.

## 23. Proposed implementation and review stages

These are staged gates, not authorization.

### 10B.0 — Planning and threat model

Deliver this documentation-only snapshot, independent review, Codex
adjudication, and explicit decision on unresolved authority semantics.

### 10B.1 — Internal context and policy evaluator

Design and test an internal authorization context and policy evaluator with
no public write route. Prove that local principal, worker, system, observer,
and delegated edge contexts cannot be confused.

### 10B.2 — Durable delegation records

Only after migration approval: add the minimum AOM persistence and integrity
constraints for issue, revoke, consume, expiry, and provenance. Do not expose
a write tool yet.

### 10B.3 — Adversarial and concurrency tests

Test canonicalization, cross-resource substitution, replay, concurrent use,
revocation races, restart durability, unavailable-store fail-closed behavior,
policy versioning, and raw-SQL integrity. No public write exposure.

### 10B.4 — First bounded write

After a separate authorization, expose only the selected T1 `job_create`
candidate, preferably preview first. Verify HTTP/stdio parity and Gateway
default-deny behavior.

### 10B.5 — Lifecycle writes

Review and separately authorize `job_start`/`job_resume`, with exact job,
cycle, version, and one-time binding.

### 10B.6 — QA/worker dispatch

Review and separately authorize `qa_dispatch` only after confirming that
delegation cannot grant worker authority or bypass lease controls.

### 10B.7 — Authority operation

Conduct an independent high-risk review of the exact `codex_decide` path,
approval semantics, provenance, and failure behavior. Keep it blocked unless
the sole-authority question is explicitly resolved.

### 10B.8 — Full-principal removal and final hardening

Remove the full AOM principal bearer from the internet-facing Gateway, rotate
and verify old credentials are unusable for the edge path, re-run negative
tests, and close the Stage-0 confused-deputy limitation. This is a required
security milestone before any claim of complete delegation hardening.

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
- cross-audience and cross-session use is denied.

### Lifecycle and transaction

- expired/not-before/revoked/consumed records are denied;
- one-use concurrent presentations have one winner;
- stale job version causes no delegation-authorized mutation;
- failed domain validation does not consume unless the documented policy says
  the rejection is a terminal use;
- domain mutation, delegation use, idempotency, and audit are atomic;
- restart preserves all delegation state;
- unavailable store fails closed.

### Gateway compromise and transport

- a compromised Gateway cannot mint or widen a record;
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

## 25. Open questions and blockers for independent review

These questions must be answered before implementation authorization:

1. What exact local AOM-to-Gateway issuer authentication mechanism replaces the
   full principal bearer without giving the Gateway a minting key?
2. Is a server-side opaque record sufficient for expected latency, or is an
   AOM-issued proof needed as an optimization? If a proof is used, where is
   verification performed and how is its key protected?
3. What is the formal meaning of a delegated action relative to the sole
   `codex` authority? Does it execute a pre-approved action by the principal,
   or introduce a distinct policy-mediated authority mode?
4. Which edge-session identifier is stable, verified, and safe to retain for
   revocation and audit without storing ChatGPT credentials?
5. Which operations may be multi-use, and what is the exact idempotency result
   for a replay after consumption?
6. What is the clock-skew and retention policy for issued/expired/revoked
   records?
7. What audit schema preserves existing hash-chain and query behavior while
   attributing delegation use?
8. What operational procedure removes and verifies invalidation of the legacy
   full principal bearer?
9. Which first-write policy is acceptable to the independent security review?
10. What additional human/owner approval is required for T4 `codex_decide`?

An independent reviewer may add blockers. This plan must not convert an
unanswered question into an implementation assumption.

## 26. Decision summary

- Recommended model: AOM-owned server-side opaque delegation records,
  C-first, with an optional AOM-issued proof only after separate review.
- AOM remains the final authority verifier and transaction owner.
- Gateway is an edge session broker and transport deputy, not an authority
  issuer.
- Full principal bearer removal from the Gateway is recommended and required
  before any meaningful write exposure is considered safe.
- `codex_decide` remains a separate high-risk gate and is not the first write.
- The final ChatGPT runtime-controller goal is preserved.
- No source, schema, migration, tool, runtime, Funnel, or Plugin change is
  authorized by this document.

## 27. Document set

This planning snapshot consists of:

- `docs/PHASE10B_SCOPED_DELEGATION_PLAN.md` — normative planning proposal;
- `docs/PHASE10B_THREAT_MODEL.md` — threats, assets, attack paths, and
  security acceptance properties;
- `docs/PHASE10B_ALTERNATIVES.md` — architectural comparison and selection;
- `docs/PHASE10B_EXTERNAL_REVIEW_PACKET.md` — bounded handoff for an
  independent reviewer.

The documents are planning artifacts only. They do not supersede the
approved/current architecture document until independent review and Codex
adjudication explicitly accept a resulting architecture revision.
