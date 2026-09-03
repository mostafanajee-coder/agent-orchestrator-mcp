#!/usr/bin/env node
import { runAsync } from './cli.js';
import { readPackageVersion } from './version.js';

const result = await runAsync(
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
