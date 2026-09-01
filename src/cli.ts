import type { DoctorReport } from './commands/doctor.js';
import { runDoctor } from './commands/doctor.js';
import type { InitResult } from './commands/init.js';
import { runInit } from './commands/init.js';
import type { TokenCommandOptions, TokenCommandResult } from './commands/tokens.js';
import { runTokenCommand } from './commands/tokens.js';
import { createCommandContext } from './commands/context.js';
import { loadPhase5Config } from './config/phase5.js';
import { loadPhase6WorkerRegistry, validatePhase6WorkerActors } from './config/phase6.js';
import { EXIT_INTERNAL, EXIT_OK, EXIT_SECURITY, exitCodeFor, SecurityError, UsageError } from './errors.js';
import { readEnvironmentToken } from './mcp/auth.js';
import { openPhase4Runtime } from './authority/runtime.js';
import { MCP_HTTP_DEFAULT_PORT, MCP_HTTP_HOST, MCP_HTTP_PATH, startHttpServer } from './mcp/http.js';
import { startStdioServer } from './mcp/stdio.js';
import { readPackageVersion } from './version.js';
import { readLeaseKey } from './secrets/leaseKey.js';
import { ProcessRuntime } from './workers/processRuntime.js';
import type { Phase6WorkerToolOptions } from './mcp/tools/phase6.js';
import type { Phase7EvidenceArtifactToolOptions } from './mcp/tools/phase7.js';
import type { Phase4Runtime } from './authority/runtime.js';
import { cancelRunsForJob } from './domain/runs.js';

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

function createPhase6Runtime(
  commandContext: ReturnType<typeof createCommandContext>,
  runtime: Phase4Runtime,
  reportEndpoint?: string,
): { readonly options: Phase6WorkerToolOptions; readonly processRuntime: ProcessRuntime } {
  const registry = loadPhase6WorkerRegistry(commandContext);
  validatePhase6WorkerActors(runtime.db, registry);
  const leaseKey = readLeaseKey(commandContext.layout.leaseKey, commandContext.security);
  const processRuntime = new ProcessRuntime({
    db: runtime.db,
    audit: runtime.audit,
    registry,
    leaseKey,
    artifactsRoot: commandContext.layout.artifacts,
    ...(reportEndpoint === undefined ? {} : { reportEndpoint }),
  });
  return {
    options: { db: runtime.db, audit: runtime.audit, registry, leaseKey, artifactsRoot: commandContext.layout.artifacts, processRuntime },
    processRuntime,
  };
}

/** Command implementations, injected so the CLI can be tested without touching disk. */
export interface CliCommands {
  readonly init: () => InitResult;
  readonly doctor: () => DoctorReport;
  readonly token?: (options: TokenCommandOptions) => TokenCommandResult;
  readonly serve?: (options: ServeOptions, io: CliIo) => void;
}

export const defaultCommands: CliCommands = {
  init: () => runInit(createCommandContext()),
  doctor: () => runDoctor(createCommandContext()),
  token: (options) => runTokenCommand(createCommandContext(), options),
  serve: (options, io) => {
    const version = readPackageVersion();
    const commandContext = createCommandContext();
    const runtime = openPhase4Runtime(commandContext);
    if (options.mode === 'stdio') {
      try {
        const phase5Config = loadPhase5Config(commandContext);
        const phase6 = createPhase6Runtime(commandContext, runtime);
        const phase7: Phase7EvidenceArtifactToolOptions = {
          db: runtime.db,
          audit: runtime.audit,
          artifactsRoot: commandContext.layout.artifacts,
          leaseKey: phase6.options.leaseKey,
        };
          const authority = {
            db: runtime.db,
            audit: runtime.audit,
            phase7: { artifactsRoot: commandContext.layout.artifacts, platform: commandContext.platform },
          onJobCancelled: (jobId: string, requestId: string): void => {
            phase6.processRuntime.cancelJob(jobId);
            cancelRunsForJob(runtime.db, runtime.audit, jobId, requestId, phase6.options);
          },
        };
        const authInfo = runtime.resolver.verifyAccessTokenSync(readEnvironmentToken());
        const handle = startStdioServer({
          version,
          authInfo,
          authority,
          jobs: { ...runtime, ...phase5Config, platform: commandContext.platform },
          workers: phase6.options,
          artifacts: phase7,
          verifyStartup: () => undefined,
          onerror: () => io.err(`${CLI_NAME}: MCP stdio transport error`),
        });
        const close = handle.close.bind(handle);
        handle.close = async () => {
          try {
            phase6.processRuntime.close();
            await close();
          } finally {
            runtime.close();
          }
        };
      } catch (cause) {
        runtime.close();
        throw cause;
      }
      return;
    }

    const httpOptions = {
      resolver: runtime.resolver,
      version,
      authority: runtime,
      verifyStartup: () => undefined,
      logger: { error: () => io.err(`${CLI_NAME}: MCP HTTP protocol error`) },
    };
    let server: ReturnType<typeof startHttpServer>;
    try {
      const phase5Config = loadPhase5Config(commandContext);
      const reportEndpoint = options.port === undefined || options.port === 0
        ? undefined
        : `http://${MCP_HTTP_HOST}:${String(options.port)}${MCP_HTTP_PATH}`;
      const phase6 = createPhase6Runtime(commandContext, runtime, reportEndpoint);
      const phase7: Phase7EvidenceArtifactToolOptions = {
        db: runtime.db,
        audit: runtime.audit,
        artifactsRoot: commandContext.layout.artifacts,
        leaseKey: phase6.options.leaseKey,
      };
      const authority = {
        db: runtime.db,
        audit: runtime.audit,
        phase7: { artifactsRoot: commandContext.layout.artifacts, platform: commandContext.platform },
        onJobCancelled: (jobId: string, requestId: string): void => {
          phase6.processRuntime.cancelJob(jobId);
          cancelRunsForJob(runtime.db, runtime.audit, jobId, requestId, phase6.options);
        },
      };
      server = startHttpServer({
        ...httpOptions,
        authority,
        jobs: { ...runtime, ...phase5Config, platform: commandContext.platform },
        workers: phase6.options,
        artifacts: phase7,
        ...(options.port === undefined ? {} : { port: options.port }),
      });
      server.once('close', phase6.processRuntime.close.bind(phase6.processRuntime));
    } catch (cause) {
      runtime.close();
      throw cause;
    }
    server.once('close', runtime.close);
    server.on('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      io.err(
        `${CLI_NAME}: MCP HTTP listening on ${MCP_HTTP_HOST}:${String(port ?? MCP_HTTP_DEFAULT_PORT)}`,
      );
    });
    server.on('error', () => {
      runtime.close();
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
    '  init             Prepare state, initialize schema, and bootstrap Phase 4 authority',
    '  doctor           Report state and DB-file security. Read-only; repairs nothing',
    '  token            Issue, list, or revoke local persistent actor tokens',
    '  serve            Serve the Phase 5/6/7 MCP spine (--http or --stdio)',
    '',
    'Token options:',
    '  token issue --label LABEL [--expires-at UTC_TIMESTAMP]',
    '  token list',
    '  token revoke --token-id TOKEN_ID',
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
    '  Phase 7 implementation branch. Persistent auth, Codex authority, job lifecycle, worker runs, evidence, and artifacts.',
    '  Doctor is filesystem-only; init and serve own deep SQLite integrity checks.',
    '  Resilience, remote workers, and later phases remain out of scope.',
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

function parseTokenOptions(args: readonly string[]): TokenCommandOptions {
  const action = args[0];
  if (action === 'list') {
    if (args.length !== 1) throw new UsageError('token list does not accept options');
    return { action: 'list' };
  }

  if (action === 'issue') {
    let label: string | undefined;
    let expiresAt: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === '--label') {
        if (label !== undefined) throw new UsageError('--label may be specified only once');
        const value = args[index + 1];
        if (value === undefined) throw new UsageError('--label requires a value');
        label = value;
        index += 1;
        continue;
      }
      if (argument === '--expires-at') {
        if (expiresAt !== undefined) throw new UsageError('--expires-at may be specified only once');
        const value = args[index + 1];
        if (value === undefined) throw new UsageError('--expires-at requires a value');
        expiresAt = value;
        index += 1;
        continue;
      }
      throw new UsageError(`unexpected token issue argument '${String(argument)}'`);
    }
    if (label === undefined) throw new UsageError('token issue requires --label');
    return expiresAt === undefined ? { action: 'issue', label } : { action: 'issue', label, expiresAt };
  }

  if (action === 'revoke') {
    let tokenId: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument !== '--token-id') {
        throw new UsageError(`unexpected token revoke argument '${String(argument)}'`);
      }
      if (tokenId !== undefined) throw new UsageError('--token-id may be specified only once');
      const value = args[index + 1];
      if (value === undefined) throw new UsageError('--token-id requires a value');
      tokenId = value;
      index += 1;
    }
    if (tokenId === undefined) throw new UsageError('token revoke requires --token-id');
    return { action: 'revoke', tokenId };
  }

  throw new UsageError('token requires issue, list, or revoke');
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
  if (result.database.bootstrap?.initialToken !== undefined) {
    lines.push('Initial token:   ' + result.database.bootstrap.initialToken + ' (print once)');
  }
  lines.push('');
  lines.push(
    result.database.bootstrap?.bootstrapped === true
      ? 'init complete. Phase 4 production authority was bootstrapped; the initial token was printed once.'
      : 'init complete. State root, lease key, schema, and production authority are ready.',
  );
  return lines;
}

function renderTokenResult(result: TokenCommandResult): string[] {
  if (result.action === 'issue') {
    return [
      `Token ID:       ${result.tokenId ?? 'unknown'}`,
      `Label:          ${result.label ?? 'unknown'}`,
      `Expires at:     ${result.expiresAt ?? 'never'}`,
      `Token:          ${result.plaintext ?? '[unavailable]'} (print once; not stored)`,
    ];
  }
  if (result.action === 'revoke') {
    return [
      result.revoked === true
        ? `Token revoked:  ${result.tokenId ?? 'unknown'}`
        : `Token already revoked: ${result.tokenId ?? 'unknown'}`,
    ];
  }
  const tokens = result.tokens ?? [];
  if (tokens.length === 0) return ['No actor tokens.'];
  return tokens.map((token) => JSON.stringify(token));
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

  if (first === 'token') {
    try {
      if (commands.token === undefined) {
        throw new UsageError('token is not available in this command context');
      }
      for (const line of renderTokenResult(commands.token(parseTokenOptions(argv.slice(1))))) {
        io.out(line);
      }
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
