# AOM Phase 10B.3A-P Pre-Live Hardening Report

**Scope:** M1 post-commit persistence clarity and L1 real Windows rename
verification only

**Implementation branch:** `codex/phase10b3a-prelive-hardening`

**Implementation authorization:** limited to this pre-live hardening unit

**Live rollout:** not authorized

## 1. Baseline

The immutable Phase 10B.3A source checkpoint was:

- Commit: `10cdfe30ce9fa7b794d8dfde8c6f11ce3b442a75`
- Tree: `4ac54081bb473bcb4fa9210765fda10657a658c2`
- Tag: `phase10b3a-external-authority-state`
- Schema: `8`

The checkpoint tag was not modified or retargeted. The hardening branch was
created directly from that commit.

## 2. M1 correction

`src/authority/authorizationState.ts` now exposes a bounded
`AuthorizationStatePersistenceError` classification with:

- `pre-commit` for failures before target replacement;
- `post-commit` for failures after `renameSync(temp, target)` succeeds.

The implementation records the commit-point crossing in the persistence
routine. A post-rename failure can no longer be reported as definitely
pre-commit.

The post-commit operator message explicitly states:

```text
Authorization state replacement may have committed; the new state may already be effective.
Do not blindly retry. Inspect authority-state status before another mutation.
```

The authority commit point remains successful target replacement. No epoch,
clock, serializer, ownership, audit ordering, AuthorizationContext, principal,
observer, or Gateway semantics changed.

## 3. M1 tests

Focused failure-injection tests cover:

- pre-rename failure classified as `pre-commit`;
- successful rename followed by final validation failure classified as
  `post-commit`;
- POSIX directory durability failure after rename classified as
  `post-commit`;
- status-first and no-blind-retry guidance;
- no raw epoch or secret in the error message/remedy;
- the new target remains present after a simulated post-commit failure;
- existing injected `EPERM` replacement failure preserves the old target and
  remains fail-closed.

## 4. L1 real Windows test

Added:

`test/integration/phase10b3aWindows.test.ts`

The test runs on the current Windows host and uses the production
`writeAuthorizationState` path with the real `fs.renameSync` primitive. It
uses a fresh temporary local filesystem directory, not the production state
root.

The test creates an existing target, writes an old valid document, writes a
replacement in the same directory, performs real rename-over-existing, and
verifies:

- the target exists;
- the target contains the new document;
- the old content is no longer active;
- the temporary path is gone;
- the target was not unlinked first.

Result on this host:

```text
Windows real replace test: RUN / PASS
```

Environment:

- Windows 11 Pro `10.0.26200`, build `26200`;
- Node `v22.22.0`;
- npm `11.6.4`;
- `process.platform`: `win32`;
- filesystem: temporary local filesystem.

This verifies the supported Node 22/current Windows deployment environment;
it is not a universal claim about network or special filesystems.

## 5. L2 and L3

L2 was already closed before this branch: the seven skipped tests are the
pre-existing POSIX-only tests in `test/unit/aclPosix.test.ts` on Windows, and
none is Phase 10B.3A-critical.

L3 remains optional and was not implemented.

## 6. Quality gates

The clean disposable verification copy completed:

- `npm ci`: passed, 0 vulnerabilities;
- `npm run ci`: passed;
- `npm audit --omit=dev`: passed, 0 vulnerabilities.

Final disposable-copy CI result:

```text
Test Files: 67 passed (67)
Tests:      596 passed | 7 skipped (603)
```

The original workspace `npm ci` had previously returned Windows `EPERM` while
trying to unlink the live `better-sqlite3` native binary. No process was
killed and no live service was restarted; clean-install validation was done in
the disposable copy instead.

## 7. Scope review

The hardening change is limited to:

- `src/authority/authorizationState.ts`;
- `test/unit/authorizationState.test.ts`;
- `test/integration/phase10b3aWindows.test.ts`;
- this report.

No migration, schema, domain, MCP, capability, policy, principal, observer,
worker, `codex_decide`, Gateway, dependency, public-tool, or runtime service
change was made.

## 8. Live-state safety

The following remain untouched:

- `C:\Users\kingm\.agent-orchestrator-mcp\authorization-state.v1.json` was
  not created;
- live AOM was not restarted or stopped;
- live SQLite was not mutated;
- Gateway, Funnel, Tailscale, and ChatGPT Plugin were not changed;
- no actor token, DPAPI state, or credential was changed;
- no public write, worker dispatch, delegated authorization, or later phase
  was started.

The final hardening commit SHA and tree SHA are reported by the checkpoint
task after this report is committed. No change is made after that commit.

## 9. Final status

- M1: closed;
- L1: verified on the target Windows environment;
- Phase 10B.3A source checkpoint: unchanged and immutable;
- hardening branch: ready for independent pre-live hardening review;
- live authorization-state initialization: not authorized.
