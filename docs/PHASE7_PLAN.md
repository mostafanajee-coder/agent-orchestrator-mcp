# AOM — PHASE 7 EVIDENCE AND ARTIFACT PLAN

> **Status: approved Phase 7 implementation baseline.** This document records
> the reviewed Revision 10 boundary and the separate Codex authorization for
> `codex/phase7-implementation`. Merge, deployment, push, and pull request
> remain unauthorized.

Date: 2026-09-01
Repository: `C:\AgentProjects\agent-orchestrator-mcp`
Approved planning snapshot: `96cdaa587a6551e40e833eba1a63ad252dc99bd3`
Implementation branch: `codex/phase7-implementation`
Authoritative base: `main` and `origin/main` at
`88670743f8a443bbf3b71c9f379199deca42d512`
Tree: `477235e7474e6930c37afcac9149dcb5f5b4388b`
Proposed architecture amendment: **Revision 10**
Phase 6 base schema: **version 6**
Phase 7 implementation schema: **version 7**
Implementation authorization: **YES — Codex decision recorded on `codex/phase7-implementation`**

## 0. Governance and authority

Codex remains the principal architecture and implementation authority. Phase 7
has entered planning only because Phase 6 is complete and published. The
sequence is:

```text
published Phase 6 baseline
  -> documentation-only Phase 7 plan
  -> frozen planning snapshot
  -> independent architecture review
  -> Codex adjudication of every finding
  -> explicit Phase 7 implementation authorization
  -> separate implementation branch
  -> implementation review, final merge gate, and post-merge closure
```

The original planning snapshot did not itself authorize implementation. The
separate authorization decision has now been recorded for the implementation
branch created from the published Phase 6 `main` base:

```text
AUTHORIZE PHASE 7 IMPLEMENTATION: YES
```

This authorization covers only the Revision 10 scope in this document. It does
not authorize Phase 8, Phase 9, deployment, Push, PR creation, or Merge.

The implementation branch may change only the source, tests, migrations,
schema fingerprints, and runtime wiring required by this plan. It must not
introduce Phase 8/9 behavior, deployment, Push, PR creation, or Merge.

## 1. Inherited Phase 6 baseline

The published baseline already provides:

- durable jobs and cycles;
- non-authoritative `worker_runs` and `leases` records;
- bounded local worker execution;
- pipe and local pull reporting;
- `qa_dispatch`, `run_report`, and `run_status`;
- a single `codex_decide` authority path;
- HTTP and stdio transport parity;
- the protected global state root and artifact directory layout;
- schema-v6 `evidence` and `artifacts` tables that are structurally present but
  not written by Phase 6.

The presence of the two tables is not evidence that Phase 7 behavior is active.
Phase 7 must activate them deliberately and preserve the existing distinction
between worker observations and Codex decisions.

The current source already reserves `evidence` and `artifacts` in the
`job_get` input shape, but the Phase 5 behavior rejects those collections as
unsupported. Phase 7 must choose and document a bounded read surface rather
than silently changing that behavior.

## 2. Objective and success criterion

Phase 7 defines the smallest durable evidence/artifact layer that allows a
completed worker run or a principal to submit bounded observations and files,
allows Codex to inspect their metadata, and allows a decision to cite evidence
without allowing any worker output to become an authoritative job state.

Phase 7 succeeds only when all of the following are true:

1. Evidence records are bounded, attributable, append-only, and linked to the
   correct job, cycle, run, and optional artifact.
2. Artifact files are copied by the orchestrator into the dedicated artifact
   root; metadata is stored in SQLite; the orchestrator computes the byte count
   and SHA-256 digest.
3. Client input cannot choose a final artifact path, escape the permitted source
   root, or claim a stronger trust class than the server assigns.
4. The database and domain transaction enforce cross-record consistency and
   reject duplicate or conflicting writes deterministically.
5. Codex can obtain bounded evidence and artifact metadata and cite existing
   evidence from `codex_decide`.
6. `PACKAGE`/`DELIVER` behavior has an explicit manifest contract.
7. Phase 8 responsibilities remain inactive: no reaper, restart recovery,
   orphan cleanup loop, cancellation redesign, or broad retry scheduler.

## 3. Explicit scope boundary

### 3.1 In scope

| Area | Phase 7 decision |
|---|---|
| Evidence admission | Activate a bounded `evidence_add` domain operation and MCP tool. |
| Artifact admission | Activate a bounded `artifact_register` domain operation and MCP tool. |
| Metadata reads | Add bounded read-only evidence and artifact metadata access through a documented MCP surface. |
| Worker output | Extend the Phase 6 normalization path to accept explicit evidence/artifact messages only after validation. |
| Trust | Assign trust from the verified producer; never accept a client-supplied trust value. |
| File storage | Copy bytes into the global artifact root and store metadata only in SQLite. |
| Integrity | Compute the digest and byte count from the copied bytes. |
| Decision linkage | Validate supplied `evidence_refs` against the same job and cycle. |
| Packaging | Define and generate a bounded manifest artifact required before delivery. |
| Persistence | Add only the reviewed schema guards/indexes needed for append-only evidence/artifact records. |
| Audit | Add append-only audit actions for evidence and artifact admission and rejection. |

### 3.2 Explicitly out of scope

- restart recovery, orphan reaping, or background cleanup;
- cancellation redesign or graceful-shutdown orchestration;
- autonomous retry scheduling or remote retry policy;
- remote, cloud, browser, or external worker integration;
- reading artifact file contents through MCP resources;
- retention deletion, pruning, backup rotation, or archival storage;
- telemetry, metrics, budgets, or general rate limiting;
- a new authority role or a second decision writer;
- changes to the Phase 4 authority model or Phase 5 state machine semantics;
- Phase 8 `audit_query` activation;
- Phase 9 hardening or deployment work;
- any Phase 7 source implementation in this planning snapshot.

## 4. Proposed Revision 10 decisions

### D7-01 — Reuse the existing evidence/artifacts tables, with reviewed guards

The existing schema-v6 columns are sufficient for the first Phase 7 contract:

- `evidence`: `evidence_id`, `job_id`, `cycle`, optional `run_id`,
  `source_actor`, `trust`, `kind`, optional `severity`, bounded `summary`,
  bounded `detail_json`, optional `artifact_id`, and `created_at`;
- `artifacts`: `artifact_id`, `job_id`, `cycle`, optional `run_id`, `kind`,
  optional `mime`, optional `label`, server-owned `rel_path`, measured `bytes`,
  server-computed `sha256`, `created_by`, and `created_at`.

Phase 7 proposes schema version 7 with one reviewed migration for:

1. append-only `BEFORE UPDATE` and `BEFORE DELETE` guards on both tables;
2. insert-time binding guards for job/cycle/run relationships;
3. any indexes proven necessary by the bounded list queries.

No column is added unless independent review demonstrates that an existing
column cannot express a required contract. If the existing schema is accepted
as sufficient, the migration remains limited to the guards and indexes.

The canonical schema definitions, migration ledger, and startup fingerprints
must be updated together in a future implementation. None is changed here.

### D7-02 — Evidence is a server-classified observation

The public input must not contain a writable `trust` field. The server assigns:

| Producer | Assigned trust | Required binding |
|---|---|---|
| verified principal | `principal` | authenticated principal and target job |
| verified worker | `untrusted` | active run lease, matching actor/job/cycle/run |
| server-owned deterministic producer | `deterministic` | only an explicitly named internal producer |
| system actor | none | system has no public evidence capability |

Phase 7 does not classify arbitrary worker claims as deterministic. The
`deterministic` value remains reserved until a concrete server-owned producer
is specified.

`source_actor` is derived from verified identity or the active run lease. It is
never taken from an untrusted request field.

### D7-03 — Evidence input and limits are fixed

`evidence_add` accepts only the following bounded fields:

| Field | Contract |
|---|---|
| `job_id` | required bounded identifier |
| `cycle` | required non-negative integer matching the job/run |
| `run_id` | required for worker producers; optional for the principal |
| `kind` | required UTF-8 string, 1–64 bytes, no control lines |
| `severity` | omitted/null or one of `info`, `warning`, `error`, `critical` |
| `summary` | required trimmed UTF-8 string, 1–2,048 bytes |
| `detail` | optional valid JSON value, canonical serialized size ≤65,536 bytes |
| `artifact_id` | optional existing artifact from the same job/cycle; if `run_id` is present, it must match |
| `idempotency_key` | required UUID for public mutations |

The operation returns the server-generated `evidence_id`, assigned trust,
source actor, job/cycle/run binding, and creation time. It never changes an
authoritative job status.

The first implementation also caps a job at 1,024 evidence rows. The count is
checked inside the write transaction and existing evidence is never replaced
or removed when the cap is reached.

Evidence rows are immutable after insertion. Repeating the same idempotency
request returns the original result; reusing its key with a different request
is an `IDEMPOTENCY_CONFLICT`.

### D7-04 — Artifact storage is orchestrator-owned

The canonical artifact root remains the state-root `artifacts` directory. The
server creates a run-scoped staging directory and the final path. A worker may
provide only a relative source name within that server-created staging
directory. A principal may provide a relative source name within the approved
job workspace. Neither caller may choose a final artifact path.

The final path is generated by the server and is never accepted from the
client. The normalized database `rel_path` uses `/` separators and has the
following shape:

```text
<job_id>/<cycle>/<scope>/<artifact_id>-<sanitized-name>
```

`scope` is the run id for run artifacts and `package` for a server-generated
manifest. The server rejects absolute paths, traversal, drive/device prefixes,
alternate data streams, reserved device names, trailing dots/spaces, symlinks,
reparse points, and paths outside the selected source root or artifact root.

The registration sequence is:

1. validate the caller, job/cycle/run binding, source-root policy, metadata,
   and quota before copying;
2. open the source using the platform-safe no-follow policy and stream it to a
   server-created temporary file under the artifact root;
3. enforce the byte limit while copying and compute SHA-256 from the bytes
   actually copied;
4. atomically place the temporary file at the server-generated final path;
5. enter `BEGIN IMMEDIATE`, revalidate the job/run/lease and quota, insert the
   metadata row and audit event, and commit;
6. on any failed database operation, remove the staged/final file on a
   best-effort basis and return a typed error; no metadata row is returned as
   successful.

Crash recovery for residue left between filesystem placement and database
commit belongs to Phase 8. Phase 7 must not introduce a background reaper.

### D7-05 — Artifact limits are explicit

The first implementation target uses these fixed bounds:

- maximum artifact bytes: 16 MiB;
- maximum total artifact bytes per job: 256 MiB;
- maximum artifact rows per job: 256;
- maximum `kind`: 64 bytes;
- maximum `mime`: 128 bytes;
- maximum `label`: 256 bytes;
- maximum stored relative path: 512 bytes.

The per-job count and byte checks run inside the write transaction. Existing
artifacts are never deleted or silently replaced when a quota is reached.

### D7-06 — Worker transport extension is normalized once

Phase 6 accepts `ready`, `progress`, `result`, and `error`. Phase 7 adds
validated `evidence` and `artifact` messages to the internal normalization
contract.

For pipe mode, the runtime creates the run staging directory, passes its
server-generated location in the private start envelope, stages the files and
messages, and sends them through one shared domain settlement path. For
`mcp_pull`, the worker receives the same run-scoped staging location and submits
the same logical records through the public operations while its run lease is
active. Both paths derive identity and trust on the server and use the same
validators.

An evidence/artifact message cannot set job state, consume a lease, create a
decision, or claim `principal` trust. A malformed or oversized message is
recorded as a bounded run failure according to the Phase 6 rules.

### D7-07 — Worker and principal admission rules

| Operation | Principal | Worker | Observer | System |
|---|---:|---:|---:|---:|
| `evidence_add` | yes | yes, active lease | no | no |
| `artifact_register` | yes | yes, active lease | no | no |
| metadata read | yes | job-read policy only | yes | no public surface |

Worker calls must match the verified actor, registered worker, active lease,
job, cycle, and run. A consumed, expired, stale, or mismatched lease is
rejected. A principal call uses the existing principal authority and job access
policy; it cannot impersonate a worker or rewrite a worker record.

### D7-08 — Bounded metadata reads

Phase 7 adds read-only metadata access without exposing artifact bytes through
MCP. The preferred surface is two dedicated operations:

- `evidence_list`: bounded evidence records, filterable by job and optional
  cycle, ordered by `(created_at, evidence_id)`;
- `artifact_list`: bounded artifact metadata, filterable by job and optional
  cycle, ordered by `(created_at, artifact_id)`.

Each accepts `limit` from 1 through 100 and an opaque cursor with a maximum
length of 2,048 bytes. Responses include a `next_cursor` only when more rows
remain. No raw file bytes, worker streams, or unbounded detail is returned.

The existing `job_get` `include: evidence|artifacts` values remain explicitly
unsupported unless implementation design proves that their mixed-collection
pagination can be made equivalent to these contracts. The decision must be
recorded before implementation, not left to an incidental handler choice.

### D7-09 — Decision references are validated, not authority-expanded

`codex_decide.evidence_refs` remains optional for backward compatibility. When
present, every reference must be unique, bounded, present in `evidence`, and
belong to the same job and cycle as the decision. A missing, foreign, or
cross-cycle reference returns a typed input/state error before the decision is
committed.

Evidence references explain a decision; they do not grant authority. The only
authoritative writer remains `codex_decide`, and worker evidence cannot alter
the decision transition table.

### D7-10 — Package manifest is server-generated

The `PACKAGE` path generates one canonical manifest artifact for the current
job/cycle. It contains bounded metadata only:

- job and cycle identity;
- the ordered evidence ids and their trust/source metadata;
- artifact ids, relative paths, byte counts, and computed digests;
- the relevant decision-chain identifiers.

It contains no raw worker transcript and no credential material. The manifest
is written by the server with `run_id = NULL`, `scope = package`, and
`created_by = codex`. `DELIVER` requires exactly one current-cycle manifest
whose metadata and file both verify. A manifest is not itself an authoritative
decision.

If manifest creation fails, `PACKAGE` must not report successful packaging. The
implementation must keep the decision/job/file transaction boundary explicit;
filesystem placement and SQLite commit cannot be claimed atomic without the
staging and rollback protocol in D7-04.

### D7-11 — Append-only persistence and audit

Evidence and artifact rows are append-only in Phase 7. No update, delete,
replacement, or prune operation is introduced. The database guards must reject
direct SQL `UPDATE`, `DELETE`, `INSERT OR REPLACE`, and `REPLACE` attempts that
would replace existing durable rows.

The audit action catalogue adds only the reviewed Phase 7 events:

- `evidence.add`;
- `artifact.register`;
- `evidence.rejected`;
- `artifact.rejected`;
- `artifact.hash_mismatch`;
- `artifact.quota_rejected`.

Audit detail remains bounded and redacted. Audit events describe admission or
rejection; none records an authoritative state change for a worker result.

### D7-12 — Phase boundary remains explicit

Phase 7 activates evidence/artifact admission and bounded metadata inspection.
It does not activate recovery, `audit_query`, external integrations, or file
content resources. Any proposal that requires one of those is a separate phase
decision and is out of scope for this plan.

## 5. Proposed MCP surface

| Operation | Mutation | Caller | Purpose |
|---|---:|---|---|
| `evidence_add` | yes | principal or lease-bound worker | append one bounded observation |
| `artifact_register` | yes | principal or lease-bound worker | copy and register one bounded file |
| `evidence_list` | no | reader with `job:read` | page bounded evidence metadata |
| `artifact_list` | no | reader with `job:read` | page bounded artifact metadata |

The two mutation operations must use the existing idempotency and audit
patterns. The two list operations are read-only and must not update usage,
leases, jobs, decisions, or artifact files.

No worker-administration, arbitrary file-read, artifact-delete, prune,
recovery, audit-query, or second-decision operation is part of Phase 7.

## 6. Error contract

The future implementation must use stable typed errors rather than leaking
filesystem or database exception text. The proposed codes are:

```text
INVALID_INPUT
AUTHORIZATION_DENIED
JOB_NOT_FOUND
RUN_NOT_FOUND
ARTIFACT_NOT_FOUND
LEASE_INVALID
STALE_CYCLE
STATE_CONFLICT
PATH_REJECTED
QUOTA_EXCEEDED
HASH_MISMATCH
IDEMPOTENCY_CONFLICT
LIMIT_EXCEEDED
INTERNAL_ERROR
```

Responses must be bounded, must not expose local absolute paths, and must not
return raw file content or internal exception stacks.

## 7. Transaction and consistency rules

The following relationships are mandatory:

1. An evidence row's job/cycle must match the referenced job.
2. A non-null evidence `run_id` must identify a run for the same job/cycle.
3. An evidence `artifact_id`, when present, must identify an artifact from the
   same job/cycle. If the evidence has a `run_id`, the artifact must have the
   same `run_id`; principal evidence without a run may cite any artifact from
   the same job/cycle.
4. A non-null artifact `run_id` must identify a run for the same job/cycle.
5. A worker producer must have an active, unconsumed lease for the exact run,
   actor, job, and cycle at the time of admission.
6. Quota, duplicate, and binding checks must occur inside `BEGIN IMMEDIATE`.
7. Evidence/artifact inserts and their audit entries commit together.
8. A failed artifact copy never produces a successful metadata row.
9. A failed metadata transaction never returns a successful registration.
10. A duplicate request returns its original result and performs no second
    insert or second audit admission event.

## 8. Work packages

| Package | Deliverable | Depends on |
|---|---|---|
| WP0 | Freeze scope, vocabulary, limits, and authority boundary | — |
| WP1 | Implement and verify proposed schema-v7 guards/indexes | WP0 |
| WP2 | Add canonical evidence/artifact records and validators | WP0, WP1 |
| WP3 | Build artifact staging, path policy, copy, hash, and quota service | WP2 |
| WP4 | Implement `evidence_add` with lease/principal admission | WP2 |
| WP5 | Implement `artifact_register` with transactional metadata admission | WP3, WP4 |
| WP6 | Extend worker message normalization and both delivery paths | WP4, WP5 |
| WP7 | Add bounded evidence/artifact metadata reads | WP2 |
| WP8 | Validate decision evidence references and package manifest behavior | WP4, WP5, WP7 |
| WP9 | Add audit actions and redaction coverage | WP4–WP8 |
| WP10 | Complete unit, raw-SQL, integration, and cross-platform tests | WP1–WP9 |
| WP11 | Documentation, independent implementation handoff, and final review | WP10 |

No package may begin until the explicit implementation-authorization decision
is recorded after independent review of this planning baseline.

## 9. Acceptance matrix

### Schema and durability

| ID | Acceptance condition |
|---|---|
| P7-SCH-001 | Proposed migration applies only from schema version 6 to 7. |
| P7-SCH-002 | Startup rejects a database newer than the binary. |
| P7-SCH-003 | Evidence UPDATE and DELETE are rejected by the database. |
| P7-SCH-004 | Artifact UPDATE and DELETE are rejected by the database. |
| P7-SCH-005 | REPLACE cannot replace an existing evidence or artifact identity. |
| P7-SCH-006 | Job/cycle/run binding guards reject mismatched inserts. |
| P7-SCH-007 | Canonical schema fingerprints include every new guard/index. |

### Evidence

| ID | Acceptance condition |
|---|---|
| P7-EVD-001 | Principal evidence receives `principal` trust. |
| P7-EVD-002 | Worker evidence receives `untrusted` trust. |
| P7-EVD-003 | Client-supplied trust is rejected or ignored, never honored. |
| P7-EVD-004 | Worker identity comes from the verified actor/lease. |
| P7-EVD-005 | Expired, consumed, stale, or mismatched leases are rejected. |
| P7-EVD-006 | Summary byte limit is enforced. |
| P7-EVD-007 | Detail JSON validity and byte limit are enforced. |
| P7-EVD-008 | Invalid severity and kind values are rejected. |
| P7-EVD-009 | Foreign artifact references are rejected. |
| P7-EVD-010 | Evidence insertion and audit admission are one transaction. |
| P7-EVD-011 | Idempotent replay returns the original evidence id. |
| P7-EVD-012 | Idempotency-key reuse with changed input is rejected. |

### Artifacts

| ID | Acceptance condition |
|---|---|
| P7-ART-001 | Final path is generated by the server. |
| P7-ART-002 | Absolute, traversal, device, ADS, reserved-name, symlink, and reparse inputs are rejected. |
| P7-ART-003 | Source containment is checked on the real path and during safe open. |
| P7-ART-004 | The per-artifact byte limit is enforced while streaming. |
| P7-ART-005 | The job count and total-byte quotas are enforced in the write transaction. |
| P7-ART-006 | SHA-256 is computed from copied bytes, not accepted from the caller. |
| P7-ART-007 | Stored `bytes` equals the copied byte count. |
| P7-ART-008 | A copy failure leaves no successful metadata row. |
| P7-ART-009 | A metadata failure performs best-effort file cleanup. |
| P7-ART-010 | Duplicate idempotent registration does not create a second row/file. |
| P7-ART-011 | Artifact metadata is immutable after insertion. |
| P7-ART-012 | `artifact_list` returns metadata only, never file bytes. |

### Worker and decision integration

| ID | Acceptance condition |
|---|---|
| P7-INT-001 | Pipe evidence messages use the shared evidence admission path. |
| P7-INT-002 | Pipe artifact messages use the shared artifact admission path. |
| P7-INT-003 | Pull-mode worker calls use the same validation rules. |
| P7-INT-004 | Evidence/artifact output never changes authoritative status. |
| P7-INT-005 | Supplied decision references must exist in the same job/cycle. |
| P7-INT-006 | Omitted evidence references remain backward-compatible. |
| P7-INT-007 | `PACKAGE` produces one canonical manifest artifact. |
| P7-INT-008 | `DELIVER` rejects a missing, foreign, or unverifiable manifest. |
| P7-INT-009 | Manifest creation failure cannot report successful packaging. |

### Transport, limits, and scope

| ID | Acceptance condition |
|---|---|
| P7-MCP-001 | Only the four approved Phase 7 operations are exposed. |
| P7-MCP-002 | Worker callers cannot see principal-only mutation behavior. |
| P7-MCP-003 | Observer callers can read only bounded metadata. |
| P7-MCP-004 | Cursors are opaque, bounded, and filter-specific. |
| P7-MCP-005 | Error responses contain no local absolute paths or stacks. |
| P7-MCP-006 | HTTP and stdio expose equivalent schemas and visibility. |
| P7-SCP-001 | No Phase 8/9 operation is registered. |
| P7-SCP-002 | No recovery, reaper, prune, or autonomous retry loop is added. |
| P7-SCP-003 | No remote or external worker path is added. |
| P7-SCP-004 | Existing Phase 4 authority and Phase 5 lifecycle semantics remain intact. |
| P7-SCP-005 | Phase 7 changes remain within the approved changed-path set. |

## 10. Risks and resolved boundaries

| Risk | Phase 7 treatment |
|---|---|
| Filesystem/database two-system commit gap | Staging, atomic placement, immediate transaction, cleanup, and explicit Phase 8 residue ownership. |
| Large or numerous evidence/artifact records | Fixed byte/count/detail limits and bounded cursors. |
| Worker claims stronger trust | Trust is server-derived and deterministic is reserved. |
| Cross-job or cross-cycle references | Domain checks plus database binding guards. |
| Artifact replacement | Append-only guards, unique job/path index, and no replacement operation. |
| Sensitive data in details or filenames | Bounded fields, redacted audit detail, generated final names, and no raw streams in responses. |
| Phase 7 expanding into resilience | Recovery, reaper, prune, and retry behavior are explicitly Phase 8 or later. |
| Unbounded artifact growth | New registrations stop at the fixed per-job quota; retention/prune is later. |

## 11. Open decisions for independent review

The proposal makes the following choices for independent review; they are not
implementation permission:

1. The 16 MiB per-artifact and 256 MiB per-job limits are the initial fixed
   operating bounds.
2. Worker artifacts may come only from a server-created run staging directory.
   Principal registration may use a file inside the already-approved job
   workspace. Neither caller may choose the final artifact path.
3. The four-operation MCP surface is sufficient for Phase 7; artifact bytes
   remain unavailable through MCP until a later read-resource phase.
4. The manifest is generated by the server as part of the `PACKAGE` operation,
   with the staging and revalidation protocol defined in D7-10.
5. The existing columns are sufficient; binding and append-only protection are
   implemented as reviewed database triggers and indexes, without adding a
   column by default.

The independent reviewer may challenge any choice, but each challenge must be
classified and adjudicated by Codex before implementation planning is frozen.

Any answer that materially changes scope, schema, authority, or phase ownership
must be recorded in the review findings and adjudicated by Codex before
implementation planning is frozen.

## 12. Review and implementation sequence

1. Freeze the documentation-only planning snapshot.
2. Provide `PHASE7_PLAN.md`, the Revision 10 section of `ARCHITECTURE.md`,
   `PHASE6_POST_MERGE_CLOSURE.md`, `PHASE6_PLAN.md`, and
   `WORKER_PROTOCOL.md` to one independent architecture reviewer.
3. Require a complete read manifest and a finding-by-finding verdict.
4. Codex classifies each finding as blocking, non-blocking, or rejected.
5. Codex applies documentation corrections only when required.
6. Freeze the corrected planning snapshot again if the documents change.
7. Codex issues the separate decision:

```text
AUTHORIZE PHASE 7 IMPLEMENTATION: YES / NO
```

8. The current branch was created from the exact approved published `main` base
   and carries this approved planning snapshot. Source work is authorized only
   within Revision 10 as recorded above.

## 13. Current authorization state

```text
PHASE 6: COMPLETE AND PUBLISHED
PHASE 7 PLAN: REVIEWED AND ADJUDICATED
PHASE 7 IMPLEMENTATION: COMPLETE LOCALLY ON codex/phase7-implementation
PHASE 7 IMPLEMENTATION AUTHORIZED: YES — Codex decision recorded
PHASE 7 INDEPENDENT IMPLEMENTATION REVIEW: REQUIRED
PHASE 7 MERGE AUTHORIZED: NO
PHASE 8 STARTED: NO
```

**PHASE 7 IMPLEMENTATION AUTHORIZED — SCOPE LIMITED TO REVISION 10**
