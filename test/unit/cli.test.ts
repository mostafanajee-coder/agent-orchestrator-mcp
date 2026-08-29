import { describe, expect, it } from 'vitest';

import type { CliCommands, CliIo } from '../../src/cli.js';
import {
  CLI_NAME,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_SECURITY,
  EXIT_USAGE,
  renderHelp,
  run,
} from '../../src/cli.js';
import type { DoctorReport } from '../../src/commands/doctor.js';
import type { InitResult } from '../../src/commands/init.js';
import { SecurityError } from '../../src/errors.js';

const VERSION = '1.2.3';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    out,
    err,
  };
}

const initResult: InitResult = {
  stateRoot: '/state',
  createdDirectories: ['/state', '/state/secrets'],
  leaseKeyCreated: true,
  securityModel: 'fake model',
};

function doctorReport(ok: boolean): DoctorReport {
  return {
    stateRoot: '/state',
    securityModel: 'fake model',
    subject: 'test-subject',
    checks: [
      { name: 'cloud-sync safety', status: 'pass', detail: 'not synchronised' },
      {
        name: 'directory /state/secrets',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'protected' : 'grants access to the broad identity Everyone',
      },
    ],
    ok,
  };
}

function commands(overrides: Partial<CliCommands> = {}): CliCommands {
  return {
    init: () => initResult,
    doctor: () => doctorReport(true),
    ...overrides,
  };
}

describe('run: options', () => {
  it('prints help and exits 0 for --help', () => {
    const { io, out, err } = capture();
    expect(run(['--help'], io, VERSION, commands()).exitCode).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(CLI_NAME);
    expect(err).toHaveLength(0);
  });

  it('accepts -h as an alias for --help', () => {
    const { io, out } = capture();
    expect(run(['-h'], io, VERSION, commands()).exitCode).toBe(EXIT_OK);
    expect(out.join('\n')).toBe(renderHelp(VERSION));
  });

  it('prints the version and exits 0 for --version', () => {
    const { io, out, err } = capture();
    expect(run(['--version'], io, VERSION, commands()).exitCode).toBe(EXIT_OK);
    expect(out).toEqual([VERSION]);
    expect(err).toHaveLength(0);
  });

  it('accepts -V as an alias for --version', () => {
    const { io, out } = capture();
    expect(run(['-V'], io, VERSION, commands()).exitCode).toBe(EXIT_OK);
    expect(out).toEqual([VERSION]);
  });

  it('prints help and exits 0 when given no arguments', () => {
    const { io, out } = capture();
    expect(run([], io, VERSION, commands()).exitCode).toBe(EXIT_OK);
    expect(out.join('\n')).toBe(renderHelp(VERSION));
  });

  it('reports an unknown option on stderr and exits 2', () => {
    const { io, out, err } = capture();
    expect(run(['--nope'], io, VERSION, commands()).exitCode).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain("unknown option '--nope'");
    expect(out).toHaveLength(0);
  });

  it('reports an unknown command and exits 2', () => {
    const { io, err } = capture();
    expect(run(['migrate'], io, VERSION, commands()).exitCode).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain("unknown command 'migrate'");
  });

  it('rejects an unexpected extra argument', () => {
    const { io, err } = capture();
    expect(run(['init', 'extra'], io, VERSION, commands()).exitCode).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('unexpected argument');
  });
});

describe('run: init', () => {
  it('reports the state root and exits 0', () => {
    const { io, out } = capture();
    expect(run(['init'], io, VERSION, commands()).exitCode).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain('/state');
    expect(text).toContain('Lease key:       created');
  });

  it('says the key was preserved on a repeat run', () => {
    const { io, out } = capture();
    run(['init'], io, VERSION, commands({ init: () => ({ ...initResult, createdDirectories: [], leaseKeyCreated: false }) }));
    expect(out.join('\n')).toContain('preserved unchanged');
  });

  it('maps a security failure to exit 3 and prints the remedy', () => {
    const { io, out, err } = capture();
    const failing = commands({
      init: () => {
        throw new SecurityError('secrets is not protected', 'Run init again.');
      },
    });

    expect(run(['init'], io, VERSION, failing).exitCode).toBe(EXIT_SECURITY);
    expect(err.join('\n')).toContain('secrets is not protected');
    expect(err.join('\n')).toContain('Run init again.');
    expect(out).toHaveLength(0);
  });

  it('maps an unexpected failure to exit 1', () => {
    const { io, err } = capture();
    const failing = commands({
      init: () => {
        throw new Error('disk on fire');
      },
    });

    expect(run(['init'], io, VERSION, failing).exitCode).toBe(EXIT_INTERNAL);
    expect(err.join('\n')).toContain('unexpected failure');
  });
});

describe('run: doctor', () => {
  it('exits 0 when every check passes', () => {
    const { io, out } = capture();
    expect(run(['doctor'], io, VERSION, commands()).exitCode).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('doctor: PASS');
  });

  it('exits 3 when a check fails, and says nothing was repaired', () => {
    const { io, out } = capture();
    const failing = commands({ doctor: () => doctorReport(false) });

    expect(run(['doctor'], io, VERSION, failing).exitCode).toBe(EXIT_SECURITY);
    const text = out.join('\n');
    expect(text).toContain('doctor: FAIL');
    expect(text).toContain('nothing was repaired');
    expect(text).toContain('Everyone');
  });
});

describe('renderHelp', () => {
  it('documents the implemented commands and exit codes', () => {
    const help = renderHelp(VERSION);
    expect(help).toContain(VERSION);
    expect(help).toContain('init');
    expect(help).toContain('doctor');
    expect(help).toContain('--help');
    expect(help).toContain('--version');
    expect(help).toContain('0  success');
    expect(help).toContain('3  security');
  });

  it('states that this is Phase 1 and does not promise later-phase work', () => {
    const help = renderHelp(VERSION);
    expect(help).toContain('Phase 1');
    expect(help).toContain('later phases');
    expect(help).not.toContain('migrations and principal bootstrap are available');
  });
});

describe('exit code contract', () => {
  it('is small, distinct, and stable', () => {
    expect([EXIT_OK, EXIT_INTERNAL, EXIT_USAGE, EXIT_SECURITY]).toEqual([0, 1, 2, 3]);
  });
});
