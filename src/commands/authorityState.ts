import { randomUUID } from 'node:crypto';

import type { CommandContext } from './context.js';
import { openPhase4ManagementRuntime } from '../authority/runtime.js';
import {
  AUTHORIZATION_STATE_VERSION,
  AuthorizationStateManager,
  createAuthorizationStateDocument,
  inspectAuthorizationState,
  readAuthorizationStateDocument,
  writeAuthorizationState,
  type AuthorizationReadiness,
  type AuthorizationStateFileSystem,
  type AuthorizationStateOptions,
  type AuthorizationStateStatus,
} from '../authority/authorizationState.js';
import { SecurityError } from '../errors.js';
import { acquireCanonicalRuntimeOwnership, type RuntimeOwnership } from '../runtime/ownership.js';

export const AUTHORITY_STATE_REASONS = [
  'restore',
  'clock_recovery',
  'security_rotation',
  'manual',
] as const;

export type AuthorityStateReason = (typeof AUTHORITY_STATE_REASONS)[number];

export type AuthorityStateCommandOptions =
  | { readonly action: 'init' }
  | { readonly action: 'status' }
  | { readonly action: 'rotate'; readonly reason: AuthorityStateReason };

export interface AuthorityStateCommandResult {
  readonly action: AuthorityStateCommandOptions['action'];
  readonly path: string;
  readonly readiness: AuthorizationReadiness;
  readonly epochFingerprint: string | null;
  readonly clockHighWaterMs: number | null;
  readonly effectiveNowMs: number | null;
  readonly reason: AuthorityStateReason | null;
  readonly auditRecorded: boolean;
  readonly warning: string | null;
}

export interface AuthorityStateCommandDependencies {
  readonly clock?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly fileSystem?: AuthorizationStateFileSystem;
  readonly acquireOwnership?: () => Promise<RuntimeOwnership>;
  readonly openRuntime?: typeof openPhase4ManagementRuntime;
}

function stateOptions(
  context: CommandContext,
  dependencies: AuthorityStateCommandDependencies,
): AuthorizationStateOptions {
  return {
    path: context.layout.authorizationStateFile,
    security: context.security,
    platform: context.platform,
    clock: dependencies.clock ?? (() => Date.now()),
    ...(dependencies.randomBytes === undefined ? {} : { randomBytes: dependencies.randomBytes }),
    ...(dependencies.fileSystem === undefined ? {} : { fileSystem: dependencies.fileSystem }),
  };
}

function currentTime(clock: () => number): number {
  let now: number;
  try {
    now = clock();
  } catch {
    throw new SecurityError(
      'The system clock could not be read, so authorization state was not changed.',
      'Run from a normal session with a readable wall clock. No state was changed.',
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new SecurityError(
      'The system clock is invalid, so authorization state was not changed.',
      'Run from a normal session with a valid wall clock. No state was changed.',
    );
  }
  return now;
}

function timestamp(nowMs: number): string {
  try {
    return new Date(nowMs).toISOString();
  } catch {
    throw new SecurityError(
      'The system clock cannot be represented as an audit timestamp.',
      'Use a normal wall-clock value and retry. No state was changed.',
    );
  }
}

function resultFromStatus(
  action: AuthorityStateCommandOptions['action'],
  path: string,
  status: AuthorizationStateStatus,
  reason: AuthorityStateReason | null,
  auditRecorded = false,
  warning: string | null = null,
): AuthorityStateCommandResult {
  return {
    action,
    path,
    readiness: status.readiness,
    epochFingerprint: status.epochFingerprint,
    clockHighWaterMs: status.clockHighWaterMs,
    effectiveNowMs: status.effectiveNowMs,
    reason,
    auditRecorded,
    warning,
  };
}

function auditStateChange(
  runtime: ReturnType<typeof openPhase4ManagementRuntime>,
  action: 'authorization.state_initialized' | 'authorization.epoch_rotated' | 'authorization.clock_recovered',
  reason: AuthorityStateReason | null,
  epochFingerprint: string,
  nowMs: number,
): string | null {
  try {
    runtime.audit.append({
      actorId: 'system',
      actorRole: 'system',
      requestId: randomUUID(),
      action,
      subjectType: 'authorization_state',
      subjectId: 'authorization-state.v1.json',
      result: 'ok',
      detail: {
        reason,
        epoch_fingerprint: epochFingerprint,
      },
      timestamp: timestamp(nowMs),
    });
    return null;
  } catch {
    return 'authorization state committed, but the audit event could not be recorded';
  }
}

function allowedRecoveryReason(reason: AuthorityStateReason): boolean {
  return reason === 'restore' || reason === 'clock_recovery';
}

async function mutateState(
  context: CommandContext,
  options: Extract<AuthorityStateCommandOptions, { readonly action: 'init' | 'rotate' }>,
  dependencies: AuthorityStateCommandDependencies,
): Promise<AuthorityStateCommandResult> {
  const acquireOwnership = dependencies.acquireOwnership ?? acquireCanonicalRuntimeOwnership;
  const ownership = await acquireOwnership();
  let runtime: ReturnType<typeof openPhase4ManagementRuntime> | undefined;
  try {
    const runtimeFactory = dependencies.openRuntime ?? openPhase4ManagementRuntime;
    runtime = runtimeFactory(context);
    const fileOptions = stateOptions(context, dependencies);
    const nowMs = currentTime(dependencies.clock ?? (() => Date.now()));
    const manager = new AuthorizationStateManager(fileOptions);
    const before = manager.inspect(nowMs);

    if (options.action === 'init') {
      if (before.readiness !== 'UNINITIALIZED') {
        throw new SecurityError(
          'Authorization state is already present; initialization refused to overwrite it.',
          'Use the explicit rotate operation when a new epoch is intended. No state was changed.',
        );
      }
    } else if (before.readiness !== 'READY' && !allowedRecoveryReason(options.reason)) {
      throw new SecurityError(
        'The current authorization state is not ready for this rotation reason.',
        'Use reason restore or clock_recovery for explicit recovery. No state was changed.',
      );
    }

    const document = createAuthorizationStateDocument(nowMs, fileOptions.randomBytes);
    writeAuthorizationState(
      { ...fileOptions, replace: options.action === 'rotate' },
      document,
    );
    const after = manager.inspect(nowMs);
    if (after.readiness !== 'READY') {
      throw new SecurityError(
        'Authorization state was written but could not be verified as ready.',
        'Inspect the state file and do not enable delegated authority. No automatic repair was performed.',
      );
    }

    const auditWarning = auditStateChange(
      runtime,
      options.action === 'init'
        ? 'authorization.state_initialized'
        : options.reason === 'clock_recovery'
          ? 'authorization.clock_recovered'
          : 'authorization.epoch_rotated',
      options.action === 'init' ? null : options.reason,
      after.epochFingerprint ?? '',
      nowMs,
    );
    return resultFromStatus(
      options.action,
      fileOptions.path,
      after,
      options.action === 'init' ? null : options.reason,
      auditWarning === null,
      auditWarning,
    );
  } finally {
    runtime?.close();
    await ownership.close();
  }
}

export async function runAuthorityStateCommand(
  context: CommandContext,
  options: AuthorityStateCommandOptions,
  dependencies: AuthorityStateCommandDependencies = {},
): Promise<AuthorityStateCommandResult> {
  if (options.action === 'status') {
    const fileOptions = stateOptions(context, dependencies);
    const status = inspectAuthorizationState(fileOptions);
    return resultFromStatus('status', fileOptions.path, status, null);
  }
  return mutateState(context, options, dependencies);
}

export function isAuthorityStateReason(value: string): value is AuthorityStateReason {
  return (AUTHORITY_STATE_REASONS as readonly string[]).includes(value);
}

export function assertAuthorityStateVersion(): typeof AUTHORIZATION_STATE_VERSION {
  return AUTHORIZATION_STATE_VERSION;
}

export function readAuthorityStateForCommand(
  context: CommandContext,
  dependencies: AuthorityStateCommandDependencies = {},
): ReturnType<typeof readAuthorizationStateDocument> {
  return readAuthorizationStateDocument(stateOptions(context, dependencies));
}
