/** Process exit codes. Small, stable contract shared by every command. */
export const EXIT_OK = 0;
/** An unexpected internal failure (a bug, or an unhandled OS condition). */
export const EXIT_INTERNAL = 1;
/** The caller invoked the CLI incorrectly. */
export const EXIT_USAGE = 2;
/** A security invariant failed. The operation was refused; nothing was repaired. */
export const EXIT_SECURITY = 3;

/** The caller invoked the CLI incorrectly. */
export class UsageError extends Error {
  public override readonly name = 'UsageError';
}

/**
 * A security invariant failed.
 *
 * Throwing this is always fail-closed: the caller refuses the operation rather
 * than continuing, repairing, or reading secret material. Messages must be
 * actionable and must never carry secret bytes.
 */
export class SecurityError extends Error {
  public override readonly name = 'SecurityError';

  public constructor(
    message: string,
    public readonly remedy?: string,
  ) {
    super(message);
  }
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof SecurityError) return EXIT_SECURITY;
  return EXIT_INTERNAL;
}
