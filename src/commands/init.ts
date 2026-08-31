import { existsSync, mkdirSync } from 'node:fs';

import { assertStateRootNotSynced } from '../config/cloudSync.js';
import { stateDirectories } from '../config/stateRoot.js';
import { SecurityError } from '../errors.js';
import { ensureLeaseKey } from '../secrets/leaseKey.js';
import { assertPathIsSafe } from '../security/pathSafety.js';
import { initializeDatabaseForInit, type DatabaseInitResult } from '../store/init.js';
import { ensurePhase5Config } from '../config/phase5.js';
import { ensurePhase6WorkerRegistry } from '../config/phase6.js';
import type { CommandContext } from './context.js';

export interface InitResult {
  readonly stateRoot: string;
  readonly createdDirectories: readonly string[];
  readonly leaseKeyCreated: boolean;
  readonly securityModel: string;
  readonly database: DatabaseInitResult;
}

export interface InitOptions {
  /** Test-only escape hatch for structural schema fixtures. Production defaults to true. */
  readonly phase4Bootstrap?: boolean;
}

/**
 * Bootstrap the protected state root and the Phase 4 production authority.
 *
 * The test-only `phase4Bootstrap: false` option leaves structural fixtures
 * unbootstrapped; production defaults to the approved Phase 4 bootstrap path.
 *
 * Ordering is load-bearing. Each directory is created, proven to be a real
 * directory rather than a redirection, hardened, and verified before the next
 * step runs, so the lease key is only ever written into a directory whose
 * protection has already been proven.
 */
export function runInit(context: CommandContext, options: InitOptions = {}): InitResult {
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
  const database = initializeDatabaseForInit(context, {
    phase4Bootstrap: options.phase4Bootstrap ?? true,
  });
  // Phase 5 runtime defaults live in the protected, operator-editable config
  // file. Create it only after database initialization succeeds so a failed
  // fresh init does not leave a misleading partial runtime configuration.
  ensurePhase5Config(context);
  // Keep the Phase 6 registry disabled by default; the operator must enable a
  // fully bound worker definition before dispatch can select it.
  ensurePhase6WorkerRegistry(context);

  return {
    stateRoot: layout.root,
    createdDirectories: created,
    leaseKeyCreated: leaseKey.created,
    securityModel: security.describe(),
    database,
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
