import {
  serveStdio,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import type { Transport } from '@modelcontextprotocol/server';

import {
  authenticateEnvironmentToken,
  type AccessTokenResolver,
  type ActorAuthInfo,
} from './auth.js';
import { createMcpServerFactory } from './server.js';

export interface StdioServerOptions {
  readonly authInfo: ActorAuthInfo;
  readonly version: string;
  readonly onerror?: (error: Error) => void;
  /** Injectable only for deterministic tests; production uses process stdio. */
  readonly transport?: Transport;
}

/** Starts the official stdio transport over the common MCP server factory. */
export function startStdioServer(options: StdioServerOptions): StdioServerHandle {
  const stdioOptions = {
    legacy: 'serve' as const,
    ...(options.onerror === undefined ? {} : { onerror: options.onerror }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  };
  return serveStdio(
    createMcpServerFactory({
      transport: 'stdio',
      version: options.version,
      staticAuthInfo: options.authInfo,
    }),
    stdioOptions,
  );
}

/**
 * Authenticates a supplied stdio token once before the transport starts.
 * This is useful for deterministic tests and for a future Phase 3 resolver.
 */
export async function startAuthenticatedStdioServer(options: {
  readonly resolver: AccessTokenResolver;
  readonly token: string;
  readonly version: string;
  readonly onerror?: (error: Error) => void;
}): Promise<StdioServerHandle> {
  const authInfo = await options.resolver.verifyAccessToken(options.token);
  return startStdioServer({
    authInfo,
    version: options.version,
    ...(options.onerror === undefined ? {} : { onerror: options.onerror }),
  });
}

/** Production CLI path: environment token is resolved before serving. */
export function startEnvironmentStdioServer(options: {
  readonly version: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly onerror?: (error: Error) => void;
}): StdioServerHandle {
  const authInfo = authenticateEnvironmentToken(options.environment);
  return startStdioServer({
    authInfo,
    version: options.version,
    ...(options.onerror === undefined ? {} : { onerror: options.onerror }),
  });
}
