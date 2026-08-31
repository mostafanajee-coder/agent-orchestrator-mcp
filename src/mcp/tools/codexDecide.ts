import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  DECISION_ERROR_CODES,
  DECISION_VALUES,
  AUTHORITATIVE_STATUS_VALUES,
  WORKFLOW_STATE_VALUES,
  applyDecision,
  type DecisionErrorCode,
  type DecisionInput,
} from '../../authority/decision.js';
import { hasCapability } from '../../authority/capabilities.js';
import type { AuditWriter } from '../../authority/audit.js';
import type { SqliteDatabase } from '../../store/db.js';
import type { ActorAuthInfo, VerifiedActorAuthInfo } from '../auth.js';

export const CodexDecideInput = z.object({
  job_id: z.string().min(1).max(256),
  cycle: z.number().int().nonnegative(),
  decision: z.enum(DECISION_VALUES),
  rationale: z.string().min(1).max(8_192),
  evidence_refs: z.array(z.string().min(1).max(256)).max(64).optional(),
  expected_version: z.number().int().positive(),
  idempotency_key: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  ).optional(),
  session_hint: z.string().min(1).max(256).optional(),
});

const DecisionSuccess = z.object({
  ok: z.literal(true),
  decision_id: z.string(),
  job_id: z.string(),
  state: z.enum(WORKFLOW_STATE_VALUES),
  authoritative_status: z.enum(AUTHORITATIVE_STATUS_VALUES).nullable(),
  cycle: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});

const DecisionFailure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(DECISION_ERROR_CODES),
    message: z.string(),
  }),
});

export const CodexDecideOutput = z.discriminatedUnion('ok', [DecisionSuccess, DecisionFailure]);

export type CodexDecideInputValue = z.infer<typeof CodexDecideInput>;
export type CodexDecideOutputValue = z.infer<typeof CodexDecideOutput>;

export interface Phase4AuthorityToolOptions {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
}

function verifiedAuthority(
  authInfo: ActorAuthInfo | undefined,
): VerifiedActorAuthInfo | undefined {
  if (
    authInfo === undefined
    || authInfo.actorId === undefined
    || authInfo.role === undefined
    || authInfo.capabilities === undefined
  ) {
    return undefined;
  }
  if (
    authInfo.actorId !== 'codex'
    || authInfo.role !== 'principal'
    || !hasCapability(authInfo.capabilities, 'job:decide')
  ) {
    return undefined;
  }
  return authInfo as VerifiedActorAuthInfo;
}

function requestIdFromContext(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return 'mcp-request';
}

function failure(
  code: DecisionErrorCode,
  message: string,
): { readonly content: [{ readonly type: 'text'; readonly text: string }]; readonly structuredContent: CodexDecideOutputValue } {
  const result: CodexDecideOutputValue = { ok: false, error: { code, message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** Registers the only Phase 4 authority tool for an explicitly authorized actor. */
export function registerCodexDecide(
  server: McpServer,
  options: Phase4AuthorityToolOptions,
  authInfo: ActorAuthInfo | undefined,
): void {
  const actor = verifiedAuthority(authInfo);
  if (actor === undefined) return;

  server.registerTool(
    'codex_decide',
    {
      title: 'Codex Decide',
      description: 'Apply one approved Codex authority transition to an existing job.',
      inputSchema: CodexDecideInput,
      outputSchema: CodexDecideOutput,
    },
    async (input, context) => {
      const decisionInput: DecisionInput = {
        jobId: input.job_id,
        cycle: input.cycle,
        decision: input.decision,
        rationale: input.rationale,
        evidenceRefs: input.evidence_refs ?? [],
        expectedVersion: input.expected_version,
        ...(input.idempotency_key === undefined ? {} : { idempotencyKey: input.idempotency_key }),
        ...(input.session_hint === undefined ? {} : { sessionHint: input.session_hint }),
        requestId: requestIdFromContext(context.mcpReq.id),
      };
      try {
        const result = applyDecision(options.db, options.audit, actor, decisionInput);
        const output: CodexDecideOutputValue = {
          ok: true,
          decision_id: result.decisionId,
          job_id: result.jobId,
          state: result.state,
          authoritative_status: result.authoritativeStatus,
          cycle: result.cycle,
          version: result.version,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        if (error instanceof Error && 'code' in error) {
          const code = error.code;
          if ((DECISION_ERROR_CODES as readonly string[]).includes(code as string)) {
            return failure(
              code as DecisionErrorCode,
              error.message,
            );
          }
        }
        return failure('INTERNAL_ERROR', 'The decision could not be applied.');
      }
    },
  );
}
