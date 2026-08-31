# Phase 4 Plan — Authority & Auth Activation

> **APPROVED REVISION 8 IMPLEMENTATION BASELINE — PHASE 4 IMPLEMENTATION MERGED**
>
> This document carries the frozen Revision 8 planning baseline originating at
> `65008a97`. A subsequent Codex authorization permits the scoped implementation
> on `codex/phase4-implementation`.
> It does not authorize merge, push, deployment, or Phase 5/6 work.

Post-merge record: PR #7 merged the Phase 4 implementation into `main` at
`ea07fbcae4264fb91601ba03b1bbc84c57e8b7a5`. The final implementation branch
head was `29491c65dbd05ed8c568231cc7d8c9cec864c319`; this record is now closed
for Phase 4 and does not authorize Phase 5 implementation.

Date: 2026-08-31
Repository: `C:\AgentProjects\agent-orchestrator-mcp`
Authoritative Phase 4 base: `917a881aeab506538e55b1fac4eab12320ca9844`
Phase 3 reviewed implementation head: `4b4a1ee3a155cf7ca412cf4477519be50b69d3d7`
Current approved architecture baseline: `docs/ARCHITECTURE.md` Revision 8
Architecture amendment: Revision 8 (approved and merged implementation baseline)
Implementation authorization: **COMPLETED — MERGED IN PR #7**

## 0. Role, authority, and scope

Codex is the principal architecture authority and the sole authority actor in
V1. Claude/Opus/Sonnet material is review evidence, not an authorization to
merge. This document records the Phase 4 architecture, implementation scope,
and governance baseline.

The original planning snapshot deliberately did not itself:

- implement Phase 4 source code;
- create migrations 005 or 006;
- activate persistent authentication or new MCP tools;
- create or push a Phase 4 implementation branch or PR;
- rewrite migrations 001–004 or merged Phase 3 history;
- alter the Phase 3 merge commit or begin Phase 5/6 work.

At the time of the original planning turn, the only proposed repository changes
were this document, the Revision 8 proposal section in
`docs/ARCHITECTURE.md`, README status/link clarifications, and the Phase 3
status/hand-off clarifications in `docs/PHASE3_PLAN.md`, all on a
documentation-only branch. The subsequent Codex authorization created the
separate implementation branch; that branch remains limited to Phase 4 and
does not authorize merge, push, deployment, or Phase 5/6 work.

## 1. Frozen Phase 4 base

The merged Phase 3 base is fixed:

| Check | Required value | Result |
|---|---|---|
| Branch used for planning | `main` at the Phase 3 merge | passed before docs branch creation |
| `HEAD` before planning | `917a881aeab506538e55b1fac4eab12320ca9844` | matched |
| `origin/main` | `917a881aeab506538e55b1fac4eab12320ca9844` | matched |
| Phase 3 parent | `d255a5b2062f38c475cfb83c080e6bd98754505c` | merge parent |
| Phase 3 reviewed head | `4b4a1ee3a155cf7ca412cf4477519be50b69d3d7` | merge parent |
| Working tree before planning | clean | passed |

The implementation branch for a later Phase 4 build must start from the
reviewed Phase 3 merge commit, not from a stale pre-merge checkout. Any new
commit on `main` changes the planning base and requires a fresh comparison.

## 2. Authoritative inputs and Phase 3 hand-off

Read completely before this plan:

- `docs/ARCHITECTURE.md` Revision 7;
- `docs/PHASE3_PLAN.md`;
- `README.md`;
- `C:\AgentProjects\aom-benchmark\phase3-reviews\CODEX_PHASE3_PRINCIPAL_FINAL_REVIEW.md`;
- `C:\AgentProjects\aom-benchmark\phase3-reviews\OPUS5_PHASE3_REV7_FINAL_REREVIEW.md`.

The Phase 3 hand-off is:

- one SQLite source of truth at the trusted global state path;
- schema version 4, 13 tables, migrations 001–004;
- T1–T8 database barriers and canonical schema verification;
- durable `jobs`, `decisions`, and `audit_log` identities;
- structural repositories in the single `src/store/repositories.ts` module;
- `actor_tokens` schema present but persistent authentication inactive;
- doctor remains filesystem/security-only and never opens SQLite;
- Phase 2 environment/in-memory authentication and `ping` remain active;
- no production principal, system actor, token, authority tool, worker, or
  active audit writer is bootstrapped.

Explicit Phase 3 deferrals that Phase 4 now owns are:

| Deferred item | Phase 4 resolution required |
|---|---|
| Production principal/system bootstrap | Explicit, atomic, idempotent authority bootstrap |
| Persistent `actor_tokens` authentication | DB-backed resolver with no old-resolver fallback |
| Token issue/list/revoke lifecycle | Local CLI only; no token-admin MCP tool |
| Exactly one enabled principal | Fail-closed startup gate before transport exposure |
| Actor role/capability administration semantics | Immutable identity fields; explicit local operator lifecycle |
| Actor-token binding immutability | Schema guard; only approved lifecycle fields remain mutable |
| Capability catalogue and role compatibility | Static Zod-validated catalogue |
| Verified session attribution | `token_id`/`label` from the database, not client metadata |
| `TRANSITIONS`, `applyTransition`, `codex_decide` | Small authority core using existing fixture jobs; no job API |
| Active audit writing and chain semantics | Only after O-1 migration correction |

Phase 5/6 behavior remains outside this plan: job creation/listing, worker
execution, leases in active use, evidence/artifact tools, retries, reapers,
and external workers.

## 3. Proposed Architecture Revision 8

Revision 8 is the governing Phase 4 amendment for this implementation branch.
It preserves Revision 7, including the doctor boundary, schema
integrity, T1–T8, one SQLite store, Phase 2 transport contracts, and the
Phase 4/5/6 scope boundary.

Revision 8 proposes:

1. Migration 005 corrects the O-1 audit replacement condition before any audit
   writer is activated. Historical migrations 001–004 remain untouched.
2. Migration 006 adds actor and token binding immutability guards without
   freezing fields needed for disable/revoke or `last_used_at` lifecycle.
3. The target schema version becomes **6**. No new table and no token `scopes`
   column is needed.
4. The one principal actor remains literally `codex` in V1 for compatibility
   with the existing bootstrap design, but authority is represented by the
   actor role and database token mapping, not by an executable name.
5. Multiple verified sessions, including a future approved ChatGPT MCP client,
   map many `actor_tokens` rows to the same `codex` actor. No second principal
   or alternate authority system is introduced.
6. `codex_decide` is the only Phase 4 authority tool. `job_create`, job query
   tools, worker tools, and active lease/evidence/artifact workflows remain in
   their assigned later phases.
7. Active audit writing uses the existing `audit_log` table and is enabled only
   after O-1 is migrated and proven. Audit writes are append-only, redacted,
   bounded, and part of the same transaction as the action they record.
8. Transport compatibility is wire-only. The adapter exposes the fixed `mcp`
   transport marker as non-authoritative wire
   metadata; it is not stored as a token scope, does not grant a capability,
   and does not create an authentication fallback. Application authorization
   uses only verified actor capabilities.
9. Phase 3 T8 remains approved for its implemented replacement-protection
   scope. O-1 is a separate Phase 4 audit-activation prerequisite, and O-2 is
   a Phase 4 repository/domain write rule; neither retroactively changes the
   merged Phase 3 implementation.
10. Phase 4 owns decision-scoped idempotency and expected-version CAS for
    `codex_decide` only. Broader job/lifecycle idempotency and CAS remain with
    Phase 5.
11. Revision 8 uses the canonical JSON hash construction defined in §14.1:
    `prev_hash` is included once as the final canonical key, with no separate
    prefix concatenation.
12. Revision 8 adds the Phase 4 audit actions `bootstrap.completed`,
    `token.issued`, and `token.revoked` to the existing audit catalogue.

## 4. Identity and authority model

The V1 identity graph remains:

```text
principal actor:  actors(actor_id='codex', role='principal')
                      ▲
                      └── many actor_tokens rows / verified sessions

internal actor:   actors(actor_id='system', role='system')
                      └── no actor_tokens row and no transport path
```

The actor ID `codex` is retained because the Phase 3 architecture and current
Phase 2 compatibility surface already use it. This is not executable binding:
the resolver trusts the database row's `actor_id`, role, capabilities, token
identity, and lifecycle state. A future approved ChatGPT MCP session receives
another token row whose `actor_id` is `codex`; it does not become a new
principal and does not get a special authority path.

Authority comes from the enabled principal actor and the `job:decide`
capability. A session label, client ID supplied by a request, executable name,
or `session_hint` never confers authority.

## 5. O-1 and O-2 prerequisites

### 5.1 O-1 — audit sequence guard

O-1 is accepted as a non-blocking Phase 3 finding and is a hard prerequisite
to activating the Phase 4 audit writer. The implemented Phase 3 T8 guard
remains approved for its Phase 3 replacement-protection scope; O-1 is the
additional Phase 4 correction required before audit activation. Migration 005
is proposed as:

The implemented T8 audit predicate used a non-NULL-plus-existence check,
`NEW.seq IS NOT NULL AND EXISTS (...)`, without stating the positive sequence
domain expected by the audit chain. O-1 replaces that condition with the
positive-sequence form and keeps the Phase 3 approval scoped to replacement
protection only.

`005_audit_sequence_guard_correction.sql`

Inside the runner-owned transaction it must:

1. fail closed if an existing `audit_log` row has `seq <= 0`, because the
   corrected positive-sequence guard cannot safely claim that state;
2. drop and recreate only `trg_audit_no_replace` with the reviewed condition
   equivalent to `NEW.seq > 0 AND EXISTS (...)`;
3. record version 5 only after the schema operation succeeds;
4. leave the transaction rolled back if any migration check fails.

The migration itself does not insert a verification row into the append-only
audit ledger. O1-02 verifies omitted AUTOINCREMENT inserts and existing
positive identities against an isolated throwaway database after migration.
The compiled canonical fingerprint is updated in the reviewed WP1 source
change; runtime migration SQL cannot modify compiled source. If a pre-existing
nonpositive sequence is found, migration 005 rolls back and activation stops;
recovery requires restoring the approved database state or a separately
reviewed migration, not an in-place repair. Approved Phase 3 writes cannot
create that state.

The Phase 4 audit writer never accepts a caller-supplied sequence. It omits
`seq`, uses SQLite AUTOINCREMENT, and lets the database allocate the next
positive value. Any O-1 test failure blocks audit activation. A future stronger
table-domain constraint may be considered separately; it is not silently
added to this plan.

### 5.1.1 Versioned canonical fingerprint contract

The flat canonical fingerprint set shipped by Phase 3 describes schema version
4 only. Revision 8 extends it to a version-keyed set containing the expected
definitions for v4, v5, and v6. A Phase 4 migration runner verifies the current
ledger version against its matching set before applying a pending migration,
verifies the resulting set after that migration, and performs the final
init/serve integrity check against the v6 set. A v4 database therefore uses the
v4 expectations before migration 005, v5 expectations after migration 005,
and v6 expectations after migration 006. The version-keyed sets are compiled
source data updated in the reviewed WP1/WP2 source changes; runtime migration
SQL never changes them.

### 5.2 O-2 — no conflict-resolution writes

Phase 4 repositories and domain code must use:

- `INSERT` for a genuinely new durable identity;
- explicit, reviewed `UPDATE` for mutable job fields where the state machine
  permits it;
- append-only `INSERT` for decisions and audit rows.

No Phase 4 code may use `INSERT OR REPLACE`, bare `REPLACE`, or an UPSERT
conflict path for `jobs`, `decisions`, or `audit_log`. A source scan and a
runtime regression test are required. This is a design constraint for Phase 4,
not a new authority mechanism.

## 6. Exactly-one-enabled-principal startup invariant

After Phase 1 filesystem checks and Phase 3 schema/migration/integrity checks,
but before resolver construction and transport creation, Phase 4 checks:

1. exactly one row has `role='principal'` and `disabled=0`;
2. that row has `actor_id='codex'`;
3. exactly one enabled `actor_id='system'` row exists with `role='system'`;
4. the system actor has the exact internal representation described in §11;
5. every present actor's capabilities JSON parses and is role-compatible;
6. every present token is structurally valid, references an existing actor,
   has a unique digest, and does not reference `actor_id='system'`;
7. no additional actor has `role='system'` in the production state.

Behavior is fail-closed:

| State | Required behavior |
|---|---|
| Zero enabled principals | Refuse serve before HTTP bind/stdio output; do not auto-enable or bootstrap |
| One enabled `codex` principal | Continue if system, capabilities, tokens, and schema are valid |
| More than one principal | Refuse as corruption; the partial unique index should make this unreachable |
| Sole principal disabled | Refuse; disabling is a deliberate kill switch and is never auto-repaired |
| Missing/disabled/wrong/duplicate system actor, or a system-linked token | Refuse; serve never creates a system actor or exposes the internal identity |
| Corrupt/unknown/duplicate capabilities | Refuse before transport exposure; never fall back to an empty or broad set |
| No usable token | Refuse authenticated serving; explicit local `token issue` is required |

The failure must occur before `createHttpServer().listen()` and before
`serveStdio()` can emit protocol bytes. The startup error is bounded and never
contains token material, digests, raw JSON, or unbounded SQL.

## 7. Explicit production bootstrap

Phase 4 keeps `init` as the only explicit path allowed to bootstrap a zero-
principal schema. `serve` never creates actors or credentials.

### 7.1 Fresh post-Phase-3 schema

For a valid schema-v4 database with zero production actors and zero tokens,
`init` first applies and verifies the approved migrations through schema
version 6. It then performs these ordered bootstrap stages:

Before the bootstrap transaction:

1. validate that the state is the exact empty production bootstrap state;
2. generate one cryptographic bearer token in memory.

Within one `BEGIN IMMEDIATE` transaction:

3. insert `codex` as the sole enabled principal;
4. insert `system` as the enabled internal system actor;
5. store only the token's SHA-256 digest in an `actor_tokens` row mapped to
   `codex`;
6. commit the actor rows and token row atomically.

After a successful commit:

7. print the plaintext token exactly once, and never log or store it elsewhere.

If commit fails, the transaction rolls back and no partial authority state is
accepted. If printing fails after commit, no secret is recovered or logged;
the operator explicitly issues a new token. The token is never generated by
ordinary `serve`.

### 7.2 Existing and partial states

| Existing state | `init` behavior |
|---|---|
| Exact `codex` + exact `system` + valid token rows | Verify and return idempotently; do not create or print a token |
| Principal and system present, no token | Refuse as incomplete; require explicit `token issue` |
| Principal missing, system present | Refuse; no automatic actor creation or deletion |
| System missing, principal present | Refuse; no automatic system creation |
| Token rows present before a valid actor state | Refuse; inspect and recover explicitly |
| Multiple principal/system-role rows | Refuse as ambiguous/corrupt |
| Any invalid capabilities, role, digest, FK, or canonical schema | Refuse; no auto-repair |

All ambiguous states remain operator/recovery work. No bootstrap path deletes,
rewrites, or silently launders an existing actor/token row.

## 8. Token lifecycle and local CLI

The database continues to store exactly the Phase 3 columns:

`token_id`, `actor_id`, `token_sha256`, `label`, `disabled`, `expires_at`,
`last_used_at`, `created_at`.

`expires_at = NULL` means that the token has no scheduled expiry. A non-NULL
value is an immutable RFC3339 UTC timestamp ending in `Z`; a token is expired
when `expires_at <= current_utc_time`. Expired and revoked rows are retained
indefinitely in V1 for attribution and audit history, with no prune path in
this phase. The resolver rejects them permanently; retention never restores
authentication validity. Revocation remains one-way.

The first and later tokens are generated from cryptographically random bytes,
encoded as a whitespace-free base64url bearer value, and reduced immediately
to a SHA-256 digest for storage. The plaintext exists only long enough to print
once after a successful explicit issue transaction.

Proposed local-only commands:

```text
node dist/index.js token issue --label <label> [--expires-at <UTC timestamp>]
node dist/index.js token list
node dist/index.js token revoke --token-id <token_id>
```

`token list` returns only non-secret metadata and never returns the digest or
plaintext. `token revoke` performs a one-way `disabled: 0 → 1` update. There is
no token re-enable command; an operator issues a new token. Token renewal is a
new token, not an expiry rewrite. Token administration is CLI/operator-only,
not an MCP tool or a remotely callable capability.

Field policy:

| Field | Policy |
|---|---|
| `token_id` | Immutable identity |
| `actor_id` | Immutable binding |
| `token_sha256` | Immutable credential digest |
| `label` | Immutable verified session attribution |
| `expires_at` | Immutable after issue; issue a new token to renew |
| `created_at` | Immutable |
| `disabled` | Mutable only from 0 to 1 through revoke; never re-enabled |
| `last_used_at` | Mutable only by successful resolver bookkeeping |

`ORCHESTRATOR_ACTOR_TOKEN` remains the delivery channel for stdio and local
HTTP configuration. It is not an authority source: the resolver hashes it and
matches it against the database. `ORCHESTRATOR_ACTOR_ID`, token IDs, labels,
and scopes are never accepted from the environment as identity overrides.

## 9. Actor immutability and capability catalogue

### 9.1 Actor field policy

`actor_id`, `role`, `capabilities_json`, and `created_at` are immutable after
bootstrap. `display_name` is non-authoritative metadata and may be changed by
the local operator path. `disabled` is the explicit lifecycle switch; a
disabled principal causes startup failure and is never silently enabled by
serve. There is no actor administration MCP tool. Any actor enable/disable
command is local operator administration and must not alter role or capability
fields.

Migration 006 is proposed as:

`006_actor_token_immutability.sql`

It adds these physical guards with fixed messages:

| Trigger | Event/condition | Fixed message |
|---|---|---|
| `trg_actors_identity_immutable` | `BEFORE UPDATE ON actors` when `actor_id`, `role`, `capabilities_json`, or `created_at` changes | `actor identity, role, capabilities, and creation time are immutable` |
| `trg_actor_tokens_binding_immutable` | `BEFORE UPDATE ON actor_tokens` when `token_id`, `actor_id`, `token_sha256`, `label`, `expires_at`, or `created_at` changes | `actor token identity, binding, label, expiry, and creation time are immutable` |
| `trg_actor_tokens_no_reenable` | `BEFORE UPDATE OF disabled ON actor_tokens` when `OLD.disabled=1 AND NEW.disabled=0` | `disabled actor tokens cannot be re-enabled` |

These guards intentionally leave actor `disabled`, token `disabled` in the
revoke direction, and token `last_used_at` available to their explicit
lifecycle owners. They do not freeze fields by generic blanket update rules.

### 9.2 Exact capability catalogue

The public static catalogue is exactly:

```text
job:create
job:read
job:decide
qa:request
work:report
evidence:add
artifact:register
```

Capabilities are parsed from `actors.capabilities_json` with Zod as an array
of the fixed enum, duplicate-free, exact, and canonically sorted before an
actor row is written. Unknown values, duplicate values, malformed JSON, or a
role-incompatible set fail closed.

Role compatibility for Phase 4 is:

| Role | Allowed capabilities |
|---|---|
| `principal` | `job:create`, `job:read`, `job:decide`, `qa:request`, `evidence:add`, `artifact:register` |
| `worker` | `job:read`, `work:report`, `evidence:add`, `artifact:register` |
| `observer` | `job:read` |
| `system` | `[]` exactly; internal operations are explicit role-checked calls, not public capabilities |

`work:report` is worker-only and is not granted to the principal; the
principal has no lease-backed worker-report path.

`job:decide` is checked at tool registration, handler, domain, and database
boundaries. T1/T2 remain the final independent barriers. No token has database
scopes. The SDK adapter exposes the fixed `mcp` transport marker alongside
the verified actor capabilities for wire compatibility; the marker is not an
authority capability. Application authorization is derived from the verified
actor capabilities only.

## 10. Persistent token verification

The Phase 2 resolver is replaced by one DB-backed resolver with no fallback.
The resolver receives only the presented bearer token, hashes it in memory,
looks up the digest through a prepared statement, and validates the joined
actor/token state. It returns a trusted context equivalent to:

```text
{
  actor_id,
  role,
  capabilities,
  token_id,
  session_label,
  expires_at
}
```

The SDK adapter exposes `clientId=actor_id` and the fixed `mcp` transport marker
alongside actor capabilities for wire compatibility, but the application
context must retain the explicit role, actor ID, token ID, label, and
capabilities. The marker is not an authority capability.

| Input/state | Result |
|---|---|
| Unknown or malformed bearer | Generic invalid-token response; no detail about database state |
| Disabled token | Generic invalid-token response |
| Expired token | Generic invalid-token response |
| Missing actor or disabled actor | Generic invalid-token response; no fallback |
| System-role actor or token mapped to `actor_id='system'` | Generic invalid-token response; no client transport access; no fallback |
| Invalid role/capabilities in the database | Startup integrity failure before serving |
| Duplicate digest or broken FK | Startup integrity failure before serving |
| Database unavailable | Fail closed with bounded internal error; never use old resolver |
| Valid token | Trusted actor/role/capability/token/label context; update `last_used_at` atomically |

Successful `last_used_at` bookkeeping is not authority. If the bookkeeping
transaction fails, the request fails closed rather than returning authenticated
state with unverifiable session history. Client `session_hint` is retained only
as bounded, untrusted metadata for later audit context.

## 11. System actor

The production system actor is exactly:

```text
actor_id          = system
role              = system
disabled          = 0
capabilities_json = []
```

It has no token row and cannot authenticate through HTTP or stdio. Both the
startup gate and the resolver reject a system-linked token. Internal code
receives an explicit operation enum and checks the exact system actor at the
call site. Phase 4 may use it for approved bootstrap/audit/startup
operations only. Phase 6/8 still owns run settlement, reaping, cancellation,
and active worker lifecycle.

The system actor cannot author a decision, use `job:decide`, stamp an
authoritative status, or manufacture a principal decision. T1 rejects any
decision insert whose actor is not an enabled principal, and T2/T3/T4 remain
independent of the caller's application role.

## 12. Startup order and transport integration

The order is load-bearing:

```text
1. Resolve trusted state paths and run Phase 1 filesystem/security checks.
2. Open only the existing authoritative DB through the Phase 3 secure mode.
3. Apply only approved pending migrations through schema version 6.
4. Verify PRAGMAs, canonical schema, T1–T8, actor/token schema, and the O-1 plus actor/token guards.
5. Check exactly one enabled codex principal, exact system actor, capabilities, and tokens.
6. Construct the persistent resolver and the per-request actor context.
7. Construct HTTP/stdio MCP transports.
8. Bind HTTP or emit stdio protocol bytes.
```

No transport is created before step 5 succeeds. HTTP retains `127.0.0.1`, Host
and Origin checks, bearer protection, and body caps. Stdio authenticates the
token from `ORCHESTRATOR_ACTOR_TOKEN` against `actor_tokens` before the official
stdio server starts. There is no unauthenticated `tools/list` and no old
environment/in-memory resolver fallback after activation.

## 13. Transition and `codex_decide` boundary

`codex_decide` remains a Phase 4 responsibility. Phase 4 implements the
authority core, not the broader job lifecycle:

- it operates on an existing `jobs` row and may use fixture jobs in tests;
- `job_create`, `job_get`, `job_list`, cycle creation, and workspace lifecycle
  remain Phase 5;
- decision-scoped idempotency and expected-version CAS for `codex_decide` are
  Phase 4 responsibilities only; broader job/lifecycle idempotency and CAS
  remain Phase 5;
- registering `codex_decide` before Phase 5 is technically coherent as the
  authority primitive, although it returns a bounded not-found result until a
  later job lifecycle creates a job;
- the repository exposes no generic authoritative-status setter;
- `applyTransition` is the sole application writer of `jobs.state`,
  `jobs.authoritative_status`, and `jobs.deciding_decision_id`;
- the static `TRANSITIONS` table is copied from Architecture §6 without
  inventing new states or transitions;
- every mutating request requires `expected_version`, and a CAS conflict makes
  no decision/state/audit mutation;
- `rationale` is mandatory and bounded;
- a granting decision row is inserted before the status update in one
  `BEGIN IMMEDIATE` transaction;
- `session_token_id` is taken from verified auth, never request input;
- T1–T4 independently validate principal, semantic grant, monotonicity, and
  state/status agreement;
- `worker_verdict` is never read as authority;
- decision replay uses the existing actor/key/hash table and returns the
  original response on a same-request replay; this does not move broader
  lifecycle idempotency into Phase 4.

For an authoritative decision the transaction is:

```text
BEGIN IMMEDIATE
  load job
  validate actor, capability, transition, cycle, and expected_version
  validate evidence references as bounded identifiers
  INSERT decision with verified session_token_id
  UPDATE job state/status/deciding_decision_id/version
  INSERT redacted audit row
COMMIT
```

Any failure rolls back the complete decision/status/audit unit. Terminality and
durability remain database-owned even if a future repository is mistaken.

## 14. Audit activation

The audit writer is not activated until migration 005 and its tests pass. It
uses existing `audit_log` columns and no new table.

### 14.1 Canonical row and hash

The hash input is a compact UTF-8 canonical JSON object with this fixed key
order, excluding the `hash` field itself:

```text
seq, ts, actor_id, actor_role, session_token_id, request_id, session_hint,
action, job_id, cycle, capability, subject_type, subject_id, from_state,
to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash
```

Null values are represented as JSON null, keys are not reordered by callers,
and all detail text is redacted and bounded before hashing. The first row uses
`prev_hash = 64 zero characters`; each later row uses the previous row's hash.
`seq` is omitted from the INSERT and allocated by AUTOINCREMENT. There is no
self-repair, re-stitch, delete, update, or conflict-resolution path.

The stored hash is `SHA-256(canonical_json(row_without_hash))`; `prev_hash` is
included once as the final key in that canonical object. There is no separate
`prev_hash ||` prefix before hashing.

### 14.2 Phase 4 audit actions

Phase 4 audits only actions it owns:

- `bootstrap.completed`;
- `token.issued` and `token.revoked` with token ID/label metadata only;
- `auth.rejected` with no bearer, digest, or raw credential material;
- `startup.invariant_failed` only when a valid database/system actor can record
  it; otherwise the failure is bounded stderr only;
- `codex.decide` with verified actor/session attribution and redacted rationale.

An `auth.rejected` row is attributed to the internal `system` actor with a
null `session_token_id` and null `session_hint`. Rejected-auth writes are
globally rate-limited or aggregated under a configured bounded cap so an
unknown client cannot grow the append-only ledger without limit.
This is a Phase 4 audit-writer-internal in-memory bound, separate from the
Phase 9 transport rate limiter; it resets on process restart and requires no
new durable table. Phase 9 retains ownership of network/request rate limiting.

`audit_query`, worker events, evidence/artifact events, reapers, and full hash
chain reporting can remain with their assigned later phase unless the
independent Phase 4 review explicitly moves them. A broken chain is detected
and reported; it is never repaired automatically.

## 15. Future ChatGPT MCP compatibility

This is a future hand-off, not Phase 4 implementation. An approved ChatGPT MCP
client can eventually authenticate by receiving a token mapped to the existing
`codex` principal. It uses the same persistent resolver, capability catalogue,
session attribution, and authority rules as Codex.

It must not require:

- a second principal role;
- a second database or token store;
- ChatGPT-specific authority bypass;
- a separate authentication system;
- remote transport in this local Phase 4 implementation.

Future work may need a separately approved tunnel/transport, token delivery and
rotation, client registration, user confirmation/write policy, and connection
security. Those are not implemented or activated here.

## 16. Explicit Phase 5/6 exclusions

The following remain out of scope unless a future principal decision changes the
phase boundary:

- `job_create`, `job_get`, `job_list` and broader job lifecycle;
- `qa_dispatch`, active leases, `run_report`, worker runtime, NDJSON, and
  subprocess/process-tree management;
- evidence/artifact MCP tools and file path-jail operations;
- reapers, retries, crash recovery, cancellation, and queueing;
- browser/CDP/Gemini/`agy` workers;
- remote MCP exposure, ChatGPT tunnels, cloud persistence, and dynamic worker
  registries.

Phase 4 may use throwaway fixture jobs, worker-run rows, evidence rows, and
tokens in tests, but must not add production worker rows, production job
bootstrap, or future tool behavior under the guise of authority activation.

## 17. Phase 4 executable test matrix

The planned matrix contains **70 executable cases**. Each case must run against
an isolated throwaway database/state directory, record the expected failure
class without secrets, and verify unchanged state after a rejected mutation.

### BOOTSTRAP — BOOT-01 through BOOT-08

| ID | Case | Required result |
|---|---|---|
| BOOT-01 | Zero-principal schema before bootstrap | recognized as bootstrap-eligible only on explicit `init` |
| BOOT-02 | First production bootstrap | atomic `codex` + `system` + first digest-only token; print once after commit |
| BOOT-03 | Repeated bootstrap | idempotent; no second principal, token, or plaintext print |
| BOOT-04 | Partial actor state | refuse; no auto-repair |
| BOOT-05 | Principal exists with no token | refuse; require explicit token issue |
| BOOT-06 | System exists with principal missing | refuse; no silent actor creation |
| BOOT-07 | Pre-existing token rows in an ambiguous state | refuse; preserve rows |
| BOOT-08 | Corrupt bootstrap capabilities/role/schema | refuse before serving or printing credentials |

### TOKEN — TOKEN-01 through TOKEN-12

| ID | Case | Required result |
|---|---|---|
| TOKEN-01 | First token generation | cryptographic value; only digest persists |
| TOKEN-02 | Second token for same principal | succeeds; maps to `codex` with a distinct token ID |
| TOKEN-03 | Token list | returns safe metadata only; no digest/plaintext |
| TOKEN-04 | Unknown bearer | generic invalid-token response |
| TOKEN-05 | Malformed bearer | generic invalid-token response |
| TOKEN-06 | Disabled token | rejected |
| TOKEN-07 | Expired token | rejected |
| TOKEN-08 | Disabled actor with valid token | rejected |
| TOKEN-09 | Missing actor or token mapped to internal `system` | resolver and startup fail; no fallback or internal transport access |
| TOKEN-10 | Token binding update attempt | schema guard rejects actor/token identity change |
| TOKEN-11 | Token digest update or duplicate digest | schema/UNIQUE guard rejects it |
| TOKEN-12 | Revoke, re-enable, label, expiry, and last-use behavior | revoke is one-way; NULL expiry means no scheduled expiry; expired rows remain retained but invalid; immutable fields stay fixed; approved last-use update works |

### AUTH — AUTH-01 through AUTH-08

| ID | Case | Required result |
|---|---|---|
| AUTH-01 | HTTP valid persistent token | authenticated actor context from DB |
| AUTH-02 | HTTP unknown/expired/disabled token | 401 without identity detail |
| AUTH-03 | Stdio valid persistent token | auth completes before protocol output |
| AUTH-04 | Stdio invalid token | fails before protocol output |
| AUTH-05 | Old Phase 2 resolver unavailable | no fallback; startup/auth fails closed |
| AUTH-06 | Database unavailable during auth | bounded failure; no alternate store |
| AUTH-07 | Actor role/capability corruption during auth | startup gate refuses before transport |
| AUTH-08 | Unauthenticated `tools/list` and oversized body | rejected by existing transport gates |

### CAPABILITIES — CAP-01 through CAP-06

| ID | Case | Required result |
|---|---|---|
| CAP-01 | Exact catalogue parses | accepted and canonically represented |
| CAP-02 | Duplicate capability | refused |
| CAP-03 | Unknown capability | refused |
| CAP-04 | Role-incompatible capability | refused |
| CAP-05 | Worker/observer/system with `job:decide` | refused at visibility/handler/domain boundaries |
| CAP-06 | Client-supplied capability text/session label, or a fixed `mcp` marker present only in SDK wire context | ignored for authority; actor row remains source; the marker grants no application capability |

### STARTUP — START-01 through START-06

| ID | Case | Required result |
|---|---|---|
| START-01 | Zero enabled principal | fails before HTTP bind/stdio output |
| START-02 | Disabled sole principal | fails; no auto-enable |
| START-03 | More than one/corrupt principal state | fails as corruption |
| START-04 | Missing/disabled/duplicate system actor or system-linked token | fails; no auto-create or internal transport access |
| START-05 | Corrupt actor capabilities or token rows | fails before transport |
| START-06 | Tampered schema or migration state | Phase 3/4 canonical gate fails before exposure |

### SESSION — SESSION-01 through SESSION-04

| ID | Case | Required result |
|---|---|---|
| SESSION-01 | Two valid tokens | same `codex` actor authority |
| SESSION-02 | Distinct token IDs/labels | preserved independently |
| SESSION-03 | Decision/audit session attribution | verified `session_token_id` and label are recorded |
| SESSION-04 | Forged `session_hint` | remains untrusted and confers no authority |

### O-1 — O1-01 through O1-03

| ID | Case | Required result |
|---|---|---|
| O1-01 | Apply migration 005 from v4→v5 | corrected audit replacement guard is installed and version 5 is recorded before audit activation |
| O1-02 | Omitted AUTOINCREMENT sequence in an isolated throwaway database | normal audit inserts succeed with valid positive sequence values; no verification row is left in a production ledger |
| O1-03 | Existing identity/negative placeholder state | positive identity replacement rejected; invalid pre-existing nonpositive state blocks activation |

### O-2 — O2-01 through O2-02

| ID | Case | Required result |
|---|---|---|
| O2-01 | Source scan of durable repositories/domain | no UPSERT/REPLACE conflict path for jobs/decisions/audit and no authoritative-status assignment outside `domain/decide.ts` |
| O2-02 | Runtime durable mutation | explicit INSERT/UPDATE rules work; decisions/audit remain append-only |

### AUDIT — AUDIT-01 through AUDIT-07

| ID | Case | Required result |
|---|---|---|
| AUDIT-01 | First audit row | genesis `prev_hash` and canonical hash are correct |
| AUDIT-02 | Consecutive audit rows | each row links to the previous hash |
| AUDIT-03 | Chain verification | valid chain reports valid |
| AUDIT-04 | Mutated row/hash | verification detects the first break |
| AUDIT-05 | Redaction | bearer, digest, key, and configured secret values are absent |
| AUDIT-06 | Bounded detail and rejected-auth write cap | oversized detail is rejected or redirected, and rejected-auth writes remain within the approved bound |
| AUDIT-07 | Delete/update/replace/self-repair attempts | refused; no repair path exists |

### DECISION — DECIDE-01 through DECIDE-08

| ID | Case | Required result |
|---|---|---|
| DECIDE-01 | Principal `codex_decide` on fixture job, including `IGNORE_FALSE_POSITIVE` → `APPROVE` over FAIL | succeeds only with required capability/role; both decisions and their audit entries are recorded, with the final approval succeeding |
| DECIDE-02 | Worker/observer/system decision attempt and system property coverage | hidden and denied; T1 also rejects direct SQL; every `(state, transition)` pair rejects system authority |
| DECIDE-03 | Semantic grant mismatch | T2 rejects and transaction rolls back |
| DECIDE-04 | Decision/state/status atomic failure | no partial decision, job update, or audit row |
| DECIDE-05 | Expected-version conflict | `STATE_CONFLICT`; no mutation |
| DECIDE-06 | Terminality/regression attempt | T3 and domain transition guard reject |
| DECIDE-07 | Worker PASS/FAIL evidence and Codex rejection of PASS | worker evidence never changes authority; Codex can reject PASS with rationale |
| DECIDE-08 | Verified session/idempotency replay | correct token attribution and original response on replay |

### REGRESSION — REG-01 through REG-06

| ID | Case | Required result |
|---|---|---|
| REG-01 | Full Phase 3 suite plus v4→v5→v6 upgrade and fresh v6 initialization | all Phase 3 tests remain green; the complete upgrade path and fresh v6 state are valid |
| REG-02 | Doctor | remains no-direct-SQL and zero DB opener calls |
| REG-03 | Phase 2 HTTP/stdio | wire contracts and localhost gates remain compatible |
| REG-04 | Production tool inventory | only the explicitly approved Phase 4 tool additions appear; no Phase 5/6 tools |
| REG-05 | Windows/POSIX startup | ACL, state-root, schema, auth, and pre-bind gates pass on their matching platform |
| REG-06 | Future ChatGPT mapping | design remains one principal/many tokens with no special authority path |

### 17.1 Phase 4 invariant traceability

The Phase 4 invariants listed in `docs/ARCHITECTURE.md` §21 map to the
following existing cases; this table is traceability, not an additional test
count:

| Architecture invariant | Phase 4 case(s) | Required coverage |
|---|---|---|
| 1–2 | DECIDE-02, CAP-05, CAP-06 | Non-principal callers are denied and the authority tool is hidden; client-supplied identity/capability text cannot authorize decisions |
| 3–4 | DECIDE-07 | Worker PASS/FAIL evidence never changes authority; Codex can reject PASS with rationale |
| 5 | DECIDE-01 | `IGNORE_FALSE_POSITIVE` followed by `APPROVE` over FAIL is an audited principal flow |
| 6 | O2-01 | No authoritative-status assignment exists outside `domain/decide.ts` |
| 17 | START-01, START-02 | Zero or disabled enabled principal refuses service before exposure |
| 18–19 | SESSION-01..04, CAP-06 | Multiple tokens share one principal; attribution is verified and session hints/capability text confer no authority |
| 20 | DECIDE-05 | Decision-scoped expected-version CAS rejects the loser without mutation |
| 28 | DECIDE-02 | Every state/transition pair rejects system authority, not merely one example |
| 36 | AUDIT-01..04 | Genesis, chaining, verification, and tamper detection are covered |

## 18. Reviewable implementation work packages

The plan has **12 work packages (WP0–WP11)**. Each package must be reviewed and
green before the next begins.

| WP | Planned files | Invariants/tests | Rollback/failure | Boundary |
|---|---|---|---|---|
| WP0 — Revision 8 plan | `docs/PHASE4_PLAN.md`, `docs/ARCHITECTURE.md`, `README.md` | document consistency and independent architecture review | revert documentation-only commit; no runtime effect | planning only |
| WP1 — O-1 prerequisite | `src/store/migrations/005_audit_sequence_guard_correction.sql`, migration runner, version-keyed v4/v5 fingerprint definitions | O1-01..03; v4→v5; no negative pre-existing rows; fingerprint regenerated in the reviewed source change | runner transaction rolls back; audit writer remains disabled; migration writes no verification audit row | before audit activation |
| WP2 — actor/token schema guards | `src/store/migrations/006_actor_token_immutability.sql`, migration runner, version-keyed v5/v6 fingerprint definitions | TOKEN-10..12; canonical trigger checks; v5→v6 | migration rollback preserves actor/token rows; startup refuses partial state | identity binding only; no active auth yet |
| WP3 — production bootstrap | `src/commands/init.ts`, authority bootstrap module, CLI tests | BOOT-01..08; one principal/system; print-once | atomic rollback; ambiguous existing state refuses | explicit init only; serve never bootstraps |
| WP4 — persistent resolver | `src/mcp/auth.ts` or a dedicated persistent-auth module, repository queries | TOKEN-01..09, AUTH-01..07 | invalid token is generic failure; DB failure has no fallback | replaces Phase 2 resolver only after gate |
| WP5 — capabilities and roles | static capability module, actor validation, authority context | CAP-01..06 | malformed actor state refuses startup; no broad fallback | no dynamic capability source; no MCP admin |
| WP6 — startup authority gate | `src/commands/startup.ts`, `src/store/serve.ts`, runtime owner | START-01..06; pre-bind/pre-protocol ordering | close DB; no transport or repair on failure | exactly-one principal/system gate |
| WP7 — verified sessions | auth context, SDK adapter, server factory, attribution helpers | SESSION-01..04 | untrusted hints ignored; session mismatch denies | same actor, many tokens |
| WP8 — audit activation | audit writer/chain/redaction modules, migration-005 integration | O-1, AUDIT-01..07, DECIDE audit cases | action and audit roll back together; no self-repair | only Phase 4-owned actions |
| WP9 — transition/decision core | `src/domain/states.ts`, `transitions.ts`, `decide.ts`, `codex_decide` tool, repository methods | DECIDE-01..08; O2-01..02; T1–T4; decision-scoped CAS/idempotency; rationale | full transaction rollback; no generic status setter | no job/worker lifecycle |
| WP10 — transport/CLI integration | `src/cli.ts`, `src/mcp/http.ts`, `src/mcp/stdio.ts`, token/actor CLI | AUTH-01..08, REG-02..04 | no old resolver fallback; bind only after gate | no remote/ChatGPT tunnel |
| WP11 — hardening and final review | tests/docs/README/SECURITY material, CI configuration as approved | REG-01..06; source/secret/scope scans; Windows drill | stop on any gate failure; no merge until principal approval | final Phase 4 review only |

## 19. Security review questions — planned answers

1. **What establishes identity?** A presented bearer hashes to one unique
   `actor_tokens.token_sha256` row joined to an actor.
2. **What establishes authority?** The joined actor's enabled role and static
   capabilities; `job:decide` is principal-only and T1–T4 remain independent.
3. **What establishes session attribution?** The verified `token_id` and
   immutable database `label`.
4. **What client data is trusted?** Only the bearer as a credential candidate;
   the database decides its identity and capabilities.
5. **What remains untrusted?** `session_hint`, display text, evidence text,
   requested actor IDs, and all worker/model output.
6. **What if the principal is disabled?** Every auth attempt fails and serve
   refuses before exposure; no auto-enable occurs.
7. **Can a worker become principal through DB mutation?** Role/capability
   fields are guarded and the unique principal index plus T1 prevent it.
8. **Can a token change owners?** No; token binding and digest are immutable.
9. **Can a revoked token return?** No; disabled token rows cannot be re-enabled.
10. **Can old Phase 2 auth remain as fallback?** No after activation; one DB
    resolver is the only source.
11. **Can system authenticate remotely?** No token row may reference system;
    both the resolver and startup reject any such row, and transport auth
    exposes only approved client actors.
12. **Can audit leak a bearer?** Redaction, bounded fields, hash-only storage,
    and no plaintext logging prevent it; tests assert absence.
13. **Can a future ChatGPT principal session use the same model?** Yes, through
    another token mapped to `codex`, without another principal or authority
    system; transport/tunnel work remains future scope.

## 20. Proposed review and implementation process

1. Independent review of this plan and the Revision 8 amendment.
2. Principal adjudication of any returned architecture corrections.
3. Only after approval, create a Phase 4 implementation branch from the exact
   then-current `main` base and record its SHA.
4. Implement WP1/WP2 migrations and canonical updates first; run migration and
   rollback review before activating any writer.
5. Implement bootstrap, persistent auth, capability/startup gates, sessions,
   audit, and the narrow decision core in staged packages.
6. Run targeted review after each package, then Sonnet broad review.
7. Run Opus deep authority/security review including direct-database and
   connection-policy cases.
8. Run Codex principal final review against an exact frozen head.
9. Merge only after explicit principal approval; do not squash/rewrite unless
   an established repository policy requires it.

No implementation, migration, PR, merge, or Phase 4 activation is authorized
by this planning document alone.

## 21. Required quality and release gates for a later implementation

A later Phase 4 implementation must report, at minimum:

- clean working tree and exact base/head ancestry;
- `npm run ci`, `npm run build`, `npm audit`, and `git diff --check`;
- full Phase 3 regression and all 70 Phase 4 matrix cases;
- migration v4→v5→v6 upgrade and fresh v6 initialization;
- O-1 proof before audit writer activation;
- exact canonical fingerprints for every new/changed physical trigger;
- HTTP and stdio auth before bind/protocol output;
- zero plaintext token/key/digest logging or persistence;
- Windows throwaway doctor/init/re-init/serve drill with lease continuity;
- `ping` compatibility and no Phase 5/6 leakage;
- independent Sonnet/Opus review and Codex principal final review.

## 22. Planning status and requested decision

Architecture Revision 8 is internally coherent and preserves the merged
Revision 7 boundary. The target schema version is 6, with migrations 005 and
006. O-1 is a pre-audit activation gate; O-2 is an explicit
no-conflict-resolution-write rule. The plan received independent review,
Codex implementation authorization, targeted re-review, principal final
review, and merge verification through PR #7. Phase 4 is now closed; Phase 5
planning requires a separate authorization decision.

Current status: **PHASE 4 IMPLEMENTATION COMPLETE AND MERGED — PHASE 5 NOT AUTHORIZED**.
