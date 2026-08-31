import type { CommandContext } from '../commands/context.js';
import { assertPhase4Ready } from '../authority/runtime.js';

/** Compatibility entry point; production serving now requires the Phase 4 gate. */
export function assertDatabaseReadyForServe(context: CommandContext): void {
  assertPhase4Ready(context);
}
