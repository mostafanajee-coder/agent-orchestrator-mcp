import type { DoctorReport } from './commands/doctor.js';
import { runDoctor } from './commands/doctor.js';
import type { InitResult } from './commands/init.js';
import { runInit } from './commands/init.js';
import { createCommandContext } from './commands/context.js';
import { assertServeReady } from './commands/startup.js';
import { EXIT_INTERNAL, EXIT_OK, EXIT_SECURITY, exitCodeFor, SecurityError, UsageError } from './errors.js';
import { createEnvironmentTokenResolver } from './mcp/auth.js';
import { MCP_HTTP_DEFAULT_PORT, MCP_HTTP_HOST, startHttpServer } from './mcp/http.js';
import { startEnvironmentStdioServer } from './mcp/stdio.js';
import { readPackageVersion } from './version.js';

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

export interface ServeOptions {
  readonly mode: 'http' | 'stdio';
  readonly port?: number;
}

/** Command implementations, injected so the CLI can be tested without touching disk. */
export interface CliCommands {
  readonly init: () => InitResult;
  readonly doctor: () => DoctorReport;
  readonly serve?: (options: ServeOptions, io: CliIo) => void;
}

export const defaultCommands: CliCommands = {
  init: () => runInit(createCommandContext()),
  doctor: () => runDoctor(createCommandContext()),
  serve: (options, io) => {
    const version = readPackageVersion();
    if (options.mode === 'stdio') {
      startEnvironmentStdioServer({
        version,
        verifyStartup: () => assertServeReady(createCommandContext()),
        onerror: () => io.err(`${CLI_NAME}: MCP stdio transport error`),
      });
      return;
    }

    const httpOptions = {
      resolver: createEnvironmentTokenResolver(),
      version,
      verifyStartup: () => assertServeReady(createCommandContext()),
      logger: { error: () => io.err(`${CLI_NAME}: MCP HTTP protocol error`) },
      ...(options.port === undefined ? {} : { port: options.port }),
    };
    const server = startHttpServer(httpOptions);
    server.on('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      io.err(
        `${CLI_NAME}: MCP HTTP listening on ${MCP_HTTP_HOST}:${String(port ?? MCP_HTTP_DEFAULT_PORT)}`,
      );
    });
    server.on('error', () => {
      io.err(`${CLI_NAME}: MCP HTTP server error`);
      process.exitCode = EXIT_INTERNAL;
    });
  },
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
    '  init             Prepare the state root and initialize the Phase 3 schema',
    '  doctor           Report state and DB-file security. Read-only; repairs nothing',
    '  serve            Serve the Phase 2 MCP spine (--http or --stdio)',
    '',
    'Serve options:',
    `  --http           Streamable HTTP on ${MCP_HTTP_HOST} (default port ${String(MCP_HTTP_DEFAULT_PORT)})`,
    '  --stdio         MCP stdio transport; requires ORCHESTRATOR_ACTOR_TOKEN',
    '  --port PORT     Override the HTTP port (HTTP only)',
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
    '  Phase 3. SQLite schema/structural integrity with the Phase 2 MCP ping surface.',
    '  Doctor is filesystem-only; init and serve own deep SQLite integrity checks.',
    '  Production actor_tokens auth, jobs, workers, and authority arrive in later phases.',
    '  See docs/ARCHITECTURE.md for the approved design and phase plan.',
  ].join('\n');
}

function parseServeOptions(args: readonly string[]): ServeOptions {
  let mode: ServeOptions['mode'] | undefined;
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--http' || argument === '--stdio') {
      const selected = argument.slice(2) as ServeOptions['mode'];
      if (mode !== undefined) {
        throw new UsageError('choose exactly one of --http or --stdio');
      }
      mode = selected;
      continue;
    }

    if (argument === '--port') {
      const value = args[index + 1];
      if (value === undefined) throw new UsageError('--port requires a value');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new UsageError('--port must be an integer between 1 and 65535');
      }
      port = parsed;
      index += 1;
      continue;
    }

    throw new UsageError(`unexpected argument '${String(argument)}'`);
  }

  if (mode === undefined) throw new UsageError('serve requires exactly one of --http or --stdio');
  if (mode === 'stdio' && port !== undefined) {
    throw new UsageError('--port is only valid with --http');
  }
  return port === undefined ? { mode } : { mode, port };
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
  lines.push(
    'Database:        schema ready (version ' + String(result.database.schemaVersion) + ')',
  );
  lines.push('');
  lines.push(
    'init complete. State root, lease key, and Phase 3 schema are ready; production authority remains Phase 4.',
  );
  return lines;
}

function renderDoctor(report: DoctorReport): string[] {
  const lines = [
    `State root:      ${report.stateRoot}`,
    `Identity:        ${report.subject}`,
    `Security model:  ${report.securityModel}`,
    '',
  ];
  const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
  for (const check of report.checks) {
    lines.push(`${label[check.status]}  ${check.name}`);
    lines.push(`      ${check.detail}`);
  }
  lines.push('');

  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const warned = report.checks.filter((check) => check.status === 'warn').length;
  const warnSuffix = warned === 0 ? '' : `, ${String(warned)} warning${warned === 1 ? '' : 's'}`;

  lines.push(
    report.ok
      ? `doctor: PASS (${String(report.checks.length)} checks${warnSuffix})`
      : `doctor: FAIL (${String(failed)} of ${String(report.checks.length)} checks failed${warnSuffix}; nothing was repaired)`,
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

  if (first === 'serve') {
    try {
      if (commands.serve === undefined) {
        throw new UsageError('serve is not available in this command context');
      }
      commands.serve(parseServeOptions(argv.slice(1)), io);
      return { exitCode: EXIT_OK };
    } catch (error) {
      return reportError(io, error);
    }
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
