import { describe, expect, it } from 'vitest';

import type { CliIo } from '../../src/cli.js';
import { CLI_NAME, EXIT_OK, EXIT_USAGE, renderHelp, run } from '../../src/cli.js';

const VERSION = '1.2.3';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    out,
    err,
  };
}

describe('run', () => {
  it('prints help and exits 0 for --help', () => {
    const { io, out, err } = capture();
    expect(run(['--help'], io, VERSION).exitCode).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(CLI_NAME);
    expect(err).toHaveLength(0);
  });

  it('accepts -h as an alias for --help', () => {
    const { io, out } = capture();
    expect(run(['-h'], io, VERSION).exitCode).toBe(EXIT_OK);
    expect(out.join('\n')).toBe(renderHelp(VERSION));
  });

  it('prints the version and exits 0 for --version', () => {
    const { io, out, err } = capture();
    expect(run(['--version'], io, VERSION).exitCode).toBe(EXIT_OK);
    expect(out).toEqual([VERSION]);
    expect(err).toHaveLength(0);
  });

  it('accepts -V as an alias for --version', () => {
    const { io, out } = capture();
    expect(run(['-V'], io, VERSION).exitCode).toBe(EXIT_OK);
    expect(out).toEqual([VERSION]);
  });

  it('prints help and exits 0 when given no arguments', () => {
    const { io, out } = capture();
    expect(run([], io, VERSION).exitCode).toBe(EXIT_OK);
    expect(out.join('\n')).toBe(renderHelp(VERSION));
  });

  it('reports an unknown option on stderr and exits 2', () => {
    const { io, out, err } = capture();
    expect(run(['--nope'], io, VERSION).exitCode).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain("unknown option '--nope'");
    expect(out).toHaveLength(0);
  });
});

describe('renderHelp', () => {
  it('includes the version, usage, and both documented options', () => {
    const help = renderHelp(VERSION);
    expect(help).toContain(VERSION);
    expect(help).toContain('Usage:');
    expect(help).toContain('--help');
    expect(help).toContain('--version');
  });
});
