import {
  McpServer,
  type McpRequestContext,
  type McpServerFactory,
} from '@modelcontextprotocol/server';

import {
  actorAuthInfoFromAuthorizationContext,
  createDirectAuthorizationContext,
  type AuthorizationContext,
} from '../authority/context.js';
import { actorAuthInfoFromSdk, type ActorAuthInfo } from './auth.js';
import { registerCodexDecide, type Phase4AuthorityToolOptions } from './tools/codexDecide.js';
import { registerJobLifecycle, type Phase5JobToolOptions } from './tools/jobLifecycle.js';
import { registerPhase6WorkerTools, type Phase6WorkerToolOptions } from './tools/phase6.js';
import { registerPhase7EvidenceArtifactTools, type Phase7EvidenceArtifactToolOptions } from './tools/phase7.js';
import { registerPhase8Tools, type Phase8ToolOptions } from './tools/phase8.js';
import { registerPing, type McpTransportKind, SERVICE_NAME } from './tools/ping.js';

export interface McpServerFactoryOptions {
  readonly transport: McpTransportKind;
  readonly version: string;
  /** Used by stdio, whose SDK factory context has no HTTP auth envelope. */
  readonly staticAuthInfo?: ActorAuthInfo;
  /** Phase 4 authority backing; the tool is hidden unless auth has job:decide. */
  readonly authority?: Phase4AuthorityToolOptions;
  /** Phase 5 job-lifecycle backing; tools are hidden unless auth permits them. */
  readonly jobs?: Phase5JobToolOptions;
  /** Phase 6 worker-runtime backing; tools are hidden unless auth permits them. */
  readonly workers?: Phase6WorkerToolOptions;
  /** Phase 7 evidence/artifact backing; tools are hidden unless auth permits them. */
  readonly artifacts?: Phase7EvidenceArtifactToolOptions;
  /** Phase 8 read-only audit backing; the surface is visible only to the principal. */
  readonly phase8?: Phase8ToolOptions;
}

/** Builds the common compatibility and Phase 4 server surface for one transport/era. */
export function buildMcpServer(
  options: McpServerFactoryOptions,
  context: McpRequestContext,
  authorizationContext: AuthorizationContext | undefined,
): McpServer {
  const server = new McpServer(
    { name: SERVICE_NAME, version: options.version },
    { capabilities: { tools: {} } },
  );
  const normalizedActor = actorAuthInfoFromAuthorizationContext(authorizationContext);
  registerPing(server, options.transport, authorizationContext, context.era);
  if (options.authority !== undefined) {
    registerCodexDecide(server, options.authority, normalizedActor);
  }
  if (options.jobs !== undefined) {
    registerJobLifecycle(server, options.jobs, authorizationContext);
  }
  if (options.workers !== undefined) {
    registerPhase6WorkerTools(server, options.workers, authorizationContext);
  }
  if (options.artifacts !== undefined) {
    registerPhase7EvidenceArtifactTools(server, options.artifacts, authorizationContext);
  }
  if (options.phase8 !== undefined) {
    registerPhase8Tools(server, options.phase8, authorizationContext);
  }
  return server;
}

/** One factory shared by HTTP and stdio; no transport-specific tool logic. */
export function createMcpServerFactory(options: McpServerFactoryOptions): McpServerFactory {
  return (context: McpRequestContext) => {
    const authenticatedActor =
      options.staticAuthInfo ??
      (context.authInfo === undefined ? undefined : actorAuthInfoFromSdk(context.authInfo));
    const authorizationContext = createDirectAuthorizationContext(authenticatedActor);
    return buildMcpServer(options, context, authorizationContext);
  };
}
