# AOM Phase 10B — Focused Independent Architecture/Security Re-Review Packet

Review status: the focused independent re-review has completed with `PASS` and
zero new blocking findings. This packet remains the bounded historical review
record; future reviewers must use a newly identified snapshot and a separately
authorized review request. The prior independent Opus review and re-review are
summarized in `docs/PHASE10B_REVIEW_ADJUDICATION.md`.

## 1. Review instruction

Review the four Phase 10B planning/adjudication documents in this exact
documentation-only snapshot:

1. `docs/PHASE10B_SCOPED_DELEGATION_PLAN.md`
2. `docs/PHASE10B_THREAT_MODEL.md`
3. `docs/PHASE10B_ALTERNATIVES.md`
4. `docs/PHASE10B_REVIEW_ADJUDICATION.md`

Cross-check the current AOM authority model in the baseline source and the
Phase 10A closure record only as needed to validate the claims. Do not modify
the repository, run implementation work, create migrations, change the live
Gateway/Funnel/Plugin, or authorize a public write.

## 2. Snapshot identity

- AOM baseline: `751e99c58e020b3f9de75a0757473369f9f26662`
- AOM baseline tree: `b7b66fb35ae311a0d6d14ae8723e0d3b6fb5d712`
- AOM planning branch: `codex/phase10b-scoped-delegation-plan`
- Gateway reference only: `4aa100ff078c6e18c7ebbf5b3621a4f077b4154f`
- Gateway tree reference: `98216c7b31f15c85c29db47de2c5c62ce0fbbbe1`

The adjudication commit SHA/tree is reported separately after the documents
are checked. The reviewer must treat the exact frozen commit supplied by the
orchestrator as authoritative and must flag any path outside the stated
documentation set.

## 3. Review question

Does the adjudicated C-first server-side opaque delegation model provide a
credible, internally consistent architecture for allowing future bounded
ChatGPT-controlled mutations without leaving an internet-facing Gateway with
unrestricted AOM principal authority?

In particular, verify that:

- AOM remains the issuer and final verifier;
- Gateway compromise is bounded by exact server-side caveats;
- request/resource/integration/audience/policy bindings are sufficient, and
  the documentation is honest that S3 does not prove individual OAuth-session
  identity;
- the restricted edge transport identity authenticates only a request-only
  issuer path and cannot mint or approve a delegation;
- finite per-integration/per-tier quotas, active-grant caps, short TTLs, and
  emergency disable prevent unbounded fresh authority under Gateway compromise;
- replay and TOCTOU handling is transactionally complete;
- integration-generation revocation, backup/restore epoch, clock rollback,
  and restart semantics fail closed;
- OAuth is not confused with AOM authority;
- worker/system/principal contexts remain separated;
- `codex_decide` is explicitly a future core-authority change representing an
  act of the sole `codex` principal, not a second authority mode;
- the schema/audit impact is honest and not implementation presented as fact;
- the first proposed write is genuinely lower risk;
- the final ChatGPT runtime-controller goal is preserved without a second
  authority principal;
- scope does not leak into Phase 11, remote workers, browser automation, or
  unrelated AOM redesign.

## 4. Required review output

Return:

- snapshot verification and any unverified claims;
- executive verdict: `READY`, `NEEDS CORRECTION`, or `BLOCKED`;
- finding-by-finding table with `BLOCKING`, `NON-BLOCKING`, or `REJECTED`;
- whether the root confused-deputy issue is correctly identified;
- whether Option C remains the correct canonical model and Option E remains
  optional;
- whether BLK-1 issuer authentication and issuance ceilings are concrete and
  enforceable;
- whether S3 integration binding and H-2 generation cascade are stated
  truthfully and sufficiently;
- whether the early observer read hardening and pre-write bearer milestones are
  correctly ordered;
- whether H-4's `decide.ts` core-authority change and principal-act semantics
  are safe and complete;
- any remaining missing caveat, binding, revocation, concurrency, audit, clock,
  restore, or authority invariant;
- any required documentation-only corrections;
- exact next governance gate;
- explicit statement that implementation is not authorized.

Do not silently fill unanswered questions with implementation assumptions. Do
not report an independent review as complete if the frozen documents were not
read.

## 5. Questions that require special scrutiny

1. Is the restricted edge transport identity sufficiently non-principal, and
   is `delegation:request` clearly separated from issuance/approval?
2. Can an attacker who controls the Gateway request too many or too broad
   delegations despite the named quotas, active caps, TTLs, and emergency stop?
3. Is the S3 integration-bound subject claim honest, with no unsupported
   per-ChatGPT-session security claim?
4. Is request canonicalization precise enough to prevent omitted/null/default,
   Unicode, number, array-order, and duplicate-key ambiguity?
5. Does a one-use delegation consume atomically with every relevant mutation?
6. Are replay and idempotency semantics distinct and unambiguous?
7. Can generation revocation, clock rollback, backup restore, or policy-version
   changes race with use?
8. Can any delegated context reach worker reporting, `codex_decide`, or system
   settlement accidentally?
9. Is retaining the full principal bearer anywhere in the Gateway compatible
   with the claimed security goal? If not, mark removal as a blocker before
   write exposure.
10. Does the proposed schema preserve append-only audit and single-principal
    invariants?

## 6. Governance boundary

This packet records independent scrutiny only. The favorable re-review returned
to Codex and was adjudicated. It does not authorize source implementation,
migration, write-tool exposure, Gateway changes, Funnel changes, Plugin
configuration, merge, push, or deployment.

## 7. Required closing statements

The reviewer should end with:

```text
PHASE 10B FOCUSED INDEPENDENT ARCHITECTURE RE-REVIEW: READY / NEEDS CORRECTION / BLOCKED
PHASE 10B IMPLEMENTATION AUTHORIZED: NO
WRITE/AUTHORITY IMPLEMENTATION AUTHORIZED: NO
```
