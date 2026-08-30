import { homedir, userInfo } from 'node:os';

import type { CloudSyncEnvironment } from '../config/cloudSync.js';
import { readFileIfPresent, realPathIfPresent } from '../config/cloudSync.js';
import type { StateLayout } from '../config/stateRoot.js';
import { legacyStateRoots, resolveStateRoot, stateLayout } from '../config/stateRoot.js';
import { SecurityError } from '../errors.js';
import { createSecurityProvider } from '../security/factory.js';
import type { SecurityProvider } from '../security/provider.js';

/**
 * The user profile directory, taken from OS identity on Windows.
 *
 * `os.homedir()` is deliberately NOT used on Windows: Node documents it as
 * consulting USERPROFILE first, and that was confirmed here — with
 * `USERPROFILE=D:\attacker-profile` it returned `D:\attacker-profile`, while
 * `os.userInfo().homedir` still returned the real profile. Using `homedir()`
 * would hand control of the state root, and the secrets in it, to anyone who
 * can set an environment variable.
 *
 * There is no fallback: if the OS cannot report the profile, resolution fails
 * closed rather than dropping back to an env-derived value.
 *
 * POSIX keeps `os.homedir()`, preserving the approved behaviour where
 * `$HOME` and `$XDG_STATE_HOME` are the conventional, intended inputs.
 */
function osProfileDir(platform: NodeJS.Platform): string {
  if (platform !== 'win32') return homedir();

  try {
    return userInfo().homedir;
  } catch {
    throw new SecurityError(
      'The operating system could not report the current user profile directory, so the state root cannot be resolved.',
      'Run from a normal Windows user session. The USERPROFILE environment variable is deliberately not trusted as a fallback.',
    );
  }
}

export interface CommandContext {
  readonly layout: StateLayout;
  readonly security: SecurityProvider;
  readonly cloudSync: CloudSyncEnvironment;
  /** Platform the path-safety rules are evaluated for. */
  readonly platform: NodeJS.Platform;
  /** Superseded roots, reported by doctor but never read or migrated. */
  readonly legacyRoots: readonly string[];
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
  const environment = { platform, env, profileDir: osProfileDir(platform) };
  const root = resolveStateRoot(environment);

  return {
    layout: stateLayout(root, platform),
    security: createSecurityProvider({ platform, systemRoot: env['SystemRoot'] }),
    cloudSync: {
      platform,
      env,
      profileDir: environment.profileDir,
      readFileIfPresent,
      realPathIfPresent,
    },
    platform,
    legacyRoots: legacyStateRoots(environment),
  };
}
