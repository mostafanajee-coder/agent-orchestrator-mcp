import type { CommandContext } from './context.js';
import { runDoctor } from './doctor.js';
import { SecurityError } from '../errors.js';

/**
 * The fail-closed startup gate for long-lived MCP transports.
 *
 * This deliberately reuses the structured Phase 1 doctor checks. It never
 * parses human-readable output and it never calls init, hardens a path, or
 * opens the lease key.
 */
export function assertPhase1Ready(context: CommandContext): void {
  const report = runDoctor(context);
  if (report.ok) return;

  const failures = report.checks
    .filter((check) => check.status === 'fail')
    .map((check) => `${check.name}: ${check.detail}`)
    .join('; ');
  throw new SecurityError(
    `MCP serve refused because Phase 1 security verification failed: ${failures}`,
    'Run node dist/index.js init, resolve every reported security failure, and retry serve. No state was repaired automatically.',
  );
}
