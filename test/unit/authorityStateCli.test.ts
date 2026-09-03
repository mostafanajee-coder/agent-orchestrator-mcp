import { describe, expect, it } from 'vitest';

import { EXIT_OK, EXIT_USAGE, runAsync, type CliCommands, type CliIo } from '../../src/cli.js';
import type { DoctorReport } from '../../src/commands/doctor.js';
import type { InitResult } from '../../src/commands/init.js';
import type { AuthorityStateCommandOptions, AuthorityStateCommandResult } from '../../src/commands/authorityState.js';

const initResult: InitResult = {
  stateRoot: '/state',
  createdDirectories: [],
  leaseKeyCreated: false,
  securityModel: 'test',
  database: { created: false, schemaVersion: 8, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8] },
};

const doctorResult: DoctorReport = {
  stateRoot: '/state',
  securityModel: 'test',
  subject: 'test',
  checks: [],
  ok: true,
};

function io(): { readonly io: CliIo; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function commands(
  authorityState: (options: AuthorityStateCommandOptions) => Promise<AuthorityStateCommandResult>,
): CliCommands {
  return { init: () => initResult, doctor: () => doctorResult, authorityState };
}

function result(action: AuthorityStateCommandOptions['action']): AuthorityStateCommandResult {
  return {
    action,
    path: '/state/authorization-state.v1.json',
    readiness: 'READY',
    epochFingerprint: 'f'.repeat(64),
    clockHighWaterMs: 1,
    effectiveNowMs: 1,
    reason: action === 'rotate' ? 'manual' : null,
    auditRecorded: action !== 'status',
    warning: null,
  };
}

describe('runAsync: authority-state', () => {
  it('parses local status without exposing a raw epoch', async () => {
    const captured: AuthorityStateCommandOptions[] = [];
    const streams = io();
    const exit = await runAsync(
      ['authority-state', 'status'],
      streams.io,
      '1.0.0',
      commands(async (options) => {
        captured.push(options);
        return result('status');
      }),
    );

    expect(exit.exitCode).toBe(EXIT_OK);
    expect(captured).toEqual([{ action: 'status' }]);
    expect(streams.out.join('\n')).toContain('Epoch fingerprint');
    expect(streams.out.join('\n')).not.toContain('authorization_epoch');
    expect(streams.err).toEqual([]);
  });

  it('requires a fixed reason for rotate and rejects unknown reasons before invocation', async () => {
    let invoked = false;
    const streams = io();
    const exit = await runAsync(
      ['authority-state', 'rotate', '--reason', 'arbitrary'],
      streams.io,
      '1.0.0',
      commands(async () => {
        invoked = true;
        return result('rotate');
      }),
    );

    expect(exit.exitCode).toBe(EXIT_USAGE);
    expect(invoked).toBe(false);
    expect(streams.err.join('\n')).toContain('unsupported reason');
  });
});
