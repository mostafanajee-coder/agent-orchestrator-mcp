import type { CommandContext } from './context.js';
import { openPhase4Runtime } from '../authority/runtime.js';

/**
 * The fail-closed startup gate for long-lived MCP transports.
 *
 * The doctor portion remains filesystem-only. Phase 4 then verifies the
 * authoritative schema, audit chain, actor state, and persistent auth before
 * the caller creates a transport.
 */
export function assertServeReady(context: CommandContext): void {
  const runtime = openPhase4Runtime(context);
  runtime.close();
}

/** Retained as a compatibility alias for existing internal tests/callers. */
export const assertPhase1Ready = assertServeReady;
