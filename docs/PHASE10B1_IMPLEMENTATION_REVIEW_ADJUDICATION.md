# AOM Phase 10B.1 — Implementation Review Adjudication

## Status

Phase 10B.1 implementation is accepted locally after the independent Opus
security review. This document records the adjudication only; it does not
authorize Phase 10B.2, delegated authority, public writes, Gateway changes, or
any authority change.

## Snapshot and independent review

- Repository: `C:\AgentProjects\agent-orchestrator-mcp`
- Branch: `codex/phase10b1-authz-foundations`
- Reviewed implementation commit: `b23e719a4eb7decd507aecf3ca8aed1689c87b5b`
- Reviewed tree: `e2db42e19741131de95b0cfa4cc2f369847c06d1`
- Parent: `e7228c7c8a9af168a02143c92370b3c8326f0bc1`
- Working tree at review: clean
- Independent review: `OPUS_P10B1_IMPL_REVIEW.md`

Opus reviewed the exact commit and diff, all ten changed files, the unchanged
authority/capability/schema paths, and the absence of Gateway changes. The
independent verdict was PASS with zero blockers and zero high-severity
findings.

## Core finding adjudication

The following independent findings are **ACCEPTED**:

- AuthorizationContext trust boundary is sound.
- Private marker plus WeakSet provenance is sound.
- Current flat context fields are sufficiently immutable.
- `effectivePrincipalId` is inert and is not an authority shortcut.
- Effective capabilities remain canonical, role-compatible, and frozen.
- `authMode=delegated` and unknown/missing modes fail closed.
- No principal fallback exists.
- Direct authorization semantics are preserved.
- Observer, worker, and system boundaries are preserved.
- `codex_decide` and its domain authority gate are unchanged.
- HTTP and stdio use the same shared context/policy path.
- Runtime validation does not rely on TypeScript types alone.

No accepted core finding requires a source-semantic correction.

## M-1 observer evidence/artifact read surface

**Disposition: DEFERRED WITH REQUIRED PRE-MILESTONE-B FIX.**

The existing AOM `observer` plus `job:read` policy also permits the pre-existing
`evidence_list` and `artifact_list` surfaces. The Stage-0 Gateway still exposes
only `ping`, `job_list`, `job_get`, and `run_status`. This is not a Phase 10B.1
regression, and no capability or tool behavior is changed here.

Before Milestone B or making the future edge identity the sole security
boundary, a separate decision must choose and implement a safe resolution:

- a narrower edge-safe read capability;
- an AOM-side per-tool restriction; or
- distinct safe public projections.

No option is implemented by this adjudication.

## Y-1 through Y-4

- **Y-1: ACCEPTED.** The production factory/path parity test now wires the
  artifact surface and asserts that an observer sees the existing read lists
  but cannot see `job_create`, `job_start`, `job_resume`, or
  `artifact_register` over either HTTP or stdio.
- **Y-2: ACCEPTED AS NORMATIVE.** `effectivePrincipalId` never authorizes by
  itself. `expiresAt` in this direct context is not delegated-grant expiry
  enforcement; future delegated use must validate expiry against the current
  AOM clock and durable record.
- **Y-3: ACCEPTED.** `context.ts` is the canonical module instance for the
  WeakSet provenance boundary. Duplicating the factory/verifier module would
  fail closed rather than create authority, but must not be introduced.
- **Y-4: ACCEPTED.** Direct contexts are request-scoped for HTTP and the
  existing startup identity for stdio. Continuous mid-request revocation is
  not added; future delegated mutations require transactional revalidation.

## npm clean-install disposition

The original `npm ci` attempt was blocked by a Windows lock on
`better-sqlite3` held by the live AOM process. Opus correctly classified this
as **NON-BLOCKING ENVIRONMENTAL**. A clean install is still required before the
remote checkpoint and should run in a fresh isolated checkout/worktree or
through a controlled runtime stop and restore. The source tree remains clean
after the dependency recovery, and the project quality gates pass separately.

## Live validation gate

Before the remote checkpoint, restart only the canonical AOM with the accepted
implementation and verify, without invoking writes:

- schema 7 and persistent integrity remain healthy;
- `chatgpt_edge_reader` remains an observer with `job:read`;
- Gateway local ping succeeds;
- the public four-tool surface is unchanged;
- no principal fallback occurs.

Gateway, Funnel, Tailscale, Plugin, and all write/worker/authority paths remain
untouched.

## Acceptance decision

Phase 10B.1 implementation is accepted for its authorized internal foundation.
The implementation is limited to direct-context normalization and policy
foundations; no delegation record, issuer, edge role, quota, epoch,
integration-generation, public write, or authority change was introduced.

Phase 10B.2 remains separately authorized only after its own planning,
schema/security review, and explicit implementation decision.

## Final state

- Independent implementation review: PASS acknowledged.
- Blocking findings: 0.
- High-severity findings: 0.
- M-1: deferred with required pre-Milestone-B fix.
- Gateway/source/runtime semantics: unchanged by this adjudication.
- Public write: not authorized.
- Phase 10B.2: not authorized.
