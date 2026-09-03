# AOM Phase 10B.3A Implementation Report

**Unit:** External Authorization Epoch + Clock Rollback Guard

**Branch:** `codex/phase10b3a-external-authority-state`

**Implementation status:** completed locally; independent implementation review
required before live rollout

**Public write:** not enabled

**Delegated authorization:** not enabled

## 1. Baseline and governance

Implementation started from the approved Phase 10B.2 checkpoint:

- Commit: `22f856b444bb044abfb8ecb724a0396e80aadcca`
- Tree: `3a94c5b3c816a42fb272b60689e2c054fdae592c`
- Tag: `phase10b2-integration-generation-foundation`
- Schema: `8`
- `integrations`: zero rows
- `delegations`: absent
- Production integration mutation path: absent
- Production delegation creation path: absent

The final implementation commit and tree are emitted in the final task report
after this report is committed. No changes are made after that commit.

The current read boundary remains:

- Actor: `chatgpt_edge_reader`
- Role: `observer`
- Capability: `job:read`
- Public tools: `ping`, `job_list`, `job_get`, `run_status`

## 2. Implemented scope

The implementation contains only:

- strict external authorization-state v1 parsing;
- internally generated 256-bit opaque epochs;
- persisted wall-clock high-water evaluation;
- atomic external state persistence;
- existing state-root security reuse;
- canonical runtime ownership acquisition;
- in-process high-water serialization;
- local-only `authority-state init`, `status`, and `rotate` commands;
- the four-state readiness model;
- non-throwing runtime readiness wiring;
- bounded authorization-state audit events;
- doctor diagnostics;
- tests and this report.

No SQLite migration, schema change, quota, integration mutation, delegation,
issuer, verifier, consume path, edge identity, MCP administration tool, HTTP
administration route, public write, worker dispatch, Gateway change, capability
change, `codex_decide` change, or new dependency was added.

## 3. External state format and location

The canonical file name is:

`authorization-state.v1.json`

It is a sibling of `data` and `secrets` in the existing AOM state root.

Windows shape:

`<os.userInfo().homedir>\\.agent-orchestrator-mcp\\authorization-state.v1.json`

POSIX shape:

`$XDG_STATE_HOME/agent-orchestrator-mcp/authorization-state.v1.json`, with the
existing profile-derived fallback when XDG is not set.

The exact v1 document is:

```json
{
  "version": 1,
  "authorization_epoch": "<64 lowercase hex characters>",
  "clock_high_water_ms": 0
}
```

The zero above is only a format example. Explicit initialization stores the
current `Date.now()` value.

The file is outside:

- `data/`;
- `secrets/`;
- SQLite, WAL, and SHM files;
- Gateway state;
- the normal DB backup set;
- cloud-synchronised paths;
- Git.

The real production authorization-state file was not created or modified.
All tests used temporary state roots.

## 4. Strict parser

The parser accepts exactly three fields and performs no coercion. It rejects:

- malformed JSON;
- arrays or non-object values;
- missing fields;
- unexpected fields;
- unknown or future versions;
- noncanonical epoch encoding;
- wrong epoch length;
- negative, fractional, non-safe, or non-numeric high-water values;
- unsafe path objects and failed protection verification.

The parser applies a bounded maximum file size before reading the document.
Errors contain no raw epoch and no secret material.

## 5. Epoch implementation

Epoch generation uses:

`crypto.randomBytes(32)`

The result is encoded as 64 lowercase hexadecimal characters and is used only
for equality. The caller cannot supply an epoch, and no ordering is inferred.

The raw epoch is never returned by status, doctor, logs, or audit. A SHA-256
fingerprint is used where correlation is necessary. The epoch is not treated
as a secret and no HMAC/key-management layer was introduced.

## 6. Readiness implementation

The implementation exposes exactly these readiness states:

- `UNINITIALIZED`
- `READY`
- `INVALID`
- `CLOCK_ROLLBACK`

`READY` is a prerequisite diagnostic only. It does not grant authority, create
an identity, enable delegated mode, or alter `effectivePrincipal`.

There is no automatically detected `RECOVERY_REQUIRED` state. A simultaneous
restore of an old DB and its matching old state file remains an operational
limitation because the pair can be internally self-consistent.

## 7. Direct-read isolation

Runtime construction inspects authorization state through a non-throwing
boundary. Missing, malformed, unsafe, unreadable, or rollback state maps to a
disabled delegated-readiness result only.

It does not cause:

- AOM serve startup failure;
- observer authentication failure;
- Stage-0 direct-read failure;
- principal fallback;
- direct local principal denial.

The current observer identity and public read surface remain unchanged. A
healthy external state also does not activate delegated AuthorizationContext.

## 8. Clock and high-water implementation

The production clock is `Date.now()`, with an injectable clock for tests.

The fixed tolerance is 5,000 milliseconds:

```text
now = clock.now()
high = persisted clock_high_water_ms

if now < high - 5000:
    readiness = CLOCK_ROLLBACK
    delegated readiness = disabled
    high is not lowered
else:
    effective_now = max(now, high)

if now > high:
    persist now before future authority-sensitive work
```

The persisted ceiling, not the previous intermediate clock value, is used for
every comparison. This defeats cumulative sub-threshold rollback.

A large forward jump advances the ceiling. A later correction behind that
ceiling yields `CLOCK_ROLLBACK` and a recoverable delegated-authority
availability failure. No automatic lowering or reset occurs.

The five-second value is justified as a small benign-correction tolerance and
a bounded freeze band. The safety property comes from the persistent ceiling
and `max(now, high)`, not from claiming that tolerance directly extends a TTL.
Active malicious host-clock control remains outside the supported ACL threat
model.

## 9. Single-writer and ownership implementation

`src/runtime/ownership.ts` implements a real loopback ownership socket on the
canonical AOM endpoint (`127.0.0.1:4317`). It is not an application protocol
endpoint; unexpected connections are destroyed.

The ownership model is:

- the running server is the sole high-water writer;
- high-water updates are serialized in process;
- `authority-state init` acquires and holds ownership before reading or
  mutating state;
- `authority-state rotate` acquires and holds ownership before reading or
  mutating state;
- ownership remains held through generation, write, fsync, protection,
  validation, replacement, post-write verification, and audit completion;
- `authority-state status` is read-only and does not acquire mutation rights;
- a failed queued write does not poison later queued writes.

There is no PID file, persistent lockfile, `O_EXCL` lockfile, `fs-ext`,
`proper-lockfile`, or new native dependency.

For canonical HTTP serving, the real server bind owns the endpoint. The
production CLI uses an awaited bind path so an ownership conflict is observed
before the server is considered started. For production stdio serving and
noncanonical HTTP port overrides, the CLI holds the passive canonical ownership
socket for the runtime lifetime. An unsupported mode without a reliable
ownership proof remains fail-closed for admin mutation.

## 10. Local administration

The only new administration surface is local CLI handling:

```text
agent-orchestrator-mcp authority-state init
agent-orchestrator-mcp authority-state status
agent-orchestrator-mcp authority-state rotate --reason <reason>
```

The allowed reasons are exactly:

- `restore`
- `clock_recovery`
- `security_rotation`
- `manual`

`init` refuses to overwrite an existing state file. `rotate` generates the new
epoch internally and captures the current clock. Neither command accepts a
caller-supplied epoch.

`status` is DB-independent where practical and prints only safe metadata,
including readiness and a derived fingerprint. It never prints an epoch,
token, bearer, Owner secret, OAuth state, Gateway secret, or other secret.

The real production init/rotate commands were not run. No production state
file was created.

## 11. Atomic persistence and ACLs

The writer follows the existing project pattern:

1. Create a temporary file in the target directory.
2. Use exclusive creation with mode `0600`.
3. Write canonical JSON.
4. Flush the temporary descriptor with `fsyncSync`.
5. Apply and verify the existing owner-only security policy.
6. Validate the temporary document.
7. Replace with same-directory `renameSync`.
8. Never unlink the target first.
9. Validate the final document and protection.
10. Clean up only the temporary path after failure.

On POSIX, the containing directory is fsynced where supported. On Windows,
rename replacement failures such as `EPERM`/`EACCES` fail closed and do not
fall back to unlink-and-copy. Symlink and hardlink checks are defense in depth;
the existing path-safety and security helpers are reused.

The state replacement is the authority commit point. If the later audit write
fails, the new state remains authoritative and is not rolled back.

## 12. Audit

The bounded action vocabulary includes:

- `authorization.state_initialized`
- `authorization.epoch_rotated`
- `authorization.state_invalid`
- `authorization.clock_rollback`
- `authorization.clock_recovered`

State administration records a derived epoch fingerprint and fixed metadata
only. Readiness checks do not emit an event on every request. No raw epoch,
token, bearer, nonce, or secret is stored.

When a state mutation succeeds and audit fails, the command surfaces the audit
failure operationally but does not undo the safe state transition.

## 13. Restore and backup behavior

The unconditional operational rule is:

```text
After any database restore:
authority-state rotate --reason restore
```

This must occur before future delegated authority is considered ready. Normal
DB backup procedures exclude the external authorization-state file, and an old
state file is never automatically restored with an old DB.

The implementation makes no technical paired-restore detection claim. A future
non-restorable hardware/OS anchor would be a separate design.

## 14. M2-1 and quota boundaries

M2-1 remains deferred and unreachable because this unit does not mutate
integrations. Migration 008 remains immutable. M2-1 must be closed additively
before any production integration create/delete/mutation path.

All quota work remains deferred:

- no attempt quota;
- no active-delegation quota;
- no quota table or migration;
- no `active_count`.

## 15. Exact changed-file boundary

Production files changed:

- `src/authority/audit.ts`
- `src/authority/authorizationState.ts`
- `src/authority/runtime.ts`
- `src/cli.ts`
- `src/commands/authorityState.ts`
- `src/commands/doctor.ts`
- `src/config/stateRoot.ts`
- `src/index.ts`
- `src/mcp/http.ts` (shared canonical host/port constants only)
- `src/runtime/ownership.ts`

Tests changed or added:

- `test/integration/phase10b3aHttp.test.ts`
- `test/unit/authorityState.test.ts`
- `test/unit/authorityStateCli.test.ts`
- `test/unit/initDoctor.test.ts`
- `test/unit/runtimeOwnership.test.ts`
- `test/unit/stateRoot.test.ts`

Report:

- `docs/PHASE10B3A_IMPLEMENTATION_REPORT.md`

The following were not changed:

- `src/store/migrations/**`
- `src/store/schemaDefinitions.ts`
- `src/domain/**`
- MCP tool registration and tool behavior
- capability definitions
- `codex_decide` semantics
- Gateway repository
- package dependencies
- live SQLite data
- live authorization state

## 16. Test and quality results

Targeted tests passed:

- authorization state format and strict parser;
- epoch generation and fingerprint-only output;
- clock tolerance and cumulative rollback;
- forward-jump recovery behavior;
- atomic rename failure handling;
- audit failure after state commit;
- serializer recovery after a failed write;
- ownership acquire/release and mutual exclusion;
- local CLI parsing;
- direct HTTP ping with missing or corrupt state;
- state-root path derivation;
- doctor warning behavior.

Full suite in the working tree:

```text
Test Files: 66 passed (66)
Tests:      592 passed | 7 skipped (599)
```

Quality gates in the working tree passed:

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`

The direct workspace `npm ci` was not allowed to remove the locked native
`better-sqlite3` binary and returned Windows `EPERM`. No process was killed and
no live service was restarted. A disposable copy of the complete working tree
was used for clean-install verification:

- `npm ci`: passed, 0 vulnerabilities
- `npm run ci`: passed with the full results above
- `npm audit --omit=dev`: passed, 0 vulnerabilities

## 17. Live-state safety

This implementation task did not:

- create the real authorization-state file;
- run production `authority-state init`;
- run production `authority-state rotate`;
- restart AOM;
- restart Gateway;
- modify Funnel or Tailscale;
- modify the ChatGPT Plugin;
- mutate live SQLite;
- expose public write;
- enable delegated authorization;
- dispatch workers.

Live rollout remains a separate gate after independent implementation review.
