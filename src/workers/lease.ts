import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { z } from 'zod/v4';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_LEASE_LENGTH = 16_384;

export const LeasePayloadSchema = z.object({
  v: z.literal(1),
  lease_id: z.string().regex(UUID_PATTERN),
  run_id: z.string().regex(UUID_PATTERN),
  job_id: z.string().trim().min(1).max(256),
  cycle: z.number().int().nonnegative(),
  actor_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  expires_at: z.string().regex(RFC3339_UTC),
  nonce: z.string().regex(NONCE_PATTERN),
}).strict();

export type LeasePayload = z.infer<typeof LeasePayloadSchema>;

export type LeaseErrorCode = 'INVALID_LEASE' | 'EXPIRED_LEASE';

export interface LeaseVerificationOptions {
  /** Internal runtime settlement may close a timed-out process after expiry. */
  readonly allowExpired?: boolean;
}

export class LeaseError extends Error {
  public override readonly name = 'LeaseError';

  public constructor(
    public readonly code: LeaseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function canonicalPayload(payload: LeasePayload): string {
  return JSON.stringify({
    v: payload.v,
    lease_id: payload.lease_id,
    run_id: payload.run_id,
    job_id: payload.job_id,
    cycle: payload.cycle,
    actor_id: payload.actor_id,
    expires_at: payload.expires_at,
    nonce: payload.nonce,
  });
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: string): Buffer {
  if (value === '' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new LeaseError('INVALID_LEASE', 'The run lease encoding is invalid.');
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    throw new LeaseError('INVALID_LEASE', 'The run lease encoding is invalid.');
  }
}

function validExpiry(expiresAt: string, nowMs: number): void {
  if (!RFC3339_UTC.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) {
    throw new LeaseError('INVALID_LEASE', 'The run lease expiry is invalid.');
  }
  if (Date.parse(expiresAt) <= nowMs) {
    throw new LeaseError('EXPIRED_LEASE', 'The run lease has expired.');
  }
}

/** Creates the canonical opaque lease delivered only to the assigned worker. */
export function issueLease(
  input: Omit<LeasePayload, 'v' | 'nonce'> & { readonly nonce?: string },
  key: Buffer,
): { readonly payload: LeasePayload; readonly token: string } {
  if (key.byteLength !== 32) throw new LeaseError('INVALID_LEASE', 'The lease key has an invalid size.');
  const parsed = LeasePayloadSchema.parse({
    v: 1,
    lease_id: input.lease_id,
    run_id: input.run_id,
    job_id: input.job_id,
    cycle: input.cycle,
    actor_id: input.actor_id,
    expires_at: input.expires_at,
    nonce: input.nonce ?? randomBytes(32).toString('hex'),
  });
  const payloadBytes = Buffer.from(canonicalPayload(parsed), 'utf8');
  const mac = createHmac('sha256', key).update(payloadBytes).digest();
  const token = `${encode(payloadBytes)}.${encode(mac)}`;
  if (token.length > MAX_LEASE_LENGTH) throw new LeaseError('INVALID_LEASE', 'The run lease is oversized.');
  return { payload: parsed, token };
}

/** Verifies and decodes a lease without exposing the signing key. */
export function verifyLease(
  token: string,
  key: Buffer,
  nowMs = Date.now(),
  options: LeaseVerificationOptions = {},
): LeasePayload {
  if (key.byteLength !== 32 || typeof token !== 'string' || token.length > MAX_LEASE_LENGTH) {
    throw new LeaseError('INVALID_LEASE', 'The run lease is invalid.');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw new LeaseError('INVALID_LEASE', 'The run lease is invalid.');
  const payloadPart = parts[0];
  const macPart = parts[1];
  if (payloadPart === undefined || macPart === undefined) {
    throw new LeaseError('INVALID_LEASE', 'The run lease is invalid.');
  }
  const payloadBytes = decode(payloadPart);
  const presentedMac = decode(macPart);
  if (presentedMac.byteLength !== 32) throw new LeaseError('INVALID_LEASE', 'The run lease is invalid.');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    throw new LeaseError('INVALID_LEASE', 'The run lease is invalid.');
  }
  const parsed = LeasePayloadSchema.safeParse(parsedJson);
  if (!parsed.success || canonicalPayload(parsed.data) !== payloadBytes.toString('utf8')) {
    throw new LeaseError('INVALID_LEASE', 'The run lease is invalid.');
  }

  const expectedMac = createHmac('sha256', key).update(payloadBytes).digest();
  if (!timingSafeEqual(expectedMac, presentedMac)) {
    throw new LeaseError('INVALID_LEASE', 'The run lease is invalid.');
  }
  if (options.allowExpired === true) {
    if (!RFC3339_UTC.test(parsed.data.expires_at) || !Number.isFinite(Date.parse(parsed.data.expires_at))) {
      throw new LeaseError('INVALID_LEASE', 'The run lease expiry is invalid.');
    }
  } else {
    validExpiry(parsed.data.expires_at, nowMs);
  }
  return parsed.data;
}

/** Creates server-owned identifiers and a run-scoped lease payload. */
export function createLeaseMaterial(
  actorId: string,
  jobId: string,
  cycle: number,
  expiresAt: string,
  key: Buffer,
): { readonly leaseId: string; readonly runId: string; readonly nonce: string; readonly token: string } {
  const leaseId = randomUUID();
  const runId = randomUUID();
  const nonce = randomBytes(32).toString('hex');
  const issued = issueLease({
    lease_id: leaseId,
    run_id: runId,
    job_id: jobId,
    cycle,
    actor_id: actorId,
    expires_at: expiresAt,
    nonce,
  }, key);
  return { leaseId, runId, nonce, token: issued.token };
}
