import { existsSync } from 'node:fs';

import { assertStateRootNotSynced } from '../config/cloudSync.js';
import { stateDirectories } from '../config/stateRoot.js';
import { SecurityError } from '../errors.js';
import { inspectLeaseKey, LEASE_KEY_BYTES } from '../secrets/leaseKey.js';
import { inspectPathSafety } from '../security/pathSafety.js';
import type { CommandContext } from './context.js';

export type CheckStatus = 'pass' | 'fail';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly stateRoot: string;
  readonly securityModel: string;
  readonly subject: string;
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

/**
 * Read-only Phase 1 health check.
 *
 * It inspects and reports; it never creates, hardens, or repairs anything, and
 * it never opens the lease key. Checks cover only what Phase 1 implements —
 * there is no database, actor, or MCP check to run yet.
 */
export function runDoctor(context: CommandContext): DoctorReport {
  const { layout, security } = context;
  const checks: DoctorCheck[] = [];

  checks.push(cloudSyncCheck(context));

  for (const directory of stateDirectories(layout)) {
    checks.push(pathCheck(context, directory, 'directory'));
  }

  checks.push(leaseKeyCheck(context));

  let subject: string;
  try {
    subject = security.subject();
  } catch (cause) {
    subject = cause instanceof Error ? `unavailable (${cause.message})` : 'unavailable';
  }

  return {
    stateRoot: layout.root,
    securityModel: security.describe(),
    subject,
    checks,
    ok: checks.every((check) => check.status === 'pass'),
  };
}

function cloudSyncCheck(context: CommandContext): DoctorCheck {
  try {
    assertStateRootNotSynced(context.layout.root, context.cloudSync);
    return {
      name: 'cloud-sync safety',
      status: 'pass',
      detail: 'the state root is not inside a known cloud-synchronised directory',
    };
  } catch (cause) {
    return {
      name: 'cloud-sync safety',
      status: 'fail',
      detail: cause instanceof SecurityError ? cause.message : 'the cloud-sync check could not be completed',
    };
  }
}

function pathCheck(
  context: CommandContext,
  path: string,
  kind: 'directory' | 'file',
): DoctorCheck {
  const name = `${kind} ${path}`;
  if (!existsSync(path)) {
    return { name, status: 'fail', detail: 'missing — run init' };
  }

  // Path safety first: a link or junction is reported as such rather than
  // having its target's protection reported as if it were this path's.
  const safety = inspectPathSafety(path, kind, context.platform, {
    allowRedirectionBoundary: path === context.layout.root,
  });
  if (!safety.safe) {
    return { name, status: 'fail', detail: safety.problem ?? 'path is unsafe' };
  }

  try {
    const report = context.security.verify(path, kind);
    return report.secure
      ? { name, status: 'pass', detail: report.detail }
      : { name, status: 'fail', detail: report.problems.join('; ') };
  } catch (cause) {
    return {
      name,
      status: 'fail',
      detail: cause instanceof Error ? cause.message : 'protection could not be verified',
    };
  }
}

function leaseKeyCheck(context: CommandContext): DoctorCheck {
  const name = `lease key ${context.layout.leaseKey}`;
  try {
    const status = inspectLeaseKey(context.layout.leaseKey, context.security);
    if (!status.present) {
      return { name, status: 'fail', detail: 'missing — run init' };
    }
    if (!status.secure) {
      return { name, status: 'fail', detail: status.problems.join('; ') };
    }
    // Size only. The key itself is never read.
    return {
      name,
      status: 'pass',
      detail: `present, protected, exactly ${String(status.sizeBytes)} bytes (required ${String(LEASE_KEY_BYTES)})`,
    };
  } catch (cause) {
    return {
      name,
      status: 'fail',
      detail: cause instanceof Error ? cause.message : 'the lease key could not be inspected',
    };
  }
}
