import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  hasCapability,
} from '../../authority/capabilities.js';
import {
  AUTHORITATIVE_STATUS_VALUES,
  WORKFLOW_STATE_VALUES,
} from '../../domain/decide.js';
import {
  createJob,
  getJob,
  JobCreateInputSchema,
  JobGetInputSchema,
  JobLifecycleError,
  JOB_LIFECYCLE_ERROR_CODES,
  JobListInputSchema,
  JobMutationInputSchema,
  listJobs,
  resumeJob,
  startJob,
  type JobLifecycleOptions,
  type JobRecord,
  type JobSummary,
} from '../../domain/jobs.js';
import type { AuditWriter } from '../../authority/audit.js';
import type { SqliteDatabase } from '../../store/db.js';
import type { ActorAuthInfo, VerifiedActorAuthInfo } from '../auth.js';

export interface Phase5JobToolOptions extends JobLifecycleOptions {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
}

const JobRecordOutput = z.object({
  job_id: z.string(),
  workspace: z.string(),
  title: z.string(),
  spec: z.object({
    objective: z.string(),
    acceptance_criteria: z.array(z.string()),
    context: z.string().optional(),
  }),
  state: z.enum(WORKFLOW_STATE_VALUES),
  state_reason: z.string().nullable(),
  authoritative_status: z.enum(AUTHORITATIVE_STATUS_VALUES).nullable(),
  deciding_decision_id: z.string().nullable(),
  owner_actor_id: z.string(),
  cycle: z.number().int().nonnegative(),
  max_cycles: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  deadline_at: z.string().nullable(),
  stale_after_s: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
});

const JobSummaryOutput = JobRecordOutput.pick({
  job_id: true,
  workspace: true,
  title: true,
  state: true,
  state_reason: true,
  authoritative_status: true,
  cycle: true,
  max_cycles: true,
  version: true,
  owner_actor_id: true,
  deadline_at: true,
  stale_after_s: true,
  created_at: true,
  updated_at: true,
});

const DecisionOutput = z.object({
  decision_id: z.string(),
  job_id: z.string(),
  cycle: z.number().int().nonnegative(),
  actor_id: z.string(),
  session_token_id: z.string().nullable(),
  request_id: z.string(),
  session_hint: z.string().nullable(),
  decision: z.string(),
  rationale: z.string(),
  evidence_refs: z.array(z.string()).nullable(),
  from_state: z.string(),
  to_state: z.string(),
  created_at: z.string(),
});

const JobMutationSuccess = z.object({
  ok: z.literal(true),
  job_id: z.string(),
  state: z.enum(WORKFLOW_STATE_VALUES),
  authoritative_status: z.enum(AUTHORITATIVE_STATUS_VALUES).nullable(),
  cycle: z.number().int().nonnegative(),
  max_cycles: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});

const JobGetSuccess = z.object({
  ok: z.literal(true),
  job: JobRecordOutput,
  decisions: z.array(DecisionOutput).optional(),
});

const JobListSuccess = z.object({
  ok: z.literal(true),
  jobs: z.array(JobSummaryOutput),
  next_cursor: z.string().optional(),
});

const JobFailure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(JOB_LIFECYCLE_ERROR_CODES),
    message: z.string(),
  }),
});

export const JobMutationOutput = z.discriminatedUnion('ok', [JobMutationSuccess, JobFailure]);
export const JobGetOutput = z.discriminatedUnion('ok', [JobGetSuccess, JobFailure]);
export const JobListOutput = z.discriminatedUnion('ok', [JobListSuccess, JobFailure]);

export type JobMutationOutputValue = z.infer<typeof JobMutationOutput>;
export type JobGetOutputValue = z.infer<typeof JobGetOutput>;
export type JobListOutputValue = z.infer<typeof JobListOutput>;

function requestIdFromContext(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return 'mcp-request';
}

function validCapabilities(authInfo: VerifiedActorAuthInfo): boolean {
  try {
    assertRoleCapabilities(authInfo.role, authInfo.capabilities);
    return canonicalCapabilitiesJson(authInfo.capabilities) === JSON.stringify(authInfo.capabilities);
  } catch {
    return false;
  }
}

function verifiedActor(authInfo: ActorAuthInfo | undefined): VerifiedActorAuthInfo | undefined {
  if (
    authInfo === undefined
    || authInfo.actorId === undefined
    || authInfo.role === undefined
    || authInfo.capabilities === undefined
    || authInfo.clientId !== authInfo.actorId
  ) {
    return undefined;
  }
  const actor = authInfo as VerifiedActorAuthInfo;
  return validCapabilities(actor) ? actor : undefined;
}

function lifecycleActor(authInfo: ActorAuthInfo | undefined): VerifiedActorAuthInfo | undefined {
  const actor = verifiedActor(authInfo);
  if (
    actor === undefined
    || actor.actorId !== 'codex'
    || actor.role !== 'principal'
    || !hasCapability(actor.capabilities, 'job:create')
  ) {
    return undefined;
  }
  return actor;
}

function readerActor(authInfo: ActorAuthInfo | undefined): VerifiedActorAuthInfo | undefined {
  const actor = verifiedActor(authInfo);
  if (
    actor === undefined
    || (actor.role !== 'principal' && actor.role !== 'observer')
    || !hasCapability(actor.capabilities, 'job:read')
  ) {
    return undefined;
  }
  return actor;
}

function mutationOutput(job: JobRecord): JobMutationOutputValue {
  return {
    ok: true,
    job_id: job.job_id,
    state: job.state,
    authoritative_status: job.authoritative_status,
    cycle: job.cycle,
    max_cycles: job.max_cycles,
    version: job.version,
  };
}

function failure(
  error: unknown,
): { readonly content: [{ readonly type: 'text'; readonly text: string }]; readonly structuredContent: JobFailureValue } {
  const result: JobFailureValue = error instanceof JobLifecycleError
    ? { ok: false, error: { code: error.code, message: error.message } }
    : { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The job lifecycle operation failed.' } };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

type JobFailureValue = z.infer<typeof JobFailure>;

function success<T extends JobMutationOutputValue | JobGetOutputValue | JobListOutputValue>(
  result: T,
): { readonly content: [{ readonly type: 'text'; readonly text: string }]; readonly structuredContent: T } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** Registers the Phase 5 job-lifecycle surface for the verified actor. */
export function registerJobLifecycle(
  server: McpServer,
  options: Phase5JobToolOptions,
  authInfo: ActorAuthInfo | undefined,
): void {
  const reader = readerActor(authInfo);
  const lifecycle = lifecycleActor(authInfo);

  if (lifecycle !== undefined) {
    server.registerTool(
      'job_create',
      {
        title: 'Create Job',
        description: 'Create a durable non-authoritative job inside an allowed workspace.',
        inputSchema: JobCreateInputSchema,
        outputSchema: JobMutationOutput,
      },
      async (input, context) => {
        try {
          return success(mutationOutput(createJob(
            options.db,
            options.audit,
            lifecycle,
            input,
            requestIdFromContext(context.mcpReq.id),
            options,
          )));
        } catch (error) {
          return failure(error);
        }
      },
    );

    server.registerTool(
      'job_start',
      {
        title: 'Start Job',
        description: 'Move a created job into non-authoritative in-progress work.',
        inputSchema: JobMutationInputSchema,
        outputSchema: JobMutationOutput,
      },
      async (input, context) => {
        try {
          return success(mutationOutput(startJob(
            options.db,
            options.audit,
            lifecycle,
            input,
            requestIdFromContext(context.mcpReq.id),
            options,
          )));
        } catch (error) {
          return failure(error);
        }
      },
    );

    server.registerTool(
      'job_resume',
      {
        title: 'Resume Job',
        description: 'Resume a repair job without changing its cycle or authority status.',
        inputSchema: JobMutationInputSchema,
        outputSchema: JobMutationOutput,
      },
      async (input, context) => {
        try {
          return success(mutationOutput(resumeJob(
            options.db,
            options.audit,
            lifecycle,
            input,
            requestIdFromContext(context.mcpReq.id),
            options,
          )));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  if (reader !== undefined) {
    server.registerTool(
      'job_get',
      {
        title: 'Get Job',
        description: 'Read one bounded job-lifecycle record and its durable decisions.',
        inputSchema: JobGetInputSchema,
        outputSchema: JobGetOutput,
      },
      async (input) => {
        try {
          const result = getJob(options.db, reader, input);
          return success({
            ok: true,
            job: result.job,
            ...(result.decisions === undefined
              ? {}
              : {
                decisions: result.decisions.map((decision) => ({
                  ...decision,
                  evidence_refs: decision.evidence_refs === null ? null : [...decision.evidence_refs],
                })),
              }),
          });
        } catch (error) {
          return failure(error);
        }
      },
    );

    server.registerTool(
      'job_list',
      {
        title: 'List Jobs',
        description: 'List bounded job summaries across admitted projects.',
        inputSchema: JobListInputSchema,
        outputSchema: JobListOutput,
      },
      async (input) => {
        try {
          const result = listJobs(options.db, reader, input, options);
          return success({
            ok: true,
            jobs: result.jobs.map((job): JobSummary => ({ ...job })),
            ...(result.next_cursor === undefined ? {} : { next_cursor: result.next_cursor }),
          });
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
}
