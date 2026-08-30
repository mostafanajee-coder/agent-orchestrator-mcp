# Agent Orchestrator MCP

A local multi-agent orchestration control plane, exposed over MCP.

**Codex is the sole decision authority.** Every other agent — Gemini via `agy`, a deterministic
browser/CDP worker, future agents — is a worker that produces *evidence*. Only Codex may approve,
reject, or complete a job, and that is enforced by capability-based authorization and by database
triggers, not by prompt instructions.

## Status

**Phase 1B — stable cross-process state root.** The CLI can prepare, protect, and inspect the global
state root, including the lease HMAC key. Nothing else is implemented: there is no MCP server,
transport, database, actor model, job state machine, or worker runtime yet.

The approved design and the full phase plan are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

Prepares the state root: creates each directory, applies owner-only protection, verifies it, and
creates the lease key once. It is idempotent — running it again preserves the existing key
unchanged. This is the Phase 1 portion of `init`; schema migrations and principal bootstrap arrive
in later phases.

```bash
node dist/index.js doctor
```

Reports on the state root, printing the resolved active root. **Read-only**: it never creates,
hardens, or repairs anything, and it never reads the lease key. It exits non-zero if anything is
insecure. Advisory warnings — such as a superseded state root still present on disk — are reported
without failing the run.

Exit codes: `0` success, `1` unexpected internal failure, `2` usage error, `3` security or
invariant failure.

## State root

Runtime state lives outside this repository, in one global root shared by every project:

```
<OS user profile>\.agent-orchestrator-mcp\     e.g. C:\Users\<user>\.agent-orchestrator-mcp
  data\        reserved for the database (later phase)
  artifacts\   per job / cycle / run
  secrets\     lease.key
  logs\
```

On POSIX the root is `$XDG_STATE_HOME/agent-orchestrator-mcp`, falling back to
`~/.local/state/agent-orchestrator-mcp`. There is deliberately **no override** — no flag,
environment variable, or config file can redirect the state root, so secrets cannot be steered to a
less protected location. `init` refuses a state root inside a known cloud-synchronised directory,
checking both the literal path and, once the root exists, its resolved real path.

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
src/config/     state-root resolution, cloud-sync detection
src/security/   ACL and permission providers, SDDL policy, safe process execution
src/secrets/    lease key lifecycle
src/commands/   init and doctor
test/unit/      unit tests, including a dependency-scope guard
docs/           approved architecture
.github/        CI workflow (Windows + Linux)
```
