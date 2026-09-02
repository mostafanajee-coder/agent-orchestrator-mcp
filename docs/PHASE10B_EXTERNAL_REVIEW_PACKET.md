# AOM Phase 10B — Independent Architecture/Security Review Packet

Review status: ready for independent review. No independent review is claimed
to have occurred in this packet.

## 1. Review instruction

Review the three Phase 10B planning documents in this exact documentation-only
snapshot:

1. `docs/PHASE10B_SCOPED_DELEGATION_PLAN.md`
2. `docs/PHASE10B_THREAT_MODEL.md`
3. `docs/PHASE10B_ALTERNATIVES.md`

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

The final documentation-only commit SHA/tree is reported separately after the
documents are created and checked. The reviewer must treat the exact frozen
commit supplied by the orchestrator as authoritative and must flag any path
outside the stated documentation set.

## 3. Review question

Does the proposed C-first server-side opaque delegation model provide a
credible, internally consistent architecture for allowing future bounded
ChatGPT-controlled mutations without leaving an internet-facing Gateway with
unrestricted AOM principal authority?

In particular, verify that:

- AOM remains the issuer and final verifier;
- Gateway compromise is bounded by exact server-side caveats;
- request/resource/session/audience/policy bindings are sufficient;
- replay and TOCTOU handling is transactionally complete;
- revocation and restart semantics fail closed;
- OAuth is not confused with AOM authority;
- worker/system/principal contexts remain separated;
- `codex_decide` remains a distinct high-risk gate;
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
- whether Option C is the correct canonical model and whether Option E should
  remain optional;
- any missing caveat, binding, revocation, concurrency, audit, or authority
  invariant;
- whether `codex_decide` treatment is safe and complete;
- any required documentation-only corrections;
- exact next governance gate;
- explicit statement that implementation is not authorized.

Do not silently fill unanswered questions with implementation assumptions. Do
not report an independent review as complete if the frozen documents were not
read.

## 5. Questions that require special scrutiny

1. What authenticated AOM-local issuer path replaces the full principal bearer?
2. Can an attacker who controls the Gateway request too many or too broad
   delegations, and are issuance policy and rate limits specified sufficiently?
3. Is edge-session binding based on a verified stable subject rather than a
   self-declared label?
4. Is request canonicalization precise enough to prevent omitted/null/default,
   Unicode, number, array-order, and duplicate-key ambiguity?
5. Does a one-use delegation consume atomically with every relevant mutation?
6. Are replay and idempotency semantics distinct and unambiguous?
7. Can revocation race with use, restart, or policy-version changes?
8. Can any delegated context reach worker reporting, `codex_decide`, or system
   settlement accidentally?
9. Is retaining the full principal bearer anywhere in the Gateway compatible
   with the claimed security goal? If not, mark removal as a blocker before
   write exposure.
10. Does the proposed schema preserve append-only audit and single-principal
    invariants?

## 6. Governance boundary

This packet requests independent scrutiny only. A favorable review means the
documents may return to Codex for adjudication. It does not authorize source
implementation, migration, write-tool exposure, Gateway changes, Funnel
changes, Plugin configuration, merge, push, or deployment.

## 7. Required closing statements

The reviewer should end with:

```text
PHASE 10B INDEPENDENT ARCHITECTURE REVIEW: READY / NEEDS CORRECTION / BLOCKED
PHASE 10B IMPLEMENTATION AUTHORIZED: NO
WRITE/AUTHORITY IMPLEMENTATION AUTHORIZED: NO
```
