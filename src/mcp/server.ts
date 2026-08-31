import {
  McpServer,
  type McpRequestContext,
  type McpServerFactory,
} from '@modelcontextprotocol/server';

import { actorAuthInfoFromSdk, type ActorAuthInfo } from './auth.js';
import { registerCodexDecide, type Phase4AuthorityToolOptions } from './tools/codexDecide.js';
import { registerPing, type McpTransportKind, SERVICE_NAME } from './tools/ping.js';

export interface McpServerFactoryOptions {
  readonly transport: McpTransportKind;
  readonly version: string;
  /** Used by stdio, whose SDK factory context has no HTTP auth envelope. */
  readonly staticAuthInfo?: ActorAuthInfo;
  /** Phase 4 authority backing; the tool is hidden unless auth has job:decide. */
  readonly authority?: Phase4AuthorityToolOptions;
}

/** Builds the common compatibility and Phase 4 server surface for one transport/era. */
export function buildMcpServer(
  options: McpServerFactoryOptions,
  context: McpRequestContext,
  authInfo: ActorAuthInfo | undefined,
): McpServer {
  const server = new McpServer(
    { name: SERVICE_NAME, version: options.version },
    { capabilities: { tools: {} } },
  );
  registerPing(server, options.transport, authInfo, context.era);
  if (options.authority !== undefined) {
    registerCodexDecide(server, options.authority, authInfo);
  }
  return server;
}

/** One factory shared by HTTP and stdio; no transport-specific tool logic. */
export function createMcpServerFactory(options: McpServerFactoryOptions): McpServerFactory {
  return (context: McpRequestContext) => {
    const authInfo =
      options.staticAuthInfo ??
      (context.authInfo === undefined ? undefined : actorAuthInfoFromSdk(context.authInfo));
    return buildMcpServer(options, context, authInfo);
  };
}
