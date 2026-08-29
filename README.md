# Agent Orchestrator MCP

A local multi-agent orchestration control plane, exposed over MCP.

**Codex is the sole decision authority.** Every other agent — Gemini via `agy`, a deterministic
browser/CDP worker, future agents — is a worker that produces *evidence*. Only Codex may approve,
reject, or complete a job, and that is enforced by capability-based authorization and by database
triggers, not by prompt instructions.

## Status

**Phase 0 — scaffold.** The TypeScript project, test runner, linter, and a `--help` / `--version`
CLI exist. No orchestration functionality is implemented yet.

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

## CLI

```bash
node dist/index.js --help
```

```bash
node dist/index.js --version
```

## Layout

```
src/            CLI entry point and version reader
test/unit/      Unit tests, including a Phase 0 dependency-scope guard
docs/           Approved architecture
.github/        CI workflow (Windows + Linux)
```

Runtime state (database, artifacts, secrets, logs) will live outside this repository, under
`%LOCALAPPDATA%\AgentOrchestratorMCP\`. Nothing writes there yet.
