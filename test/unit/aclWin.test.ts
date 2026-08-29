import { describe, expect, it } from 'vitest';

import { SecurityError } from '../../src/errors.js';
import {
  TARGET_PATH_VARIABLE,
  WindowsSecurityProvider,
  buildIcaclsArgs,
} from '../../src/security/acl.win.js';
import type { CommandResult, CommandRunner } from '../../src/security/exec.js';
import { nodeCommandRunner } from '../../src/security/exec.js';

const SID = 'S-1-5-21-1-2-3-1001';

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly extraEnv: Readonly<Record<string, string>> | undefined;
}

class FakeRunner implements CommandRunner {
  public readonly calls: RecordedCall[] = [];

  public constructor(private readonly responder: (call: RecordedCall) => CommandResult) {}

  public run(
    file: string,
    args: readonly string[],
    extraEnv?: Readonly<Record<string, string>>,
  ): CommandResult {
    const call: RecordedCall = { file, args, extraEnv };
    this.calls.push(call);
    return this.responder(call);
  }
}

function isSidQuery(call: RecordedCall): boolean {
  return call.args.some((arg) => arg.includes('WindowsIdentity'));
}

function sddlFor(sid: string): string {
  return `O:${sid}G:${sid}D:PAI(A;OICI;FA;;;${sid})`;
}

function defaultResponder(call: RecordedCall): CommandResult {
  if (isSidQuery(call)) return { status: 0, stdout: `${SID}\n`, stderr: '' };
  if (call.args.includes('/inheritance:r')) return { status: 0, stdout: 'ok', stderr: '' };
  return { status: 0, stdout: sddlFor(SID), stderr: '' };
}

/**
 * Pre-resolved tool paths, so these tests exercise the ACL logic on any
 * platform. The fail-closed resolution itself is tested in systemTools.test.ts.
 */
const TEST_TOOLS = {
  icacls: 'C:/Windows/System32/icacls.exe',
  powershell: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
};

function makeProvider(responder: (call: RecordedCall) => CommandResult): {
  instance: WindowsSecurityProvider;
  runner: FakeRunner;
} {
  const runner = new FakeRunner(responder);
  return {
    instance: new WindowsSecurityProvider({ runner, tools: TEST_TOOLS }),
    runner,
  };
}

/** Answers the SID query normally and delegates everything else. */
function withSid(responder: (call: RecordedCall) => CommandResult) {
  return (call: RecordedCall): CommandResult =>
    isSidQuery(call) ? { status: 0, stdout: SID, stderr: '' } : responder(call);
}

describe('buildIcaclsArgs', () => {
  it('grants a directory inheritable full control by SID', () => {
    expect(buildIcaclsArgs('C:/state', 'directory', SID)).toEqual([
      'C:/state',
      '/inheritance:r',
      '/grant:r',
      `*${SID}:(OI)(CI)F`,
    ]);
  });

  it('grants a file full control without inheritance flags', () => {
    expect(buildIcaclsArgs('C:/state/lease.key', 'file', SID)).toEqual([
      'C:/state/lease.key',
      '/inheritance:r',
      '/grant:r',
      `*${SID}:F`,
    ]);
  });

  it('identifies the principal by SID, never by a localized account name', () => {
    const args = buildIcaclsArgs('C:/state', 'directory', SID);
    expect(args[3]?.startsWith('*S-1-')).toBe(true);
    expect(args.join(' ')).not.toContain('Users');
  });

  it('keeps a path with spaces and metacharacters as a single argument', () => {
    const awkward = 'C:/Users/a b & c/state';
    const args = buildIcaclsArgs(awkward, 'directory', SID);
    expect(args[0]).toBe(awkward);
    expect(args).toHaveLength(4);
  });
});

describe('WindowsSecurityProvider.subject', () => {
  it('reads the current user SID from Windows', () => {
    expect(makeProvider(defaultResponder).instance.subject()).toBe(SID);
  });

  it('caches the SID rather than re-querying', () => {
    const { instance, runner } = makeProvider(defaultResponder);
    instance.subject();
    instance.subject();
    expect(runner.calls).toHaveLength(1);
  });

  it('fails closed when the SID cannot be read', () => {
    const { instance } = makeProvider(() => ({ status: 1, stdout: '', stderr: 'denied' }));
    expect(() => instance.subject()).toThrow(SecurityError);
  });

  it('fails closed when the output is not a SID', () => {
    const { instance } = makeProvider(() => ({ status: 0, stdout: 'Administrator', stderr: '' }));
    expect(() => instance.subject()).toThrow(SecurityError);
  });
});

describe('WindowsSecurityProvider.harden', () => {
  it('invokes icacls with an argument vector', () => {
    const { instance, runner } = makeProvider(defaultResponder);
    instance.harden('C:/state', 'directory');
    const call = runner.calls.find((entry) => entry.args.includes('/inheritance:r'));
    expect(Array.isArray(call?.args)).toBe(true);
    expect(call?.args).toEqual(buildIcaclsArgs('C:/state', 'directory', SID));
  });

  it('fails closed when icacls reports failure', () => {
    const { instance } = makeProvider(
      withSid(() => ({ status: 1, stdout: '', stderr: 'Access is denied.' })),
    );
    expect(() => instance.harden('C:/state', 'directory')).toThrow(SecurityError);
  });
});

describe('WindowsSecurityProvider.verify', () => {
  it('passes the target path through the environment, never in the command', () => {
    const { instance, runner } = makeProvider(defaultResponder);
    const target = 'C:/Users/a b & c/state';
    instance.verify(target, 'directory');

    const call = runner.calls.find((entry) => entry.extraEnv !== undefined);
    expect(call?.extraEnv).toEqual({ [TARGET_PATH_VARIABLE]: target });
    // The path must never appear in the argument vector itself.
    expect(call?.args.join(' ')).not.toContain(target);
  });

  it('accepts a protected owner-only descriptor', () => {
    expect(makeProvider(defaultResponder).instance.verify('C:/state', 'directory').secure).toBe(true);
  });

  it('rejects a descriptor granting a broad identity', () => {
    const { instance } = makeProvider(
      withSid(() => ({
        status: 0,
        stdout: `O:${SID}G:${SID}D:P(A;;FA;;;${SID})(A;;FA;;;BU)`,
        stderr: '',
      })),
    );
    const report = instance.verify('C:/state', 'directory');
    expect(report.secure).toBe(false);
    expect(report.problems.join(' ')).toContain('BUILTIN');
  });

  it('rejects a descriptor carrying an inherited entry', () => {
    const { instance } = makeProvider(
      withSid(() => ({ status: 0, stdout: `O:${SID}G:${SID}D:AI(A;ID;FA;;;${SID})`, stderr: '' })),
    );
    const report = instance.verify('C:/state', 'directory');
    expect(report.secure).toBe(false);
    expect(report.problems.join(' ')).toContain('inherit');
  });

  it('fails closed when the descriptor cannot be read', () => {
    const { instance } = makeProvider(
      withSid(() => ({ status: 1, stdout: '', stderr: 'ItemNotFoundException' })),
    );
    expect(() => instance.verify('C:/missing', 'directory')).toThrow(SecurityError);
  });

  it('fails closed on empty descriptor output', () => {
    const { instance } = makeProvider(withSid(() => ({ status: 0, stdout: '   ', stderr: '' })));
    expect(() => instance.verify('C:/state', 'directory')).toThrow(SecurityError);
  });
});

describe('nodeCommandRunner', () => {
  it('does not use a shell, so metacharacters stay literal', () => {
    const awkward = 'a & b | c > d';
    const result = nodeCommandRunner.run(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1] ?? "")',
      awkward,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(awkward);
  });
});
