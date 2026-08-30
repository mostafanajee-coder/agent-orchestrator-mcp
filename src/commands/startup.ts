import type { CommandContext } from './context.js';
import { runDoctor } from './doctor.js';
import { SecurityError } from '../errors.js';
import { assertDatabaseReadyForServe } from '../store/serve.js';

/**
 * The fail-closed startup gate for long-lived MCP transports.
 *
 * The doctor portion is filesystem-only. Deep SQLite integrity is checked
 * separately for serve after the doctor-owned security checks pass.
 */
export function assertServeReady(context: CommandContext): void {
  const report = runDoctor(context);
  if (!report.ok) {
    const failures = report.checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.name + ': ' + check.detail)
      .join('; ');
    throw new SecurityError(
      'MCP serve refused because Phase 1 security verification failed: ' + failures,
      'Run node dist/index.js init, resolve every reported security failure, and retry serve. No state was repaired automatically.',
    );
  }

  try {
    assertDatabaseReadyForServe(context);
  } catch (cause) {
    if (cause instanceof SecurityError) {
      throw new SecurityError(
        'MCP serve refused because Phase 3 database verification failed: ' + cause.message,
        cause.remedy ?? 'Inspect the authoritative database and retry serve.',
      );
    }
    throw cause;
  }
}

/** Backward-compatible internal name retained for Phase 2 callers. */
export const assertPhase1Ready = assertServeReady;
