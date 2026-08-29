import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { SecurityError } from '../errors.js';

/**
 * Absolute locations of the Windows tools this process is allowed to run.
 *
 * Security-critical executables are never invoked by bare name: doing so would
 * let any directory earlier on PATH supply a substitute `icacls.exe` or
 * `powershell.exe`. If the trusted absolute executable cannot be located and
 * proven to be a regular file, resolution fails closed rather than falling
 * back to PATH.
 */
export interface SystemToolPaths {
  readonly icacls: string;
  readonly powershell: string;
}

const WINDOWS_ROOT_PATTERN = /^[A-Za-z]:[\\/]/;

function assertUsableSystemRoot(systemRoot: string | undefined): string {
  if (systemRoot === undefined || systemRoot.trim() === '') {
    throw new SecurityError(
      'SystemRoot is not set, so trusted Windows system tools cannot be located.',
      'Run from a normal Windows session where SystemRoot is defined. Tools are never resolved through PATH.',
    );
  }
  if (!isAbsolute(systemRoot) || !WINDOWS_ROOT_PATTERN.test(systemRoot)) {
    throw new SecurityError(
      `SystemRoot (${systemRoot}) is not an absolute Windows path, so system tools cannot be trusted.`,
      'Tools are never resolved through PATH.',
    );
  }
  return systemRoot;
}

/**
 * Proves a resolved tool path is a real, present executable file.
 *
 * `lstat` rather than `stat`, so a symlink or reparse point standing in for a
 * system binary is refused instead of followed.
 */
function assertTrustedExecutable(path: string, label: string): string {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new SecurityError(
      `The trusted Windows tool ${label} was not found at ${path}.`,
      'It is never resolved through PATH. Repair the Windows installation.',
    );
  }

  if (stats.isSymbolicLink()) {
    throw new SecurityError(
      `The trusted Windows tool ${label} at ${path} is a link, not a regular executable.`,
      'Refusing to run it. Repair the Windows installation.',
    );
  }
  if (!stats.isFile()) {
    throw new SecurityError(
      `The trusted Windows tool ${label} at ${path} is not a regular file.`,
      'Refusing to run it. Repair the Windows installation.',
    );
  }
  return path;
}

/** Where each tool must live, relative to SystemRoot. */
export function expectedToolPaths(systemRoot: string): SystemToolPaths {
  return {
    icacls: join(systemRoot, 'System32', 'icacls.exe'),
    powershell: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  };
}

/**
 * Resolves the Windows tools, failing closed when either is unavailable.
 *
 * There is deliberately no PATH fallback of any kind.
 */
export function resolveSystemTools(systemRoot: string | undefined): SystemToolPaths {
  const root = assertUsableSystemRoot(systemRoot);
  const expected = expectedToolPaths(root);
  return {
    icacls: assertTrustedExecutable(expected.icacls, 'icacls.exe'),
    powershell: assertTrustedExecutable(expected.powershell, 'powershell.exe'),
  };
}
