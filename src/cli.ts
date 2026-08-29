export const CLI_NAME = 'agent-orchestrator-mcp';

/** Sinks for CLI output, injected so tests never touch the real streams. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CliResult {
  readonly exitCode: number;
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export function renderHelp(version: string): string {
  return [
    `${CLI_NAME} ${version}`,
    '',
    'Local multi-agent orchestration control plane.',
    'Codex is the sole decision authority; every other agent is a worker that produces evidence.',
    '',
    'Usage:',
    `  ${CLI_NAME} [options]`,
    '',
    'Options:',
    '  -h, --help       Show this help and exit',
    '  -V, --version    Print the version and exit',
    '',
    'Status:',
    '  Phase 0 scaffold. No commands are implemented yet.',
    '  See docs/ARCHITECTURE.md for the approved design and phase plan.',
  ].join('\n');
}

function renderUsageError(flag: string): string {
  return [
    `${CLI_NAME}: unknown option '${flag}'`,
    `Run '${CLI_NAME} --help' to see the available options.`,
  ].join('\n');
}

/**
 * Runs the CLI against an argument vector.
 *
 * `argv` excludes the node executable and the script path, i.e. it is
 * `process.argv.slice(2)`.
 */
export function run(argv: readonly string[], io: CliIo, version: string): CliResult {
  const first = argv[0];

  if (first === undefined || first === '--help' || first === '-h') {
    io.out(renderHelp(version));
    return { exitCode: EXIT_OK };
  }

  if (first === '--version' || first === '-V') {
    io.out(version);
    return { exitCode: EXIT_OK };
  }

  io.err(renderUsageError(first));
  return { exitCode: EXIT_USAGE };
}
