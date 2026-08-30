import { lstatSync, type Stats } from 'node:fs';

import { SecurityError } from '../errors.js';
import { inspectPathSafety } from '../security/pathSafety.js';
import type { CommandContext } from '../commands/context.js';

export type DatabaseFileCheckStatus = 'pass' | 'warn' | 'fail';

export interface DatabaseFileCheck {
  readonly name: string;
  readonly status: DatabaseFileCheckStatus;
  readonly detail: string;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SecurityError(
      'Could not inspect authoritative database path ' + path + '.',
      'Check that the path is reachable and retry. No database mutation was attempted.',
    );
  }
}

function metadata(stat: Stats): string {
  return 'size=' + String(stat.size) + ' bytes, mtimeMs=' + String(stat.mtimeMs);
}

function inspectDatabaseFile(
  context: CommandContext,
  path: string,
  name: string,
  required: boolean,
): DatabaseFileCheck {
  const stat = lstatIfPresent(path);
  if (stat === undefined) {
    return required
      ? {
          name,
          status: 'warn',
          detail: name + '=ABSENT; not initialized; no database file was created',
        }
      : {
          name,
          status: 'pass',
          detail: name + '=ABSENT; no sidecar was created',
        };
  }

  const safety = inspectPathSafety(path, 'file', context.platform);
  if (!safety.safe) {
    return {
      name,
      status: 'fail',
      detail: name + '=FAIL; ' + (safety.problem ?? 'database path is unsafe'),
    };
  }

  try {
    const security = context.security.verify(path, 'file');
    if (!security.secure) {
      return {
        name,
        status: 'fail',
        detail: name + '=FAIL; ' + security.problems.join('; '),
      };
    }
    return {
      name,
      status: 'pass',
      detail: name + '=PASS; regular file; ' + metadata(stat),
    };
  } catch (cause) {
    return {
      name,
      status: 'fail',
      detail:
        name +
        '=FAIL; ' +
        (cause instanceof Error ? cause.message : 'file protection could not be verified'),
    };
  }
}

/**
 * Revision 6 doctor contract (retaining the Revision 5 boundary): only filesystem/security inspection. This
 * module deliberately has no SQLite import and never opens the DB or sidecars.
 */
export function inspectDatabaseFilesForDoctor(context: CommandContext): DatabaseFileCheck[] {
  const { layout } = context;
  return [
    inspectDatabaseFile(context, layout.database, 'DB_FILE_SECURITY', true),
    inspectDatabaseFile(context, layout.databaseWal, 'DB_WAL_SECURITY', false),
    inspectDatabaseFile(context, layout.databaseShm, 'DB_SHM_SECURITY', false),
    {
      name: 'DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN',
      status: 'warn',
      detail:
        'No SQLite opener, SQL, PRAGMA, migration, checkpoint, repair, or row inspection is performed by doctor.',
    },
  ];
}
