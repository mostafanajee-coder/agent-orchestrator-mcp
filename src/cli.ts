import type { DoctorReport } from './commands/doctor.js';
import { runDoctor } from './commands/doctor.js';
import type { InitResult } from './commands/init.js';
import { runInit } from './commands/init.js';
import { createCommandContext } from './commands/context.js';
import { EXIT_OK, EXIT_SECURITY, exitCodeFor, SecurityError, UsageError } from './errors.js';

export const CLI_NAME = 'agent-orchestrator-mcp';
export { EXIT_OK, EXIT_INTERNAL, EXIT_SECURITY, EXIT_USAGE } from './errors.js';

/** Sinks for CLI output, injected so tests never touch the real streams. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CliResult {
  readonly exitCode: number;
}

/** Command implementations, injected so the CLI can be tested without touching disk. */
export interface CliCommands {
  readonly init: () => InitResult;
  readonly doctor: () => DoctorReport;
}

export const defaultCommands: CliCommands = {
  init: () => runInit(createCommandContext()),
  doctor: () => runDoctor(createCommandContext()),
};

export function renderHelp(version: string): string {
  return [
    `${CLI_NAME} ${version}`,
    '',
    'Local multi-agent orchestration control plane.',
    'Codex is the sole decision authority; every other agent is a worker that produces evidence.',
    '',
    'Usage:',
    `  ${CLI_NAME} <command> [options]`,
    '',
    'Commands:',
    '  init             Prepare and protect the state root (Phase 1 bootstrap)',
    '  doctor           Report on the state root. Read-only; repairs nothing',
    '',
    'Options:',
    '  -h, --help       Show this help and exit',
    '  -V, --version    Print the version and exit',
    '',
    'Exit codes:',
    '  0  success',
    '  1  unexpected internal failure',
    '  2  usage error',
    '  3  security or invariant failure',
    '',
    'Status:',
    '  Phase 1. init prepares the state root, its directories, and the lease key only.',
    '  Schema migrations and principal bootstrap arrive in later phases.',
    '  See docs/ARCHITECTURE.md for the approved design and phase plan.',
  ].join('\n');
}

function renderInit(result: InitResult): string[] {
  const lines = [
    `State root:      ${result.stateRoot}`,
    `Security model:  ${result.securityModel}`,
  ];
  lines.push(
    result.createdDirectories.length === 0
      ? 'Directories:     already present, protection re-applied and verified'
      : `Directories:     created ${String(result.createdDirectories.length)}`,
  );
  for (const directory of result.createdDirectories) {
    lines.push(`  + ${directory}`);
  }
  lines.push(
    result.leaseKeyCreated
      ? 'Lease key:       created'
      : 'Lease key:       already present, preserved unchanged',
  );
  lines.push('');
  lines.push('init complete. This is the Phase 1 bootstrap: state root, directories, and lease key.');
  return lines;
}

function renderDoctor(report: DoctorReport): string[] {
  const lines = [
    `State root:      ${report.stateRoot}`,
    `Identity:        ${report.subject}`,
    `Security model:  ${report.securityModel}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`${check.status === 'pass' ? 'PASS' : 'FAIL'}  ${check.name}`);
    lines.push(`      ${check.detail}`);
  }
  lines.push('');
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  lines.push(
    report.ok
      ? `doctor: PASS (${String(report.checks.length)} checks)`
      : `doctor: FAIL (${String(failed)} of ${String(report.checks.length)} checks failed; nothing was repaired)`,
  );
  return lines;
}

function reportError(io: CliIo, error: unknown): CliResult {
  if (error instanceof SecurityError) {
    io.err(`${CLI_NAME}: security check failed: ${error.message}`);
    if (error.remedy !== undefined) io.err(`  ${error.remedy}`);
  } else if (error instanceof UsageError) {
    io.err(`${CLI_NAME}: ${error.message}`);
    io.err(`Run '${CLI_NAME} --help' to see the available commands.`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`${CLI_NAME}: unexpected failure: ${message}`);
  }
  return { exitCode: exitCodeFor(error) };
}

/**
 * Runs the CLI against an argument vector.
 *
 * `argv` excludes the node executable and the script path, i.e. it is
 * `process.argv.slice(2)`.
 */
export function run(
  argv: readonly string[],
  io: CliIo,
  version: string,
  commands: CliCommands = defaultCommands,
): CliResult {
  const first = argv[0];

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    io.out(renderHelp(version));
    return { exitCode: EXIT_OK };
  }

  if (first === '--version' || first === '-V') {
    io.out(version);
    return { exitCode: EXIT_OK };
  }

  if (argv.length > 1) {
    return reportError(io, new UsageError(`unexpected argument '${String(argv[1])}'`));
  }

  try {
    if (first === 'init') {
      for (const line of renderInit(commands.init())) io.out(line);
      return { exitCode: EXIT_OK };
    }

    if (first === 'doctor') {
      const report = commands.doctor();
      for (const line of renderDoctor(report)) io.out(line);
      return { exitCode: report.ok ? EXIT_OK : EXIT_SECURITY };
    }
  } catch (error) {
    return reportError(io, error);
  }

  return reportError(
    io,
    new UsageError(
      first.startsWith('-') ? `unknown option '${first}'` : `unknown command '${first}'`,
    ),
  );
}
