import { PosixSecurityProvider } from './acl.posix.js';
import { WindowsSecurityProvider } from './acl.win.js';
import type { CommandRunner } from './exec.js';
import { nodeCommandRunner } from './exec.js';
import type { SecurityProvider } from './provider.js';

export interface SecurityProviderOptions {
  readonly platform: NodeJS.Platform;
  readonly runner?: CommandRunner;
  readonly systemRoot?: string | undefined;
}

export function createSecurityProvider(options: SecurityProviderOptions): SecurityProvider {
  if (options.platform === 'win32') {
    return new WindowsSecurityProvider({
      runner: options.runner ?? nodeCommandRunner,
      systemRoot: options.systemRoot,
    });
  }
  return new PosixSecurityProvider();
}
