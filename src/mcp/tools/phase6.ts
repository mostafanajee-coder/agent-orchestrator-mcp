import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { AuditWriter } from '../../authority/audit.js';
import type { AuthorizationContext } from '../../authority/context.js';
import { actorForRequirement } from '../../authority/policy.js';
import {
  dispatchQa,
  listRunStatus,
  QaDispatchInputSchema,
  reportRun,
  RunLifecycleError,
  RUN_FAILURE_CLASS_VALUES,
  RUN_LIFECYCLE_ERROR_CODES,
  RUN_STATUS_VALUES,
  RunReportInputSchema,
  RunStatusInputSchema,
  type Phase6RunOptions,
  type RunSummary,
} from '../../domain/runs.js';
import type { SqliteDatabase } from '../../store/db.js';
import { redactSensitiveText } from '../../security/redaction.js';
import type { VerifiedActorAuthInfo } from '../auth.js';
import type { ProcessRuntime } from '../../workers/processRuntime.js';

export interface Phase6WorkerToolOptions extends Phase6RunOptions {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
  readonly processRuntime?: ProcessRuntime;
}

const RunSummaryOutput = z.object({
  run_id: z.string(),
  job_id: z.string(),
  cycle: z.number().int().nonnegative(),
  worker_id: z.string(),
  status: z.enum(RUN_STATUS_VALUES),
  worker_verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'NONE']).nullable(),
  failure_class: z.enum(RUN_FAILURE_CLASS_VALUES).nullable(),
  attempt: z.number().int().positive(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
});

const DispatchRunOutput = z.object({
  run_id: z.string(),
  worker_id: z.string(),
  status: z.literal('PENDING'),
});

const Phase6Failure = z.object({
  ok: z.literal(false),
  request_id: z.string().uuid(),
  error: z.object({
    code: z.enum(RUN_LIFECYCLE_ERROR_CODES),
    message: z.string(),
  }),
});

const DispatchSuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  job_id: z.string(),
  cycle: z.number().int().nonnegative(),
  state: z.literal('QA_RUNNING'),
  version: z.number().int().positive(),
  runs: z.array(DispatchRunOutput),
});

const ReportSuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  run_id: z.string(),
  job_id: z.string(),
  cycle: z.number().int().nonnegative(),
  status: z.enum(RUN_STATUS_VALUES),
  accepted: z.boolean(),
  duplicate: z.boolean(),
  job_state: z.string(),
});

const StatusSuccess = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  runs: z.array(RunSummaryOutput),
});

export const Phase6DispatchOutput = z.discriminatedUnion('ok', [DispatchSuccess, Phase6Failure]);
export const Phase6ReportOutput = z.discriminatedUnion('ok', [ReportSuccess, Phase6Failure]);
export const Phase6StatusOutput = z.discriminatedUnion('ok', [StatusSuccess, Phase6Failure]);

function requestId(): string {
  return randomUUID();
}

function dispatchActor(
  authorizationContext: AuthorizationContext | undefined,
): VerifiedActorAuthInfo | undefined {
  return actorForRequirement(authorizationContext, {
    capability: 'qa:request',
    allowedRoles: ['principal'],
    requiredActorId: 'codex',
  });
}

function reportActor(
  authorizationContext: AuthorizationContext | undefined,
): VerifiedActorAuthInfo | undefined {
  return actorForRequirement(authorizationContext, {
    capability: 'work:report',
    allowedRoles: ['worker'],
  });
}

function statusActor(
  authorizationContext: AuthorizationContext | undefined,
): VerifiedActorAuthInfo | undefined {
  return actorForRequirement(authorizationContext, {
    capability: 'job:read',
    allowedRoles: ['principal', 'observer'],
  });
}

function failure(error: unknown, currentRequestId: string): {
  readonly content: [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: z.infer<typeof Phase6Failure>;
} {
  const result: z.infer<typeof Phase6Failure> = error instanceof RunLifecycleError
    ? {
      ok: false,
      request_id: currentRequestId,
      error: { code: error.code, message: redactSensitiveText(error.message, [], { redactAbsolutePaths: true }) },
    }
    : { ok: false, request_id: currentRequestId, error: { code: 'INTERNAL_ERROR', message: 'The worker operation failed.' } };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function response<T extends z.infer<typeof DispatchSuccess> | z.infer<typeof ReportSuccess> | z.infer<typeof StatusSuccess>>(
  value: T,
): { readonly content: [{ readonly type: 'text'; readonly text: string }]; readonly structuredContent: T } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function statusOutput(runs: readonly RunSummary[]): readonly RunSummary[] {
  return runs.map((run) => ({ ...run }));
}

/** Registers the Phase 6 worker-runtime surface for one verified actor. */
export function registerPhase6WorkerTools(
  server: McpServer,
  options: Phase6WorkerToolOptions,
  authorizationContext: AuthorizationContext | undefined,
): void {
  const principal = dispatchActor(authorizationContext);
  const worker = reportActor(authorizationContext);
  const reader = statusActor(authorizationContext);

  if (principal !== undefined) {
    server.registerTool(
      'qa_dispatch',
      {
        title: 'Dispatch QA',
        description: 'Dispatch one or more registered local workers for the current job cycle.',
        inputSchema: QaDispatchInputSchema,
        outputSchema: Phase6DispatchOutput,
      },
      async (input) => {
        const currentRequestId = requestId();
        try {
          const result = dispatchQa(options.db, options.audit, principal, input, currentRequestId, options);
          options.processRuntime?.startRuns(result.runtimeLeases);
          return response({
            ok: true,
            request_id: currentRequestId,
            job_id: result.job_id,
            cycle: result.cycle,
            state: result.state,
            version: result.version,
            runs: [...result.runs],
          });
        } catch (error) {
          return failure(error, currentRequestId);
        }
      },
    );
  }

  if (worker !== undefined) {
    server.registerTool(
      'run_report',
      {
        title: 'Report Worker Run',
        description: 'Submit one bounded terminal result for the worker run bound to the supplied lease.',
        inputSchema: RunReportInputSchema,
        outputSchema: Phase6ReportOutput,
      },
      async (input) => {
        const currentRequestId = requestId();
        try {
          const result = reportRun(options.db, options.audit, worker, input, currentRequestId, options);
          return response({ ok: true, request_id: currentRequestId, ...result });
        } catch (error) {
          return failure(error, currentRequestId);
        }
      },
    );
  }

  if (reader !== undefined) {
    server.registerTool(
      'run_status',
      {
        title: 'Read Worker Runs',
        description: 'Read bounded run lifecycle status for a job.',
        inputSchema: RunStatusInputSchema,
        outputSchema: Phase6StatusOutput,
      },
      async (input) => {
        const currentRequestId = requestId();
        try {
          return response({
            ok: true,
            request_id: currentRequestId,
            runs: [...statusOutput(listRunStatus(options.db, reader, input))],
          });
        } catch (error) {
          return failure(error, currentRequestId);
        }
      },
    );
  }
}
