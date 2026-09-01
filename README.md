# Agent Orchestrator MCP

A local multi-agent orchestration control plane, exposed over MCP.

**Codex is the sole decision authority.** Every other agent — Gemini via `agy`, a deterministic
browser/CDP worker, future agents — is a worker that produces *evidence*. Only Codex may approve,
reject, or complete a job, and that is enforced by capability-based authorization and by database
triggers, not by prompt instructions.

## Status

**Phase 4 — Authority and authentication activation (merged into `main`).** PR #7 merged the implementation
at `ea07fbcae4264fb91601ba03b1bbc84c57e8b7a5`; the CLI prepares
and protects the global state root, initializes the approved schema-v6 local SQLite store, bootstraps the
`codex` principal and internal `system` actor, and prints the first bearer token exactly once. Serve uses the
database-backed `actor_tokens` resolver and exposes the compatibility `ping` tool plus `codex_decide` only
to a verified `codex` principal holding `job:decide`. Doctor remains filesystem/security-only and explicitly
reports `DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`; init and serve startup own deep SQLite integrity,
canonical schema, audit-chain, actor-state, and token checks.

**Phase 5 — Job lifecycle (merged and published in `main`).** The independently reviewed implementation was
merged at `7d7c3f61a118c26d4da0347f6c3ceb9ec286d0ea` from reviewed head
`4ba475005a0f6d0b9504e7dc82d71d88f23a27e8`, followed by the documentation closure commit
`530e2441636e6517096b1319c4510b1e56626592`. It provides durable `job_create`, `job_start`, `job_resume`,
`job_get`, and `job_list` behavior with workspace admission, bounded pagination, idempotency, CAS, and the
existing Codex authority boundary. Worker execution, leases, evidence/artifacts, resilience loops, and all
Phase 6+ behavior remain outside the Phase 5 implementation.

**Phase 6 — Worker runtime (merged and published in `main`).** The scoped worker registry, bounded process
protocol, run/lease lifecycle, `qa_dispatch`, `run_report`, and `run_status` surface are published at
`88670743f8a443bbf3b71c9f379199deca42d512`. The post-merge closure is recorded in
[`docs/PHASE6_POST_MERGE_CLOSURE.md`](docs/PHASE6_POST_MERGE_CLOSURE.md). Evidence/artifact handling,
recovery loops, remote workers, and all Phase 7+ behavior remain out of scope for Phase 6.

**Phase 7 — Evidence and artifacts (implemented locally on a separate branch).** The implementation
branch is `codex/phase7-implementation`, based on the published Phase 6 `main` at
`88670743f8a443bbf3b71c9f379199deca42d512`. [`docs/PHASE7_PLAN.md`](docs/PHASE7_PLAN.md) records Revision 10,
and [`docs/PHASE7_IMPLEMENTATION_REPORT.md`](docs/PHASE7_IMPLEMENTATION_REPORT.md) records the handoff.
The implementation is not merged or published; independent implementation review is required and Phase 8 has
not started.

The approved design and phase plans are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PHASE4_PLAN.md](docs/PHASE4_PLAN.md), and
[docs/PHASE5_PLAN.md](docs/PHASE5_PLAN.md), [docs/PHASE6_PLAN.md](docs/PHASE6_PLAN.md), and
[docs/WORKER_PROTOCOL.md](docs/WORKER_PROTOCOL.md), [docs/PHASE6_POST_MERGE_CLOSURE.md](docs/PHASE6_POST_MERGE_CLOSURE.md),
and [docs/PHASE7_PLAN.md](docs/PHASE7_PLAN.md).
The empirical Codex/Inspector protocol observation is recorded in
[docs/PHASE2_PROTOCOL.md](docs/PHASE2_PROTOCOL.md).

## Requirements

- Node.js >= 22

## Getting started

```bash
npm install
```

```bash
npm run ci
```

`npm run ci` runs the full gate: typecheck, lint, tests, build.

## CLI

```bash
node dist/index.js init
```

Prepares the state root, creates the database only on the explicit init path, applies owner-only
protection, verifies it, applies the exact numbered migration set `[1, 2, 3, 4, 5, 6]`, and runs the deep
structural/canonical integrity gate. A fresh database atomically creates the `codex` principal, internal
`system` actor, and digest-only initial token; the plaintext token is printed once after commit. Re-running
init preserves the lease key and does not print another token. Existing ambiguous authority state fails
closed and is never auto-repaired.

Local token administration is explicit and operator-only:

```bash
node dist/index.js token issue --label operator-session
node dist/index.js token list
node dist/index.js token revoke --token-id <token_id>
```

`token list` returns metadata only. Revocation is one-way; expiry and revoked rows remain retained for
attribution and audit history.

```bash
node dist/index.js doctor
```

Reports the resolved root, DB file, and WAL/SHM filesystem-security state. **Read-only**:
it never invokes SQLite for the authoritative DB, creates, hardens, repairs, migrates, checkpoints,
or reads lease-key contents. When filesystem checks pass it reports
`DB_FILE_SECURITY=PASS` and
`DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN`; SQL integrity is not claimed. It exits non-zero
for unsafe filesystem/security state. Advisory warnings — such as a superseded state root still
present on disk — are reported without failing the run.

```bash
ORCHESTRATOR_ACTOR_TOKEN="<operator-supplied-token>" node dist/index.js serve --stdio
```

Starts the official MCP stdio transport. The supplied bearer is hashed and matched against the persistent
database token row before protocol output; environment actor IDs, labels, token IDs, and scopes cannot
override database identity. Operational errors go to stderr and stdout remains reserved for MCP protocol
traffic.

```bash
ORCHESTRATOR_ACTOR_TOKEN="<operator-supplied-token>" node dist/index.js serve --http --port 4317
```

Starts Streamable HTTP on `127.0.0.1` only. Every MCP request requires a persistent database bearer token
with the fixed `mcp` transport marker; application capabilities come from the verified actor row. Host and
Origin are restricted to localhost-class values. `--port` is optional and defaults to `4317`.

Before either transport starts, `serve` performs the filesystem/security checks and then opens only
an existing authoritative DB for the approved deep migration/schema/integrity gate, then verifies the
exact enabled principal/system state, persistent token rows, and audit chain. It refuses to start before
HTTP bind or stdio protocol output when the state root, DB/sidecars, migrations, PRAGMA policy, schema,
authority state, audit chain, or integrity checks are invalid. It never runs `init`, creates a missing DB,
repairs permissions, or reads lease-key contents automatically.

Writable AOM connections enable and verify `recursive_triggers=ON` as defense in depth. The
schema itself rejects `INSERT OR REPLACE` and `REPLACE` against existing job, decision, and audit
identities even when an external connection explicitly disables that pragma.

Exit codes: `0` success, `1` unexpected internal failure, `2` usage error, `3` security or
invariant failure.

## State root

Runtime state lives outside this repository, in one global root shared by every project:

```
<OS user profile>\.agent-orchestrator-mcp\     e.g. C:\Users\<user>\.agent-orchestrator-mcp
  config.json  protected Phase 5 runtime settings (workspace roots and bounded defaults)
  workers.json protected Phase 6 worker registry (disabled starter entry until configured)
  data\        orchestrator.db, WAL/SHM sidecars when SQLite owns them
  artifacts\   per job / cycle / run
  secrets\     lease.key
  logs\
```

`init` creates the protected `config.json` with the approved Windows workspace-root seeds and
bounded lifecycle defaults, plus a disabled starter `workers.json` registry. Before exposing the
Phase 6 MCP surface, `serve` reads and validates both protected configuration files;
operators may add local workspace roots there without changing source code. On POSIX, no workspace
roots are seeded by default; a local root must be configured explicitly before `job_create` can admit a job.

On POSIX the root is `$XDG_STATE_HOME/agent-orchestrator-mcp`, falling back to
`~/.local/state/agent-orchestrator-mcp`. There is deliberately **no override** — no flag,
environment variable, or config file can redirect the state root, so secrets cannot be steered to a
less protected location. `init` refuses a state root inside a known cloud-synchronised directory,
checking both the literal path and, once the root exists, its resolved real path.
The check covers `root`, `secrets`, `data`, `artifacts`, `logs`, and `secrets\lease.key`; it rejects
both protected paths inside a sync root and sync roots nested inside protected state.

**The profile directory comes from OS identity, not from `%USERPROFILE%`.** The location normally
corresponds to that variable, but it is not trusted to determine it: `os.userInfo().homedir` is
used, never `os.homedir()`, which Node documents as consulting USERPROFILE first. Measured here,
`USERPROFILE=D:\attacker-profile` moved `os.homedir()` but not the state root. UNC and
device-namespace profiles are rejected — V1 is a local orchestrator.

**Why not `%LOCALAPPDATA%`?** A packaged (MSIX) process has LocalAppData virtualized into
`...\Packages\<id>\LocalCache\Local`. Measured on Windows 11, a state root created there by a
packaged process was reported as *absent* by an unpackaged process on the same machine — two
clients, two physical stores, breaking the invariant that there is exactly one orchestrator state
store per user. The user-profile root is still user-scoped but sits outside that boundary, and was
measured to resolve identically from both contexts. A state root left behind at the old location is
reported by `doctor` as a warning; it is never read, migrated, or deleted.

## Security model

Every directory in the state root, and the lease key itself, is protected identically:

- **Windows** — a DACL with inheritance removed and exactly one allow entry, for the current user's
  SID. `BUILTIN\Users`, `Everyone`, `Authenticated Users`, `INTERACTIVE`, `SYSTEM`, and
  `Administrators` are all absent by design. Applied with `icacls` using an argument vector and the
  `*<SID>` principal form; never a shell string, never a localized account name.
- **POSIX** — directories `0700`, secret files `0600`, owned by the current user. Note that
  `chmod` is a no-op for access control on Windows and is *not* the Windows mechanism.

Protection is **verified after it is applied**, and again on every `doctor` run. Verification reads
the security descriptor as SDDL, which reports identities as SIDs, so it does not depend on the
Windows display language. If protection cannot be proven, the command fails closed rather than
continuing.

Verification requires the descriptor to match the exact canonical shape hardening produces —
owned by the current user, protected, and carrying **exactly one** full-access allow entry for the
current user with the inheritance flags appropriate to a directory or a file. Deny entries,
callback or unknown entry types, extra entries, reduced rights, unexpected inheritance flags, and
anything the parser cannot fully model are all rejected. No attempt is made to compute Windows
effective permissions; the policy is deliberately narrower than that.

`icacls.exe` and `powershell.exe` are resolved only at their absolute locations under `SystemRoot`
and are proven to be regular files before use. There is **no PATH fallback** — if a trusted tool
cannot be located, the command fails closed.

Every protected path is checked for redirection before it is hardened or inspected: symbolic
links, NTFS junctions, wrong object types, and hard-linked secrets are refused, so protection is
never applied through a link to a target elsewhere. This applies to **every** path including the
state root — there is no package-specific bypass, because the root now lives outside the
LocalAppData virtualization boundary.

The same policy is applied uniformly to `data\`, `artifacts\`, and `logs\` as to `secrets\`, so the
future database is never created inside a broadly accessible directory and no path is left weaker
than another.

Ordering is load-bearing: `secrets\` is created, hardened, and verified **before** the lease key is
written into it, and an existing key has its protection verified **before** anything opens it. An
unsafe key is refused, never read and never repaired in place.

The lease key is **exactly** 32 random bytes (256-bit, for HMAC-SHA256) — not a minimum; a file of
any other size is malformed and refused. It is written with a loop that honours short writes and
its final size is confirmed before it is trusted; any failure removes the partial file. It is never
printed, logged, or included in any error message or report — `doctor` reports only its size and
protection status.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run typecheck` | Type-check `src/` and `test/` without emitting |
| `npm run lint` | ESLint over the repository |
| `npm run lint:fix` | ESLint with autofix |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run the test suite in watch mode |
| `npm run ci` | typecheck → lint → test → build |
| `npm run clean` | Remove `dist/` |

## Layout

```
src/config/     state-root resolution, cloud-sync detection, Phase 5/6 configuration
src/security/   ACL and permission providers, SDDL policy, safe process execution
src/secrets/    lease key lifecycle
src/store/      secure DB modes, migrations, schema, integrity, repositories
src/authority/  Phase 4 bootstrap, capabilities, audit, runtime, and decisions
src/domain/     job and Phase 6 run lifecycle domains
src/workers/    bounded protocol, leases, and local process runtime
src/commands/   init, doctor, and local token administration
src/mcp/        shared MCP factory, Phase 4/5/6 tools, auth, HTTP, and stdio entry points
test/unit/      unit tests
test/store/     migrations, schema, raw-SQL authority, doctor, startup gates
test/integration/ real loopback HTTP and stdio transport acceptance tests
docs/           approved architecture
.github/        CI workflow (Windows + Linux)
```
