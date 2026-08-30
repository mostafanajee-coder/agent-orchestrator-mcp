import { existsSync, mkdirSync } from 'node:fs';

import { assertStateRootNotSynced } from '../config/cloudSync.js';
import { stateDirectories } from '../config/stateRoot.js';
import { SecurityError } from '../errors.js';
import { ensureLeaseKey } from '../secrets/leaseKey.js';
import { assertPathIsSafe } from '../security/pathSafety.js';
import type { CommandContext } from './context.js';

export interface InitResult {
  readonly stateRoot: string;
  readonly createdDirectories: readonly string[];
  readonly leaseKeyCreated: boolean;
  readonly securityModel: string;
}

/**
 * Phase 1 bootstrap: prepare and protect the state root.
 *
 * Later phases extend `init` with schema migrations and principal bootstrap;
 * neither exists yet.
 *
 * Ordering is load-bearing. Each directory is created, proven to be a real
 * directory rather than a redirection, hardened, and verified before the next
 * step runs, so the lease key is only ever written into a directory whose
 * protection has already been proven.
 */
export function runInit(context: CommandContext): InitResult {
  const { layout, security } = context;

  // Lexical pass: refuse a bad location before creating anything at all.
  assertStateRootNotSynced(layout.root, context.cloudSync);

  const created: string[] = [];
  for (const directory of stateDirectories(layout)) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      created.push(directory);
    }
    // Before hardening: never apply icacls or chmod through a link, which
    // would protect the target instead of this path.
    assertPathIsSafe(directory, 'directory', context.platform);
    security.harden(directory, 'directory');
    assertSecure(context, directory, 'directory');
  }

  // Real-path pass: the root now exists, so redirection into a synchronised
  // location can be resolved rather than only compared by name.
  assertStateRootNotSynced(layout.root, context.cloudSync);

  const leaseKey = ensureLeaseKey(layout.leaseKey, security);

  // Final sweep: prove every path is still safe and protected after all
  // mutations, including the key just created.
  for (const directory of stateDirectories(layout)) {
    assertPathIsSafe(directory, 'directory', context.platform);
    assertSecure(context, directory, 'directory');
  }
  assertPathIsSafe(layout.leaseKey, 'file', context.platform, { requireSingleLink: true });
  assertSecure(context, layout.leaseKey, 'file');

  return {
    stateRoot: layout.root,
    createdDirectories: created,
    leaseKeyCreated: leaseKey.created,
    securityModel: security.describe(),
  };
}

function assertSecure(
  context: CommandContext,
  path: string,
  kind: 'directory' | 'file',
): void {
  const report = context.security.verify(path, kind);
  if (!report.secure) {
    throw new SecurityError(
      `${path} is not protected: ${report.problems.join('; ')}.`,
      'Resolve the permission problem and run init again. Nothing was repaired automatically.',
    );
  }
}
