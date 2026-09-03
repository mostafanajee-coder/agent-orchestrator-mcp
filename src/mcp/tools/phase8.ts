import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { AuthorizationContext } from '../../authority/context.js';
import { actorForRequirement } from '../../authority/policy.js';
import {
  AUDIT_QUERY_MAX_LIMIT,
  AuditQueryError,
  listAudit,
  type AuditQueryInput,
  type AuditQueryResult,
} from '../../domain/auditQuery.js';
import type { SqliteDatabase } from '../../store/db.js';
import { redactSensitiveText } from '../../security/redaction.js';
import type { VerifiedActorAuthInfo } from '../auth.js';

export interface Phase8ToolOptions {
  readonly db: SqliteDatabase;
}

export const AuditQueryInputSchema = z.object({
  job_id: z.string().trim().min(1).max(256).optional(),
  session_token_id: z.string().trim().min(1).max(256).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(AUDIT_QUERY_MAX_LIMIT).optional(),
  verify_range: z.boolean().optional(),
}).strict();

const AuditEventOutput = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  actor_id: z.string(),
  actor_role: z.enum(['principal', 'worker', 'observer', 'system']),
  session_token_id: z.string().nullable(),
  request_id: z.string(),
  action: z.string(),
  job_id: z.string().nullable(),
  cycle: z.number().int().nonnegative().nullable(),
  capability: z.string().nullable(),
  subject_type: z.string().nullable(),
  subject_id: z.string().nullable(),
  from_state: z.string().nullable(),
  to_state: z.string().nullable(),
  from_auth_status: z.string().nullable(),
  to_auth_status: z.string().nullable(),
  result: z.enum(['ok', 'denied', 'error']),
  detail_json: z.string().nullable(),
  detail_truncated: z.boolean(),
});

const AuditQuerySuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  events: z.array(AuditEventOutput),
  next_cursor: z.string().optional(),
  chain_valid: z.literal(true).optional(),
});

const AUDIT_QUERY_ERROR_CODES = [
  'AUTHORIZATION_DENIED',
  'INVALID_INPUT',
  'INVALID_CURSOR',
  'QUERY_LIMIT_EXCEEDED',
  'AUDIT_CHAIN_BROKEN',
  'INTERNAL_ERROR',
] as const;

const AuditQueryFailure = z.object({
  ok: z.literal(false),
  request_id: z.string().uuid(),
  error: z.object({
    code: z.enum(AUDIT_QUERY_ERROR_CODES),
    message: z.string(),
  }),
});

export const Phase8AuditQueryOutput = z.discriminatedUnion('ok', [AuditQuerySuccess, AuditQueryFailure]);

function requestId(): string {
  return randomUUID();
}

function principalActor(
  authorizationContext: AuthorizationContext | undefined,
): VerifiedActorAuthInfo | undefined {
  return actorForRequirement(authorizationContext, {
    capability: 'job:read',
    allowedRoles: ['principal'],
    requiredActorId: 'codex',
  });
}

function success(result: AuditQueryResult, id: string): {
  readonly content: [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: z.infer<typeof AuditQuerySuccess>;
} {
  const value = {
    ok: true as const,
    request_id: id,
    events: [...result.events],
    ...(result.next_cursor === undefined ? {} : { next_cursor: result.next_cursor }),
    ...(result.chain_valid === undefined ? {} : { chain_valid: result.chain_valid }),
  };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function failure(error: unknown, id: string): {
  readonly content: [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: z.infer<typeof AuditQueryFailure>;
} {
  const value = error instanceof AuditQueryError
    ? {
      ok: false as const,
      request_id: id,
      error: { code: error.code, message: redactSensitiveText(error.message, [], { redactAbsolutePaths: true }) },
    }
    : { ok: false as const, request_id: id, error: { code: 'INTERNAL_ERROR' as const, message: 'The audit query failed.' } };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function queryInput(input: z.infer<typeof AuditQueryInputSchema>): AuditQueryInput {
  return {
    ...(input.job_id === undefined ? {} : { job_id: input.job_id }),
    ...(input.session_token_id === undefined ? {} : { session_token_id: input.session_token_id }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.verify_range === undefined ? {} : { verify_range: input.verify_range }),
  };
}

/** Registers the Phase 8 bounded audit inspection surface for the principal only. */
export function registerPhase8Tools(
  server: McpServer,
  options: Phase8ToolOptions,
  authorizationContext: AuthorizationContext | undefined,
): void {
  const principal = principalActor(authorizationContext);
  if (principal === undefined) return;

  server.registerTool(
    'audit_query',
    {
      title: 'Query Audit History',
      description: 'Read a bounded, redacted, immutable audit-history page.',
      inputSchema: AuditQueryInputSchema,
      outputSchema: Phase8AuditQueryOutput,
    },
    async (input) => {
      const id = requestId();
      try {
        return success(listAudit(options.db, queryInput(input)), id);
      } catch (error) {
        return failure(error, id);
      }
    },
  );
}
