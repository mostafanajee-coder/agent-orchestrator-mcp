#!/usr/bin/env node
import { run } from './cli.js';
import { readPackageVersion } from './version.js';

const result = run(
  process.argv.slice(2),
  {
    out: (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    err: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
  },
  readPackageVersion(),
);

process.exitCode = result.exitCode;
