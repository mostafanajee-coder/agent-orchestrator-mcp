import type { AclReport, PathKind, SecurityProvider } from '../../src/security/provider.js';

export interface HardenCall {
  readonly path: string;
  readonly kind: PathKind;
}

/**
 * An in-memory SecurityProvider.
 *
 * A path counts as protected only once it has been hardened, which lets tests
 * assert the ordering invariant that secrets are never written into a
 * directory whose protection has not yet been applied and proven.
 */
export class FakeSecurityProvider implements SecurityProvider {
  public readonly kind = 'posix';
  public readonly hardened: HardenCall[] = [];
  public readonly verified: string[] = [];
  public readonly forcedInsecure = new Set<string>();
  public readonly verifyThrows = new Set<string>();

  private readonly protectedPaths = new Set<string>();

  public subject(): string {
    return 'test-subject';
  }

  public describe(): string {
    return 'fake security provider';
  }

  public harden(path: string, kind: PathKind): void {
    this.hardened.push({ path, kind });
    this.protectedPaths.add(path);
  }

  public verify(path: string, kind: PathKind): AclReport {
    this.verified.push(path);
    if (this.verifyThrows.has(path)) {
      throw new Error(`verification unavailable for ${path}`);
    }

    const problems: string[] = [];
    if (this.forcedInsecure.has(path)) problems.push('grants access to the broad identity Everyone');
    else if (!this.protectedPaths.has(path)) problems.push('inheritance from the parent directory is not blocked');

    return {
      path,
      kind,
      secure: problems.length === 0,
      problems,
      detail: problems.length === 0 ? 'protected (fake)' : 'unprotected (fake)',
    };
  }

  /** True when `path` was hardened before `other` was first touched. */
  public hardenedBefore(path: string, other: string): boolean {
    const first = this.hardened.findIndex((call) => call.path === path);
    const second = this.hardened.findIndex((call) => call.path === other);
    return first !== -1 && (second === -1 || first < second);
  }
}
