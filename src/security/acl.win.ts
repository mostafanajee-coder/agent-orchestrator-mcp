import { SecurityError } from '../errors.js';
import type { CommandRunner } from './exec.js';
import { evaluateDescriptor } from './sddl.js';
import type { AclReport, PathKind, SecurityProvider } from './provider.js';
import type { SystemToolPaths } from './systemTools.js';
import { resolveSystemTools } from './systemTools.js';

/**
 * Environment variable used to hand a path to PowerShell.
 *
 * The PowerShell script is a fixed constant; the path travels in the
 * environment and is never concatenated into the command, so a path can never
 * be interpreted as script syntax.
 */
export const TARGET_PATH_VARIABLE = 'AGENT_ORCHESTRATOR_ACL_TARGET';

const CURRENT_USER_SID_SCRIPT = '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value';

/**
 * Reads the security descriptor through the .NET API rather than the `Get-Acl`
 * cmdlet.
 *
 * `Get-Acl` lives in the Microsoft.PowerShell.Security module, and a machine
 * whose extended type data for that module is damaged cannot autoload it --
 * every cmdlet in it, `Get-ExecutionPolicy` included, then fails. The .NET
 * call needs no module, no execution policy, and no PowerShell type data, and
 * returns exactly the same SDDL. Both branches are needed because the
 * directory and file APIs are distinct. This targets Windows PowerShell 5.1
 * (.NET Framework), which is the interpreter resolved by systemTools.
 */
const READ_SDDL_SCRIPT = [
  `$p = $env:${TARGET_PATH_VARIABLE};`,
  'if ([System.IO.Directory]::Exists($p))',
  "{ [System.IO.Directory]::GetAccessControl($p).GetSecurityDescriptorSddlForm('Owner,Group,Access') }",
  "else { [System.IO.File]::GetAccessControl($p).GetSecurityDescriptorSddlForm('Owner,Group,Access') }",
].join(' ');

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command'] as const;

/** Builds the icacls argument vector. Exported so tests can assert its shape. */
export function buildIcaclsArgs(path: string, kind: PathKind, sid: string): string[] {
  // `*<SID>` makes icacls treat the principal as a SID, so the command never
  // depends on a localized account name.
  const grant = kind === 'directory' ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  return [path, '/inheritance:r', '/grant:r', grant];
}

export interface WindowsSecurityProviderOptions {
  readonly runner: CommandRunner;
  readonly systemRoot?: string | undefined;
  /**
   * Pre-resolved tool paths.
   *
   * A constructor seam for tests only, so the Windows ACL logic can be
   * exercised on a non-Windows CI machine where no real `icacls.exe` exists.
   * Production construction goes through `createSecurityProvider`, which never
   * supplies this, so the fail-closed resolution below always applies. This is
   * not a PATH fallback: nothing here consults PATH.
   */
  readonly tools?: SystemToolPaths | undefined;
}

/**
 * Windows enforcement: a protected DACL whose only allow entry is the current
 * user's SID, on a path owned by the current user.
 *
 * Applied with `icacls` (argv array, SID form) and verified by reading the
 * security descriptor as SDDL, which reports identities as SIDs rather than
 * localized names, so validation does not depend on the Windows display
 * language.
 */
export class WindowsSecurityProvider implements SecurityProvider {
  public readonly kind = 'windows';

  private readonly runner: CommandRunner;
  private readonly systemRoot: string | undefined;
  private cachedTools: SystemToolPaths | undefined;
  private cachedSid: string | undefined;

  public constructor(options: WindowsSecurityProviderOptions) {
    this.runner = options.runner;
    this.systemRoot = options.systemRoot;
    this.cachedTools = options.tools;
  }

  /**
   * Resolved lazily so that a broken Windows installation surfaces as a
   * reported check failure rather than a constructor crash. There is no PATH
   * fallback: if the absolute executable cannot be proven, this throws.
   */
  private tools(): SystemToolPaths {
    this.cachedTools ??= resolveSystemTools(this.systemRoot);
    return this.cachedTools;
  }

  public subject(): string {
    if (this.cachedSid !== undefined) return this.cachedSid;

    const result = this.runner.run(this.tools().powershell, [
      ...POWERSHELL_ARGS,
      CURRENT_USER_SID_SCRIPT,
    ]);
    const sid = result.stdout.trim();
    if (result.status !== 0 || !/^S-1-[0-9-]+$/.test(sid)) {
      throw new SecurityError(
        'Could not determine the current Windows user SID, so path protection cannot be proven.',
        'Ensure Windows PowerShell 5.1 is present under SystemRoot.',
      );
    }

    this.cachedSid = sid;
    return sid;
  }

  public describe(): string {
    return 'Windows DACL: owned by the current user, inheritance removed, exactly one full-access allow entry for the current user SID, verified via SDDL';
  }

  public harden(path: string, kind: PathKind): void {
    const result = this.runner.run(this.tools().icacls, buildIcaclsArgs(path, kind, this.subject()));
    if (result.status !== 0) {
      throw new SecurityError(
        `Failed to apply an owner-only DACL to ${path}.`,
        `icacls exited with status ${String(result.status)}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  /** Reads the security descriptor as SDDL. Fails closed when unreadable. */
  public readSddl(path: string): string {
    const result = this.runner.run(
      this.tools().powershell,
      [...POWERSHELL_ARGS, READ_SDDL_SCRIPT],
      { [TARGET_PATH_VARIABLE]: path },
    );
    const sddl = result.stdout.trim();
    if (result.status !== 0 || sddl === '') {
      throw new SecurityError(
        `Could not read the security descriptor of ${path}, so its protection cannot be proven.`,
        result.stderr.trim() || 'Check that the path exists and is readable by the current user.',
      );
    }
    return sddl;
  }

  public verify(path: string, kind: PathKind): AclReport {
    const sddl = this.readSddl(path);
    const evaluation = evaluateDescriptor(sddl, this.subject(), kind);
    return {
      path,
      kind,
      secure: evaluation.secure,
      problems: evaluation.problems,
      detail: evaluation.secure
        ? 'owner-only protected DACL, single full-access entry'
        : 'DACL does not match the required owner-only policy',
    };
  }
}
