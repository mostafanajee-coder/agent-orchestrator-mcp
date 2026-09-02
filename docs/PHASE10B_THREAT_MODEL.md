# AOM Phase 10B — Scoped Delegation Threat Model

Status: design-only threat model. No implementation or public authorization is
contained here.

## 1. Purpose

This threat model evaluates the proposed transition from the Phase 10A
Stage-0 read-only edge containment to a future AOM-owned scoped delegation
boundary. Its central question is not whether the Gateway can forward an MCP
request. The question is what a compromised public-facing deputy can cause AOM
to accept.

The companion planning document is
`docs/PHASE10B_SCOPED_DELEGATION_PLAN.md`. The recommended design is a
server-side opaque delegation record whose status, caveats, use count, and
revocation are owned by AOM.

## 2. System under analysis

```text
External ChatGPT session
        |
        | OAuth edge session
        v
Tailscale Funnel (transport)
        |
        v
Edge Gateway
        |
        | local authenticated delegation request/presentation
        v
AOM MCP/auth boundary
        |
        +-- actor/capability and delegation policy
        +-- domain handlers and lifecycle guards
        +-- SQLite immediate transactions
        +-- append-only audit
        v
AOM durable state
```

The existing local Codex principal path, system actor path, and worker lease
path remain separate trust paths. This model does not redesign them.

## 3. Assets and security objectives

| Asset | Security objective |
| --- | --- |
| AOM principal authority | Must not be transferable to a compromised edge process as an unrestricted bearer. |
| `codex_decide` | Must remain the sole, exact, auditable authority choke point. |
| Durable job state | Must not be changed outside validated lifecycle/decision transactions. |
| Delegation records | Must be immutable in scope, revocable, time-bounded, and atomically consumable. |
| Edge session identity | Must support attribution/revocation without becoming AOM authority. |
| Worker leases/nonces | Must remain run/actor/cycle-bound and separate from edge delegation. |
| Audit chain | Must preserve attribution and integrity without secrets or raw sensitive payloads. |
| OAuth/Owner state | Must not be interpreted as a domain authorization token. |
| AOM loopback boundary | Must not be converted into arbitrary public proxy access. |
| ChatGPT runtime goal | Must remain possible without introducing a second authority principal. |

## 4. Trust assumptions

### 4.1 Trusted for this design

- AOM source, its authority/policy code, and its durable store are within the
  AOM trust boundary until a separate host/AOM compromise is considered.
- The current local principal bootstrap and actor/capability gates are the
  source of truth for V1 authority.
- SQLite transaction and append-only integrity mechanisms function as designed
  and are tested independently.
- The operator can control the local Gateway process and can revoke/rotate
  credentials through a documented procedure.

### 4.2 Not trusted for AOM authority

- Internet clients and ChatGPT request content;
- the Tailscale transport itself as an issuer;
- Gateway configuration, cache, or process memory after compromise;
- client-supplied actor IDs, capabilities, hashes, session hints, or policy
  versions;
- a Gateway-asserted ChatGPT OAuth-session identity as an AOM security subject;
- workers and worker-selected result text;
- Host/Origin headers as identity proof;
- OAuth state as a job authorization decision.

### 4.3 Out of scope

- total compromise of the AOM host or its administrator;
- malicious SQLite library/OS/kernel compromise;
- cryptographic primitive breakage;
- browser automation behavior and remote worker trust;
- general ChatGPT platform behavior outside the Gateway contract;
- availability attacks that do not bypass authorization, except where fail
  closed behavior is part of the security property.

## 5. Adversary capabilities

The primary adversary is a fully compromised internet-facing Gateway. It may:

- read Gateway process memory and local non-secret state;
- issue arbitrary requests through every Gateway route it can reach;
- replay, reorder, delay, duplicate, or mutate edge-session/delegation
  presentations;
- attempt to select different operations, resources, arguments, audiences,
  policy versions, or actors;
- exploit concurrent requests, restarts, stale caches, malformed encodings,
  and failure paths;
- observe bounded response metadata and rejected-request timing.

It may not directly alter a trusted AOM database or AOM process in the base
threat model. If it can, the result is an AOM compromise and must be reported
as such rather than claimed to be contained by delegation.

## 6. Current confused-deputy finding

Stage-0's public allowlist is not the final authorization boundary. The
Gateway holds a full AOM principal bearer and presents that bearer downstream.
AOM therefore authenticates the stronger principal and cannot cryptographically
bind each accepted operation to the weaker public edge session or to a narrow
server-issued request grant. The adjudicated target replaces the bearer first
for reads with an observer token, then entirely before writes with a restricted
edge transport identity whose only special admission is request-only entry to
AOM's issuance policy.

The current allowlist is still valuable: it blocks normal public attempts to
reach writes, worker dispatch, and `codex_decide`. But if the Gateway process or
its bearer is compromised, an attacker can attempt any downstream operation
available through the bearer and reachable local path. Phase 10B is complete
only when a later hardening stage removes that bearer from the edge process and
AOM verifies the narrower grant itself.

## 7. Attack-path analysis

### TM-01 — Full principal bearer theft

**Path:** compromise Gateway -> read its AOM principal bearer -> send a direct
or altered request to AOM.

**Current impact:** potentially all authority available to that principal and
reachable by the process; public allowlist is not a server-side guarantee.

**Target mitigation:** remove the full bearer; authenticate only as a
restricted non-principal edge identity; require an AOM-owned delegation record
with exact caveats and finite issuance quotas; reject legacy fallback for
delegated writes.

**Residual risk:** a currently valid bounded delegation can still be spent
within its caveats until expiry/revocation/consumption.

### TM-02 — Gateway mints a wider delegation

**Path:** compromised Gateway creates an ID/proof or edits operation,
resource, expiry, or use count.

**Target mitigation:** only AOM creates records; opaque IDs are insufficient
without an AOM row; any optional proof is issued by AOM and verified by AOM;
record caveats are immutable; a request-only edge identity cannot skip the
issuer policy or its per-integration/per-tier ceilings.

**Acceptance:** locally generated IDs, edited proof text, and unknown key
versions all fail closed.

### TM-03 — OAuth-to-AOM confusion

**Path:** attacker uses a valid OAuth edge session, client ID, redirect state,
Owner authorization, or PKCE artifact as if it were `codex` authority.

**Target mitigation:** OAuth is only a Gateway edge-session input. AOM uses a
separate authenticated issuer path and its own policy/actor checks.

**Acceptance:** OAuth metadata cannot populate a principal actor or capability
set; no bearer/secret is copied into delegation or audit fields.

### TM-04 — Cross-integration replay and false session binding

**Path:** steal a delegation from one registered integration and present it
under another identity, or have a compromised Gateway claim that a request came
from a particular ChatGPT OAuth session.

**Target mitigation:** bind the grant to an AOM-verified registered integration
identity and current integration generation. Under the adjudicated S3 model,
AOM does not validate the OpenAI OAuth artifact and therefore does not claim
per-ChatGPT-session isolation. A session label remains attribution only.

**Acceptance:** cross-integration use is denied and audited; tests do not label
Gateway-reported session IDs as independently verified.

### TM-05 — Cross-resource substitution

**Path:** use a delegation for job A against job B, run X against run Y, or a
different worker/cycle.

**Target mitigation:** immutable exact resource/cycle/worker binding plus AOM
request validation and hash computation.

**Acceptance:** every changed resource identifier is rejected before mutation.

### TM-06 — Argument substitution and hash confusion

**Path:** change decision, evidence, workspace, deadline, or other arguments;
send a caller-selected hash; exploit omitted-vs-null/default differences.

**Target mitigation:** strict schemas, versioned AOM canonicalization, defaults
before hashing, unknown-field rejection, AOM-computed request hash.

**Acceptance:** semantically or bytewise ambiguous variants are either
canonicalized consistently or rejected; a caller cannot choose the digest.

### TM-07 — Replay after successful use

**Path:** repeat a one-time delegated mutation or race two identical calls.

**Target mitigation:** unique record, atomic consume/decrement in the same
`BEGIN IMMEDIATE` transaction as the mutation, deterministic duplicate reject.

**Acceptance:** exactly one mutation and one accepted result for a one-use
delegation.

### TM-08 — TOCTOU against lifecycle state

**Path:** validate delegation while job is in an allowed state, then race a
state/version/cycle transition before applying the write.

**Target mitigation:** load/check delegation and domain rows, consume the
record, and update with expected version in one immediate transaction.

**Acceptance:** stale state produces no accepted mutation or consumed grant
unless the documented transaction outcome explicitly commits a terminal use.

### TM-09 — Revocation race

**Path:** use a delegation while its session, record, or policy generation is
being revoked.

**Target mitigation:** durable AOM revocation and a defined serialization rule;
no Gateway cache authority; integration-generation and policy-generation checks
inside the use transaction. Incrementing the integration generation makes all
older grants fail at the next AOM check.

**Acceptance:** results are deterministic and never reported successful without
the corresponding committed record state.

### TM-10 — Restart/cache resurrection

**Path:** restart Gateway or restore stale local state to revive an expired,
consumed, or revoked grant.

**Target mitigation:** AOM store owns status; Gateway cache is non-authoritative;
unknown/store-unavailable state denies; old principal fallback is removed;
restore epoch and clock-rollback guard prevent revalidation of pre-restore or
time-extended grants.

**Acceptance:** restart cannot reset use count, expiry, revocation, or policy.

### TM-11 — Delegation laundering through capabilities

**Path:** present a narrow grant as generic `job:create`, `job:decide`, or a
role capability; use it to reach another handler.

**Target mitigation:** operation-specific caveat is checked in AOM; capabilities
remain a ceiling; role compatibility and existing handler checks remain.

**Acceptance:** a T1 grant cannot register or invoke T2/T3/T4 operations.

### TM-12 — `codex_decide` authority escalation

**Path:** use a delegated edge session to approve/reject/deliver/cancel by
claiming principal identity or generic `job:decide`.

**Target mitigation:** exact one-use payload binding, separate T4 approval class,
and a separately reviewed core-authority change. The adjudicated semantic rule
is that the operation remains an act of the sole `codex` principal through a
constrained delegated path; it is not a second policy-mediated authority.

**Acceptance:** no delegated `codex_decide` route exists until the core change,
principal-act semantics, and T4 approval are independently reviewed.

### TM-13 — Worker/edge confusion

**Path:** worker uses an edge delegation, edge uses a worker lease, or a
delegation grants `work:report`.

**Target mitigation:** disjoint contexts, actors, capabilities, resources, and
lease verification; no shared token format with ambiguous meaning.

**Acceptance:** worker and system identities cannot issue or consume edge
delegations; worker lease nonce cannot authorize a job decision.

### TM-14 — System actor misuse

**Path:** public request or Gateway claims `system` to obtain internal
settlement/recovery authority.

**Target mitigation:** system remains internal-only, has no token/capabilities,
and cannot issue client authority or make authoritative decisions.

**Acceptance:** all transport/system claims are denied and audited safely.

### TM-15 — Arbitrary proxy/SSRF expansion

**Path:** use delegation or Gateway routing fields to select an arbitrary AOM
path, host, URL, worker adapter, or local service.

**Target mitigation:** fixed downstream AOM audience/route, exact operation
mapping, no user-selected URL/path, and separate Gateway default-deny checks.

**Acceptance:** arbitrary paths and destinations are rejected before AOM.

### TM-16 — Audit/proof leakage

**Path:** logs, errors, audit detail, or response metadata reveal bearer,
Owner secret, proof, lease nonce, raw worker output, or sensitive body.

**Target mitigation:** existing redaction, bounded reason codes, opaque IDs,
secret-value suppression, and review of all failure paths.

**Acceptance:** negative tests inspect persisted audit and logs for secret
patterns without printing the secrets themselves.

### TM-17 — Policy downgrade/version confusion

**Path:** replay an older permissive policy version or ask AOM to interpret an
unknown/newer version as the current policy.

**Target mitigation:** immutable policy version in record/request hash;
unknown versions fail closed; global policy generation can revoke old grants.

**Acceptance:** downgrade, future-version, and cross-environment attempts fail.

### TM-18 — Denial-of-service as authorization bypass

**Path:** exhaust delegation rows, transaction locks, or verifier resources so
operators add a broad fallback or disable checks.

**Target mitigation:** bounded request/record sizes, durable per-integration
and per-tier issuance quotas, active-grant ceilings, rate limits, back-pressure,
safe 5xx/429 behavior, and an operational rule forbidding fallback to the full
principal bearer.

**Acceptance:** resource exhaustion never changes authorization semantics.

### TM-19 — Request-only issuer flooding

**Path:** a compromised Gateway uses its valid restricted edge identity to
submit a large number of otherwise valid T1 requests, attempting to accumulate
fresh authority even though it cannot mint records directly.

**Target mitigation:** AOM counts all issuance attempts in durable rolling
per-integration/per-tier buckets, caps active records and uses, applies
operation/resource ceilings, and supports a global emergency issuance disable.
Approval does not bypass the hard global and tier limits.

**Acceptance:** repeated valid requests stop at the documented quota; Gateway
restart, cache deletion, and subject-label rotation do not reset the quota.

## 8. Risk matrix

| Threat class | Likelihood after target design | Impact | Required disposition |
| --- | --- | --- | --- |
| Gateway process compromise | High enough to design for | High | Contain with AOM-issued exact grants and remove principal bearer |
| Delegation replay | High as a routine bug attempt | High for writes | Atomic one-use consumption required |
| Payload/resource substitution | High | High | AOM canonical binding required |
| OAuth confusion | Medium | High | Separate protocols and identities |
| Revocation race | Medium | High | Transaction/policy-generation semantics required |
| Audit leakage | Medium | High | Redaction and negative tests required |
| Worker/authority confusion | Medium | Critical | Disjoint contexts and explicit gates |
| Issuer flooding | High under Gateway compromise | High | Durable finite quotas and active-grant ceilings |
| AOM host compromise | Out of base model | Critical | Separate host security boundary; not claimed solved |
| Availability attack | High | Medium/High | Fail closed; no security weakening under pressure |

## 9. Maximum-authority comparison

| Compromise state | Stage-0 today | Phase 10B target after bearer removal |
| --- | --- | --- |
| Normal public read session | Gateway allowlist; AOM sees principal downstream | AOM sees an observer transport identity with `job:read` only |
| Gateway process compromised | Can attempt any reachable principal operation using full bearer | Can use restricted request-only identity, finite quotas, and valid bounded grants |
| Delegation stolen | Not applicable as a distinct AOM object | Exact integration-bound caveats until expiry/revocation/consumption |
| Gateway cache altered | May affect proxy behavior; bearer remains powerful | Cache cannot mint, widen, or resurrect AOM record |
| `codex_decide` | Hidden by Stage-0 allowlist, but principal bearer is stronger than edge | Separate exact T4 gate; no generic delegation |
| Worker lease stolen | Existing lease controls apply | Still separate; not accepted as edge/principal authority |

## 10. Security invariants to verify before any public write

1. AOM is the only issuer and final verifier.
2. Gateway does not possess a root signing key or full principal bearer before
   any public write.
3. Delegation scope is immutable after issuance.
4. Every write binds operation, resource, payload, lifecycle version, policy,
   integration subject, audience, time, epoch, and use count.
5. One-use consumption and domain mutation are atomic.
6. Revocation survives AOM/Gateway restarts.
7. Integration-generation revocation invalidates older bound grants at the next
   AOM check; OAuth logout is not falsely treated as per-session AOM revocation
   under S3.
8. Durable per-integration/per-tier issuance quotas, active-grant ceilings,
   TTLs, and emergency disable prevent unbounded fresh authority.
9. Unknown/invalid/unavailable verification, unknown epoch, and clock guard
   state fail closed.
10. No transport can widen or bypass the same domain checks.
11. Logs/audit/errors contain no secret material and use fixed reason enums.
12. `codex_decide` remains blocked until its core authority change, principal-
    act semantics, and T4 approval pass independent review.
13. Delegation IDs contain at least 128 bits of CSPRNG entropy.
14. HTTP and stdio make identical authorization decisions for identical
    verified contexts.

## 11. Required test families

### Static and schema tests

- source search proves no public route accepts a caller-supplied authority
  context;
- strict schemas reject unknown delegation fields;
- raw SQL cannot mutate immutable caveats or resurrect a consumed/revoked row;
- indexes/constraints support exact lookup without replacing transaction
  checks;
- migration rollback/restart preserves fail-closed state.

### Runtime tests

- issuance succeeds only through the approved local issuer path;
- read, T1, T2, T3, and T4 policy boundaries are distinct;
- cross-integration/audience/resource/payload/cycle/version uses fail; no
  per-ChatGPT-session security claim is tested under S3;
- expiry/not-before/revocation/policy-version failures fail closed;
- concurrent one-use calls have one winner;
- issuance attempts hit the documented rolling quotas and active-grant caps;
- AOM unavailable and Gateway restart do not create a fallback;
- HTTP/stdio produce identical authorization decisions for the same context;
- public route/path/tool probing cannot reach hidden tools.

### Operational tests

- revoke one record/session/integration and confirm no new use;
- increment integration generation and confirm every older delegation fails;
- rotate policy generation and confirm old records are rejected;
- remove old principal bearer and verify it cannot be found or used by the
  edge process;
- inspect logs/audit/diagnostics for secret leakage;
- restore from restart/crash points and confirm consumption/revocation;
- move the server clock backwards and confirm issuance/delegated mutation enter
  the clock guard without extending expiry;
- restore a pre-consumption/pre-revocation backup and confirm the new
  authorization epoch rejects all pre-restore delegations.

## 12. Residual-risk statement

Scoped delegation reduces the maximum authority of a compromised Gateway; it
does not make the Gateway trusted. The Gateway can still request permitted
low-risk grants until the integration/tier ceilings are exhausted, spend an
already-issued integration-bound grant, observe bounded result metadata, or
deny service. Under S3 it cannot be promised per-ChatGPT-session isolation,
and OAuth logout alone does not invalidate AOM grants. The design is acceptable
only if those residual risks are explicitly accepted per tier and if high-risk
authority remains subject to a separate approval path.

## 13. Threat-model verdict

The C-first server-side delegation model, with a request-only restricted edge
identity, finite issuance ceilings, integration-generation revocation, and
restore/clock guards, addresses the actual confused-deputy root cause more
directly than an edge-only allowlist or a Gateway-held signing key. The focused
independent re-review has passed with zero new blocking findings. U-1 is a
normative prohibition on edge self-provisioning, U-2 records the single-writer
AOM assumption, and U-3 requires deny-by-default treatment of future edge
identities. No threat-model conclusion in this document authorizes
implementation or public write access.
