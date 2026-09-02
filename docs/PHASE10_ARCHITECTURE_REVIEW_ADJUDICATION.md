# AOM — Phase 10 Architecture Review Adjudication

## 1. Purpose

This document records the Codex adjudication of the independent Phase 10
architecture review supplied for the planning snapshot. It is a governance
record only. It does not change source behavior and does not authorize Phase 10
implementation.

## 2. Reviewed snapshot

| Item | Verified value |
|---|---|
| Branch | `codex/phase10-authority-plan` |
| Reviewed planning commit | `592d419aff0779247f3c2f4a3d199a6b96a2001b` |
| Reviewed tree | `6e4dcb4a4b2e348190f3efe2ae26e91c495ea299` |
| Parent/base commit | `c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8` |
| Base tree | `f3759e83ef167f0076e02b033bd5e06f9e90f3ff` |
| `main` | `c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8` |
| `origin/main` | `c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8` |
| Working tree at adjudication start | clean |
| Changed paths from base | `README.md`, `docs/ARCHITECTURE.md`, `docs/PHASE10_PLAN.md` |

The base commit is a real 40-character Git commit object. Its exact value is
`c0f678defb5ba0177ef145e1d7f7b8ae82b84bd8`.

## 3. Finding-by-finding adjudication

| Finding | Codex classification | Decision and rationale |
|---|---|---|
| F-001 | CLOSED — no defect | The base tree value in the plan matches the verified parent tree exactly. |
| F-002 | REJECTED | The review report miscounted the base SHA and supplied an incorrect alternate spelling. The plan, README, and Architecture contain the correct full 40-character SHA, and Git verifies it as the parent, `main`, and `origin/main`. No documentation correction is required. |
| F-003 | CLOSED | The untracked `hermes_prompt_p10_arch.txt` was a reviewer scratch artifact, not a planning path. It was removed and is not part of the snapshot. |
| F-004 | CLOSED | Same scratch-file observation; the actual committed snapshot remains documentation-only. |
| F-005 | CLOSED | No unauthorized source, migration, tool, deployment, pull-request, or implementation activity is present in the reviewed diff. |
| F-006 | NON-BLOCKING / OPEN PRE-IMPLEMENTATION DECISION | The declarative task envelope is explicitly a planning candidate and must be reconciled with the verified external worker contract before implementation authorization. This is a required future decision, not an assumption that the candidate already works. |
| F-007 | NON-BLOCKING / OPEN PRE-IMPLEMENTATION DECISION | Bounds, grammar, and validation ownership are explicitly required by the plan before implementation authorization. They remain open until the external worker contract is evidenced. |
| F-008 | UNVERIFIED / BLOCKING BEFORE IMPLEMENTATION | The exact external worker identity, version, owner, and executable location are not established by the repository. |
| F-009 | UNVERIFIED / BLOCKING BEFORE IMPLEMENTATION | Native Worker Protocol V1 compatibility or the need for an external wrapper is not established. |
| F-010 | UNVERIFIED / BLOCKING BEFORE IMPLEMENTATION | Destination-policy ownership and enforcement are not established. |
| F-011 | CLOSED | The acceptance matrix contains exactly 48 unique IDs with the planned category counts. |
| F-012 | CLOSED | Phase 9 is accurately recorded as complete, merged, and published at the current repository state. |
| F-013 | CLOSED | Phase 10 is separated from Phase 9 with its own document and governance gate. |
| F-014 | UNVERIFIED / BLOCKING BEFORE IMPLEMENTATION | Exact deterministic fixture, browser binary pinning, platform support, and teardown behavior require evidence before implementation authorization. |

## 4. Codex decision

The independent report's final SHA correction request is rejected because the
report was based on a miscounted string; the repository already contains the
correct full SHA. The scratch file was removed. No architecture document needs
to be changed to address those findings.

The Phase 10 proposal is accepted as a bounded planning baseline for the next
governance stage. The browser-worker candidate remains justified by the
published architecture, but the external worker contract is intentionally not
assumed. Findings F-006 through F-010 and F-014 remain open evidence/decision
items before implementation authorization.

The task-envelope example is illustrative only. It is not an authorization to
implement that schema, add a protocol message, or add a new AOM tool.

## 5. Governance state

```text
PHASE 9: COMPLETE, MERGED, PUBLISHED, AND CLOSED
PHASE 10: PLANNING ONLY
PHASE 10 PLAN: ACCEPTED AS A BOUNDED PROPOSAL
PHASE 10 EXTERNAL WORKER CONTRACT: NOT YET VERIFIED
PHASE 10 IMPLEMENTATION: NOT STARTED
PHASE 10 IMPLEMENTATION AUTHORIZED: NO
PHASE 10 MERGE/PUSH/PR: NOT AUTHORIZED
PHASE 11: NOT STARTED
```

The next required work is documentation/evidence gathering for the exact
external browser worker, followed by a frozen planning snapshot and any
required independent re-review. No source implementation begins until Codex
records:

```text
AUTHORIZE PHASE 10 IMPLEMENTATION: YES
```

## 6. Phase 10A Tailscale Funnel + Edge Gateway adjudication

This entry records the current Codex decision for the Stage-0 ChatGPT
connectivity boundary. It is documentation-only and does not authorize source
implementation, Funnel activation, Gateway creation, OAuth infrastructure,
write exposure, worker dispatch, or authority exposure.

The Stage-0 architecture is approved for independent review:

```text
ChatGPT Plus --OAuth 2.1--> Tailscale Funnel
                              |
                              v
                    protocol-aware Edge Gateway
                              |
                    local authenticated AOM /mcp
```

The Gateway is default-deny and must enforce the public tool allowlist,
protocol parsing, batch safety, safe response projections, bounded admission,
and fixed loopback routing. It is not an authority or persistence layer.
Tailscale is transport only, and AOM remains loopback-only.

The confused-deputy finding is accepted. A valid token for the existing
`codex` principal receives the complete actor capability set; AOM has no
per-token scope, per-session scope, or trusted edge/interior distinction.
Accordingly, the full principal credential may be used only as temporary
Stage-0 read-only containment behind the Gateway. All writes, worker dispatch,
and `codex_decide` remain blocked. The final runtime goal remains ChatGPT as
the top-level controller, with future access requiring server-verified scoped
delegation.

The authentication finding is accepted with scope clarification: ChatGPT uses
OAuth 2.1 at the Gateway; the existing AOM bearer token remains local and is
used only on the interior connection. Static bearer/API-key authentication
from ChatGPT is not treated as viable.

The current public candidate surface is `ping`, `job_list`, `job_get`, and
`run_status`, each through a safe public projection. `audit_query`, all writes,
`qa_dispatch`, and `codex_decide` are excluded. Canonical MCP safety
annotations remain a future bounded AOM-surface item; annotations are hints,
not authorization controls.

The current repository state before this freeze contained reviewer scratch
material as an untracked file. Its contents were preserved outside the
repository and it is excluded from project history. The resulting freeze
commit contains only the five planning documents named by the Phase 10A
correction request. Runtime Funnel, Gateway, OAuth, and browser-worker work
remain unstarted.

```text
PHASE 10A STAGE-0 ARCHITECTURE: APPROVED
STAGE-0 IMPLEMENTATION AUTHORIZED: NO
WRITE/AUTHORITY IMPLEMENTATION AUTHORIZED: NO
```
