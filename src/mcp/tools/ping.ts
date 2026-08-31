import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { ActorAuthInfo } from '../auth.js';

export const SERVICE_NAME = 'agent-orchestrator-mcp';

export type McpTransportKind = 'http' | 'stdio';

export const PingInput = z.object({});
export const PingOutput = z.object({
  ok: z.literal(true),
  service: z.literal(SERVICE_NAME),
  transport: z.enum(['http', 'stdio']),
  protocolEra: z.enum(['legacy', 'modern']),
});

export type PingResult = z.infer<typeof PingOutput>;

/** Registers the compatibility health tool shared by both phases. */
export function registerPing(
  server: McpServer,
  transport: McpTransportKind,
  authInfo: ActorAuthInfo | undefined,
  protocolEra: 'legacy' | 'modern',
): void {
  // The identity is intentionally accepted by the common factory but never
  // returned by this diagnostic tool; ping must not become an identity oracle.
  void authInfo;
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Return a bounded health response for the MCP spine.',
      inputSchema: PingInput,
      outputSchema: PingOutput,
    },
    async () => {
      const result: PingResult = {
        ok: true,
        service: SERVICE_NAME,
        transport,
        protocolEra,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
