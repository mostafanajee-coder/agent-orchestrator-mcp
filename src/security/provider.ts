export type PathKind = 'directory' | 'file';

export interface AclReport {
  readonly path: string;
  readonly kind: PathKind;
  readonly secure: boolean;
  readonly problems: readonly string[];
  /** Secret-free description of the protection actually found on the path. */
  readonly detail: string;
}

/**
 * Platform-specific enforcement of "only the current user may reach this path".
 *
 * Implementations must be fail-closed: if protection cannot be proven, they
 * throw rather than reporting success.
 */
export interface SecurityProvider {
  readonly kind: 'windows' | 'posix';
  /** The single identity permitted to access state-root paths. */
  subject(): string;
  /** One-line description of the enforced model, for doctor output and docs. */
  describe(): string;
  harden(path: string, kind: PathKind): void;
  verify(path: string, kind: PathKind): AclReport;
}
