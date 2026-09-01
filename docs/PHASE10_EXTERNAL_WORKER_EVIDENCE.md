# AOM — Phase 10 External Worker Evidence Record

## 1. Purpose and boundary

This is a documentation-only evidence record for the Phase 10 planning gate.
It records what was and was not identifiable in the local environment. It does
not select an executable, change configuration, run a browser task, or
authorize implementation.

Evidence date: `2026-09-01`.

## 2. Repository inventory

The AOM repository contains the generic process runtime, Worker Protocol V1,
lease/evidence/artifact contracts, and the Phase 10 planning documents. It does
not contain an external browser-worker executable or a browser-worker source
tree that can be attributed to the AOM V1 NDJSON contract.

The repository's browser references are architecture design records only. They
do not prove that a compatible external worker is installed or that its current
invocation contract matches AOM.

## 3. Local executable inventory

The following observations were made with read-only commands:

| Item | Observation | AOM Worker V1 conclusion |
|---|---|---|
| Google Chrome | Installed at the standard Windows application path | Selected engine candidate; still not an AOM worker |
| Microsoft Edge | Installed at the standard Windows application path | Browser executable only; not an AOM worker |
| Playwright CLI | `C:\Python37\Scripts\playwright.exe`, version `1.35.0` | Test/browser runner; no evidence of AOM NDJSON worker behavior |
| `agy` | Available as `agy.exe` and separately deferred by architecture | Later model adapter; not the Phase 10 browser worker |
| Hermes | Used by Antigravity, but not available as a `hermes` command in this PowerShell session | General assistant/reviewer; not treated as an AOM worker without a verified contract |

A browser binary or a test runner is not interchangeable with an AOM worker.
The agreed planning policy is to use a dedicated, operator-owned Chrome
profile or a fresh temporary profile, never one of the operator's personal
profiles. No profile was created or opened. No executable was invoked beyond
the safe Playwright version probe. No cookie, credential, private destination,
or uncontrolled worker output was accessed.

## 4. Contract evidence status

The following required facts remain **UNVERIFIED**:

- exact external worker identity, release, owner, and installation location;
- exact argv, stdin, stdout, and exit-code behavior;
- native Worker Protocol V1 compatibility or the shape of an external wrapper;
- line, output, message, timeout, and stderr limit handling;
- deterministic local fixture behavior and cleanup;
- screenshot and structured-capture output behavior;
- evidence/assertion output and trust classification;
- destination/host allowlist ownership and rejection behavior;
- Windows and POSIX support matrix;
- proof that no credentials, cookies, arbitrary code, or irreversible actions
  are required.

The generic marker search in the separate Hermes source tree found unrelated
uses of terms such as `protocol_version`, `worker_id`, and `NDJSON`; those
matches are not an AOM Worker V1 contract and are not treated as proof.

## 5. Gate decision

WP2 (identify the exact worker) and WP3 (verify its contract) are not yet
satisfied. This is a deliberate pre-implementation blocker, not evidence of a
defect in the published AOM core.

```text
PHASE 10 PLAN: CODEX-ADJUDICATED BOUNDED PROPOSAL
EXTERNAL BROWSER WORKER: NOT IDENTIFIED
EXTERNAL WORKER CONTRACT: NOT VERIFIED
PHASE 10 IMPLEMENTATION: NOT STARTED
PHASE 10 IMPLEMENTATION AUTHORIZED: NO
PHASE 10 MERGE/PUSH/PR: NOT AUTHORIZED
PHASE 11: NOT STARTED
```

## 6. Required next evidence

To continue the Phase 10 gate, provide or identify one exact external worker
repository/executable and its safe version/invocation documentation. The next
read-only evidence package must establish the contract items in
[`docs/PHASE10_PLAN.md`](PHASE10_PLAN.md) §6 without including credentials,
cookies, private browser state, or raw uncontrolled transcripts.

Until that evidence exists, no `workers.json` entry, adapter, wrapper, browser
task implementation, migration, MCP tool, or Phase 10 source change may be
created.
