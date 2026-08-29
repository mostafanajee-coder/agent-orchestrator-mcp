import { spawnSync } from 'node:child_process';

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface CommandRunner {
  /**
   * Runs a program with an explicit argument vector.
   *
   * Implementations must never use a shell and must never build a command
   * string, so no path or identity can be interpreted as shell syntax.
   */
  run(file: string, args: readonly string[], extraEnv?: Readonly<Record<string, string>>): CommandResult;
}

export const nodeCommandRunner: CommandRunner = {
  run(file, args, extraEnv) {
    const result = spawnSync(file, [...args], {
      // Explicit: an argv array is passed straight to CreateProcess, so
      // quoting and metacharacters in a path can never become shell syntax.
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
    });

    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  },
};
