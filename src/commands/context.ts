import { homedir } from 'node:os';

import type { CloudSyncEnvironment } from '../config/cloudSync.js';
import { readFileIfPresent, realPathIfPresent } from '../config/cloudSync.js';
import type { StateLayout } from '../config/stateRoot.js';
import { resolveStateRoot, stateLayout } from '../config/stateRoot.js';
import { createSecurityProvider } from '../security/factory.js';
import type { SecurityProvider } from '../security/provider.js';

export interface CommandContext {
  readonly layout: StateLayout;
  readonly security: SecurityProvider;
  readonly cloudSync: CloudSyncEnvironment;
  /** Platform the path-safety rules are evaluated for. */
  readonly platform: NodeJS.Platform;
}

/**
 * Builds the real command context.
 *
 * The state root is resolved from the platform and environment only. There is
 * no caller-facing override, so no flag or configuration file can redirect
 * secrets somewhere less protected.
 */
export function createCommandContext(): CommandContext {
  const platform = process.platform;
  const env = process.env;
  const root = resolveStateRoot({ platform, env, homedir: homedir() });

  return {
    layout: stateLayout(root),
    security: createSecurityProvider({ platform, systemRoot: env['SystemRoot'] }),
    cloudSync: { platform, env, readFileIfPresent, realPathIfPresent },
    platform,
  };
}
