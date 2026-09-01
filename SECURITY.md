# Agent Orchestrator MCP Security Guide

This document describes the security and trust boundaries of the local Agent
Orchestrator MCP V1. It is normative guidance for this repository. It does not
contain credentials, secret material, exploit procedures, or deployment
instructions.

## 1. Security objective

The system separates doing work from deciding whether that work is acceptable.
Codex is the sole authority for authoritative job outcomes. Workers produce
bounded advisory evidence and runtime reports; they cannot approve, reject,
complete, deliver, or cancel a job authoritatively.

The primary security property is enforced in layers:

1. authenticated actor identity;
2. role and capability checks;
3. tool visibility and handler checks;
4. a single domain decision choke point; and
5. SQLite integrity and authority triggers.

## 2. Authority and actor model

The production database contains one enabled `codex` principal and one enabled
internal `system` actor. The `system` actor has no public capabilities and no
transport token.

The principal may create and inspect jobs, request worker runs, add principal
evidence, register principal artifacts, and make authoritative decisions.
Workers may perform only their bounded run/report/evidence/artifact duties.
Observers, where an existing read policy permits them, are read-only. Recovery
and reaper code is mechanical and cannot create a decision row or an
authoritative job status.

`codex_decide` is the only authoritative decision path. A worker verdict,
evidence record, artifact, timeout, crash, orphan, reaper action, or shutdown
never becomes an authoritative outcome by itself.

## 3. Local transport boundary

The supported MCP transports are local loopback HTTP and local stdio. HTTP is
bound to the approved loopback address and validates Host and Origin. Bearer
authentication is required before an authenticated request reaches the MCP
surface. Stdio authenticates its configured persistent actor token before
serving protocol traffic.

Remote networking, TLS termination, OAuth authorization servers, cloud workers,
browser workers, and multi-machine recovery are outside this V1 boundary.

## 4. Token and session protection

Persistent actor tokens are stored only as SHA-256 digests in the protected
SQLite database. Plaintext token values are printed only at the approved
one-time issuance boundary and are never returned by an MCP tool.

`token_id` and its label are bounded attribution identifiers, not bearer
credentials. The bearer value and token digest are secrets/sensitive
credential derivatives and must not appear in logs, audit details, errors, or
reports.

Multiple sessions may use separate tokens that resolve to the same `codex`
principal. The verified `session_token_id` identifies the token row used for
authentication. A client-supplied `session_hint` is decoration only and cannot
change identity, capability, or authority.

Disabled, expired, malformed, system-linked, or unknown tokens fail closed.

## 5. Lease protection

Worker leases are opaque, run-scoped credentials signed by the server's lease
key. A lease binds the worker actor, job, cycle, run, expiry, and nonce. Lease
material is delivered only through its approved private worker path.

A lease is unusable when it is expired, consumed, mismatched, or attached to a
terminal run. A late report cannot revive a run or recreate a lease. Lease
material, MACs, nonces, and the lease key must never cross generic MCP errors,
logs, audit details, or user-facing reports.

## 6. State-root and database protection

The state root is resolved from the trusted operating-system user profile and
is protected with the platform's approved security provider. Windows uses an
owner-only verified DACL model. POSIX uses protected directory and file modes.
Security checks fail closed; normal diagnosis does not silently repair state.

SQLite is the durable system of record. WAL, migration, canonical-schema,
trigger, actor-state, and audit-chain checks run before serving. Durable jobs,
decisions, evidence, artifacts, and audit rows are not casually deleted or
replaced. The current published V1 schema is version 7.

## 7. Workspace and artifact boundaries

Jobs are admitted only inside the configured non-root workspace allowlist.
Worker executables and working directories come from validated server-owned
configuration and are not supplied as arbitrary command lines by a job caller.

Artifact paths are relative, server-selected, bounded, and checked against the
approved artifact root. Traversal, absolute/device paths, symlinks/reparse
points, alternate data streams, reserved names, and out-of-root files are
refused. Artifact metadata is append-only; artifact bytes are not exposed as a
generic MCP resource in the current V1 surface.

## 8. Worker process and protocol boundaries

Workers run through the bounded local process adapter. The orchestrator owns
argv construction, working directory, environment allowlisting, stream limits,
timeouts, cancellation, process-tree termination, and result normalization.

The worker protocol is version 1 UTF-8 NDJSON. Messages are bounded by the
documented line, total-output, message-count, stderr, and runtime limits.
Unknown, malformed, oversized, truncated, duplicated, or out-of-order
messages cannot produce a successful result. Worker output remains untrusted
and advisory.

Remote, cloud, browser, and external worker transports are not supported by
this security boundary.

## 9. Phase 8 recovery and shutdown

Startup recovery marks active runs from an unavailable previous process as
`ORPHANED`; if an authoritative cancellation already exists, it mechanically
settles the run as `CANCELLED`. The reaper can reconcile timeout, expiry,
staleness, and lost ownership. Ambiguous active work moves to the durable,
non-authoritative `STALLED` state.

Recovery and the reaper may stop, orphan, timeout, cancel mechanically, or stall
runtime work. They may not author a decision or write an authoritative status.

Graceful shutdown stops new dispatches, requests bounded worker termination,
retains a valid result completed during the drain, and conservatively
reconciles unresolved runtime work. Service shutdown is not an authoritative
Codex cancellation. Only the explicit Codex decision path creates
`JOB_CANCELLED`.

## 10. Audit and tamper evidence

The append-only `audit_log` records actor, verified session token ID, request,
action, job/cycle, state changes, result, and bounded redacted detail. Entries
are hash-chained by sequence.

The ledger is tamper-evident within its model and detects sequence, linkage, or
hash inconsistencies during startup and bounded range checks. It is not a
cryptographic guarantee against an actor with unrestricted storage access who
can rewrite both the data and all verification material. The system never
repairs a broken chain automatically.

`audit_query` is a bounded, read-only, principal-only inspection operation.
Workers and the system actor have no transport access to it. It exposes safe
metadata with bounded opaque pagination and redaction; it does not export raw
streams, credentials, lease material, or unrestricted detail.

## 11. Rate-limit boundary

The Phase 9 proposal places a fixed in-memory request limiter after successful
authentication and before tool/domain execution. Its proposed V1 policy is 30
credits per verified `token_id`, refilled at one credit per second, with one
credit per authenticated MCP request. `tools/list` and `ping` count as normal
requests. Restart resets the limiter.

Rate limiting is transport admission control, not an authority or persistence
mechanism. A rejection cannot consume an idempotency key, open a decision
transaction, mutate a job/run/lease/evidence/artifact row, or create an audit
decision. Unknown credentials remain under the existing authentication and
loopback protections; no pre-auth global limiter is assumed.

The values and exact shared HTTP/stdio hook require independent Phase 9 review
before implementation authorization.

## 12. Data classification and redaction

The following distinctions are mandatory:

- bearer tokens, Authorization values, lease keys, complete leases, MACs,
  nonces, and token digests are secret or sensitive and must not be exposed;
- token IDs, request IDs, job IDs, run IDs, decision IDs, and safe session
  labels are identifiers and may remain where attribution requires them;
- worker stderr and textual output are untrusted, bounded, and redacted before
  retention or exposure;
- MCP errors contain stable safe categories and bounded messages, never stacks,
  SQL, credentials, or generic internal absolute paths;
- authorized job workspace metadata remains available in its established
  success contract, while generic errors do not disclose protected state paths;
- evidence and artifact metadata retain their existing trust and size limits.

Redaction is required at audit, stderr, protocol diagnostics, evidence,
success-response, error-response, startup, shutdown, recovery, HTTP-auth, and
stdio-auth sinks. Redaction must not destroy verified session attribution by
confusing an identifier with its credential.

## 13. Dependency and verification policy

Changes must preserve the pinned dependency policy and pass typecheck, lint,
tests, build, and dependency audit on supported Windows and POSIX CI. New
network, remote-worker, dynamic-loading, or deployment dependencies require a
separate architecture decision.

## 14. Security non-goals and change control

This repository does not provide a remote authorization service, a hostile-host
sandbox, a cloud secret manager, a distributed consensus system, a telemetry
platform, or a backup/restore service. Local same-user compromise, unrestricted
filesystem administrators, and compromised operating systems are outside the
guarantees of this V1 model.

Any change to authority, capabilities, schema, migrations, worker protocol,
transport exposure, lease semantics, recovery ownership, or data-classification
rules requires an architecture review and an explicit Codex authorization
before implementation.
