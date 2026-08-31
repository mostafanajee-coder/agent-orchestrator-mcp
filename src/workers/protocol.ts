import { z } from 'zod/v4';

const MAX_SUMMARY_BYTES = 2_048;
const MAX_PROGRESS_BYTES = 1_024;
const MAX_ERROR_BYTES = 2_048;
const MAX_USAGE_FIELDS = 16;
const MAX_USAGE_VALUE = Number.MAX_SAFE_INTEGER;

const UsageSchema = z.record(
  z.string().trim().min(1).max(64),
  z.number().int().nonnegative().max(MAX_USAGE_VALUE),
).superRefine((value, context) => {
  if (Object.keys(value).length > MAX_USAGE_FIELDS) {
    context.addIssue({ code: 'custom', message: 'usage contains too many fields.' });
  }
});

export const WorkerVerdictSchema = z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']);
export const WorkerFailureClassSchema = z.enum([
  'SPAWN_FAILED',
  'TRANSIENT',
  'AUTH_REQUIRED',
  'MALFORMED_OUTPUT',
  'TIMEOUT',
  'MODEL_ERROR',
]);

const ReadyMessageSchema = z.object({
  type: z.literal('ready'),
  protocol_version: z.literal(1),
  run_id: z.string().min(1).max(256),
  worker_id: z.string().min(1).max(64),
}).strict();

const ProgressMessageSchema = z.object({
  type: z.literal('progress'),
  seq: z.number().int().positive(),
  message: z.string().min(1).max(MAX_PROGRESS_BYTES),
}).strict();

const ResultMessageSchema = z.object({
  type: z.literal('result'),
  verdict: WorkerVerdictSchema,
  summary: z.string().trim().min(1).max(MAX_SUMMARY_BYTES),
  usage: UsageSchema.optional(),
}).strict();

const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  class: WorkerFailureClassSchema,
  message: z.string().trim().min(1).max(MAX_ERROR_BYTES),
}).strict();

export const WorkerMessageSchema = z.discriminatedUnion('type', [
  ReadyMessageSchema,
  ProgressMessageSchema,
  ResultMessageSchema,
  ErrorMessageSchema,
]);

export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export type WorkerResultMessage = z.infer<typeof ResultMessageSchema>;
export type WorkerErrorMessage = z.infer<typeof ErrorMessageSchema>;

export class WorkerProtocolError extends Error {
  public override readonly name = 'WorkerProtocolError';
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Parses one already-bounded NDJSON line. */
export function parseWorkerMessage(line: string): WorkerMessage {
  if (byteLength(line) > 65_536) {
    throw new WorkerProtocolError('The worker protocol line exceeds its bound.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new WorkerProtocolError('The worker emitted malformed JSON.');
  }
  const result = WorkerMessageSchema.safeParse(parsed);
  if (!result.success) throw new WorkerProtocolError('The worker emitted an invalid protocol message.');
  if (
    (result.data.type === 'progress' && byteLength(result.data.message) > MAX_PROGRESS_BYTES)
    || (result.data.type === 'result' && byteLength(result.data.summary) > MAX_SUMMARY_BYTES)
    || (result.data.type === 'error' && byteLength(result.data.message) > MAX_ERROR_BYTES)
  ) {
    throw new WorkerProtocolError('The worker protocol field exceeds its byte bound.');
  }
  return result.data;
}

export interface StartEnvelope {
  readonly type: 'start';
  readonly protocol_version: 1;
  readonly run_id: string;
  readonly job_id: string;
  readonly cycle: number;
  readonly worker_id: string;
  readonly task: string;
  readonly params: Record<string, unknown>;
  readonly workspace: string;
  readonly deadline_at: string;
  readonly lease?: string;
  readonly report_endpoint?: string;
}

/** Serializes the private process start envelope as one bounded NDJSON line. */
export function serializeStartEnvelope(envelope: StartEnvelope): string {
  const line = JSON.stringify(envelope) + '\n';
  if (byteLength(line) > 65_536) {
    throw new WorkerProtocolError('The worker start envelope exceeds its bound.');
  }
  return line;
}
