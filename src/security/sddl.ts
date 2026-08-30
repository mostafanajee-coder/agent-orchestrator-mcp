/**
 * A strict SDDL reader used to prove, by SID, exactly who can reach a path.
 *
 * `icacls` prints *localized* account names, so its output cannot be validated
 * reliably across Windows display languages. SDDL carries raw SIDs and a fixed
 * set of two-letter aliases instead, so parsing it is locale-independent.
 *
 * The policy here deliberately does NOT compute Windows effective permissions.
 * It requires the descriptor to match the narrow canonical shape our own
 * hardening produces, and rejects everything else. Anything the parser cannot
 * fully understand is a failure, never a pass.
 */

/** Well-known SDDL trustee aliases, mapped to SID and a readable name. */
const WELL_KNOWN_TRUSTEES: Readonly<Record<string, { sid: string; label: string }>> = {
  WD: { sid: 'S-1-1-0', label: 'Everyone' },
  BU: { sid: 'S-1-5-32-545', label: 'BUILTIN\\Users' },
  BA: { sid: 'S-1-5-32-544', label: 'BUILTIN\\Administrators' },
  AU: { sid: 'S-1-5-11', label: 'Authenticated Users' },
  IU: { sid: 'S-1-5-4', label: 'INTERACTIVE' },
  NU: { sid: 'S-1-5-2', label: 'NETWORK' },
  AN: { sid: 'S-1-5-7', label: 'ANONYMOUS LOGON' },
  SY: { sid: 'S-1-5-18', label: 'LOCAL SYSTEM' },
  CO: { sid: 'S-1-3-0', label: 'CREATOR OWNER' },
  WO: { sid: 'S-1-3-4', label: 'OWNER RIGHTS' },
  WR: { sid: 'S-1-5-33', label: 'WRITE RESTRICTED' },
};

/** Identities that must never appear on a state-root path. */
const BROAD_TRUSTEE_SIDS: Readonly<Record<string, string>> = {
  'S-1-1-0': 'Everyone',
  'S-1-5-32-545': 'BUILTIN\\Users',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-4': 'INTERACTIVE',
  'S-1-5-2': 'NETWORK',
  'S-1-5-7': 'ANONYMOUS LOGON',
};

/** The only ACE type accepted: a plain ALLOW entry, as icacls produces. */
const ACCESS_ALLOWED = 'A';

/** `FA` is what icacls emits for full access; the numeric form is equivalent. */
const FULL_ACCESS_RIGHTS = new Set(['FA', '0X1F01FF']);

/** ACE flags a canonical directory entry carries, and nothing else. */
const DIRECTORY_ACE_FLAGS = new Set(['OI', 'CI']);

/** Every ACE flag token this parser recognises. An unknown token is fatal. */
const KNOWN_ACE_FLAGS = new Set(['CI', 'OI', 'NP', 'IO', 'ID', 'SA', 'FA']);

/**
 * DACL control tokens this parser understands.
 *
 * `P` = protected (inheritance blocked), `AI` = auto-inherited,
 * `AR` = auto-inherit-required. Anything outside this set is unparsed syntax
 * and is rejected rather than ignored.
 */
const KNOWN_CONTROL_FLAGS = ['AI', 'AR', 'P'] as const;

/** Control tokens our policy permits on a canonical descriptor. */
const PERMITTED_CONTROL_FLAGS = new Set(['P', 'AI']);

/** The number of fields in an ordinary ACE. Conditional/resource ACEs differ. */
const ACE_FIELD_COUNT = 6;

/**
 * Splits a DACL control string into known tokens.
 *
 * Returns undefined on anything unrecognised, so `PXYZ`, `Q`, and `PAIX` are
 * failures rather than "contains a P, good enough".
 */
export function parseControlTokens(flags: string): readonly string[] | undefined {
  const tokens: string[] = [];
  let index = 0;

  while (index < flags.length) {
    const match = KNOWN_CONTROL_FLAGS.find((token) => flags.startsWith(token, index));
    if (match === undefined) return undefined;
    tokens.push(match);
    index += match.length;
  }

  return tokens;
}

export type PathShape = 'directory' | 'file';

export interface SddlAce {
  readonly type: string;
  readonly flagTokens: readonly string[];
  readonly rights: string;
  readonly trustee: string;
  readonly trusteeSid: string;
  readonly label: string;
  readonly inherited: boolean;
}

export interface ParsedDacl {
  readonly isProtected: boolean;
  readonly autoInherited: boolean;
  /** Every control token found, each one recognised. */
  readonly controlTokens: readonly string[];
  readonly aces: readonly SddlAce[];
}

export interface ParsedDescriptor {
  readonly ownerSid: string | undefined;
  readonly dacl: ParsedDacl | null;
}

export type ParseResult =
  | { readonly ok: true; readonly descriptor: ParsedDescriptor }
  | { readonly ok: false; readonly reason: string };

export function resolveTrustee(token: string): { sid: string; label: string } {
  const wellKnown = WELL_KNOWN_TRUSTEES[token];
  if (wellKnown !== undefined) return { sid: wellKnown.sid, label: wellKnown.label };
  const broad = BROAD_TRUSTEE_SIDS[token];
  if (broad !== undefined) return { sid: token, label: broad };
  return { sid: token, label: token };
}

/** Splits an ACE flag string into two-character tokens, rejecting odd lengths. */
function parseFlagTokens(flags: string): readonly string[] | undefined {
  if (flags === '') return [];
  if (flags.length % 2 !== 0) return undefined;
  const tokens: string[] = [];
  for (let i = 0; i < flags.length; i += 2) {
    const token = flags.slice(i, i + 2).toUpperCase();
    if (!KNOWN_ACE_FLAGS.has(token)) return undefined;
    tokens.push(token);
  }
  return tokens;
}

/** Finds a top-level section marker such as `O:` or `D:`, ignoring ACE bodies. */
function findSection(sddl: string, letter: string): number {
  let depth = 0;
  for (let i = 0; i < sddl.length - 1; i += 1) {
    const char = sddl[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && char === letter && sddl[i + 1] === ':') return i + 2;
  }
  return -1;
}

function readSectionBody(sddl: string, start: number): string {
  let depth = 0;
  for (let i = start; i < sddl.length; i += 1) {
    const char = sddl[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && /[OGDS]/.test(char ?? '') && sddl[i + 1] === ':') {
      return sddl.slice(start, i);
    }
  }
  return sddl.slice(start);
}

/**
 * Parses a security descriptor, failing on anything it cannot fully model.
 *
 * A malformed or unsupported construct must never be silently skipped: a
 * skipped ACE could be the one granting access to everyone.
 */
export function parseDescriptor(sddl: string): ParseResult {
  const trimmed = sddl.trim();
  if (trimmed === '') return { ok: false, reason: 'the security descriptor is empty' };

  const ownerStart = findSection(trimmed, 'O');
  const ownerToken = ownerStart === -1 ? undefined : readSectionBody(trimmed, ownerStart).trim();
  // Resolve aliases so an owner written as `BA` is compared as a SID.
  const ownerSid =
    ownerToken === undefined || ownerToken === '' ? undefined : resolveTrustee(ownerToken).sid;

  const daclStart = findSection(trimmed, 'D');
  if (daclStart === -1) {
    return { ok: true, descriptor: { ownerSid, dacl: null } };
  }

  const body = readSectionBody(trimmed, daclStart);
  const firstParen = body.indexOf('(');
  const flags = (firstParen === -1 ? body : body.slice(0, firstParen)).trim();

  if (flags.includes('NO_ACCESS_CONTROL')) {
    return { ok: true, descriptor: { ownerSid, dacl: null } };
  }
  const controlTokens = parseControlTokens(flags);
  if (controlTokens === undefined) {
    return { ok: false, reason: `the DACL control flags '${flags}' are not recognised` };
  }

  const aces: SddlAce[] = [];
  let index = firstParen === -1 ? body.length : firstParen;
  while (index < body.length) {
    if (body[index] !== '(') {
      return { ok: false, reason: 'the DACL contains unparsed trailing characters' };
    }
    const close = body.indexOf(')', index);
    if (close === -1) return { ok: false, reason: 'the DACL contains an unterminated entry' };

    const fields = body.slice(index + 1, close).split(';');
    // Exactly six. A seventh field is a conditional/resource-attribute ACE,
    // which this policy does not model and must not silently accept.
    if (fields.length !== ACE_FIELD_COUNT) {
      return {
        ok: false,
        reason: `the DACL contains an entry with ${String(fields.length)} fields; exactly ${String(ACE_FIELD_COUNT)} are supported`,
      };
    }

    const flagTokens = parseFlagTokens((fields[1] ?? '').trim());
    if (flagTokens === undefined) {
      return { ok: false, reason: `the DACL entry carries unrecognised flags '${String(fields[1])}'` };
    }

    const trustee = (fields[5] ?? '').trim();
    if (trustee === '') {
      return { ok: false, reason: 'the DACL contains an entry with no trustee' };
    }
    const resolved = resolveTrustee(trustee);

    aces.push({
      type: (fields[0] ?? '').trim().toUpperCase(),
      flagTokens,
      rights: (fields[2] ?? '').trim().toUpperCase(),
      trustee,
      trusteeSid: resolved.sid,
      label: resolved.label,
      inherited: flagTokens.includes('ID'),
    });
    index = close + 1;
  }

  return {
    ok: true,
    descriptor: {
      ownerSid,
      dacl: {
        isProtected: controlTokens.includes('P'),
        autoInherited: controlTokens.includes('AI'),
        controlTokens,
        aces,
      },
    },
  };
}

export interface DaclEvaluation {
  readonly secure: boolean;
  readonly problems: readonly string[];
}

function describeTrustee(ace: SddlAce): string {
  const broad = BROAD_TRUSTEE_SIDS[ace.trusteeSid];
  return broad === undefined ? ace.label : `the broad identity ${broad}`;
}

/**
 * Requires the descriptor to match exactly the canonical shape our hardening
 * produces: owned by the current user, protected, and carrying a single
 * full-access allow entry for the current user with the inheritance flags
 * appropriate to a directory or a file.
 */
export function evaluateDescriptor(
  sddl: string,
  expectedSid: string,
  shape: PathShape,
): DaclEvaluation {
  const parsed = parseDescriptor(sddl);
  if (!parsed.ok) {
    return { secure: false, problems: [`the security descriptor could not be parsed: ${parsed.reason}`] };
  }

  const problems: string[] = [];
  const { ownerSid, dacl } = parsed.descriptor;

  if (ownerSid === undefined) {
    problems.push('the security descriptor names no owner');
  } else if (ownerSid !== expectedSid) {
    problems.push(`is owned by ${ownerSid}, not the current user (${expectedSid})`);
  }

  if (dacl === null) {
    problems.push('the security descriptor has no DACL, which grants everyone full access');
    return { secure: false, problems };
  }

  if (!dacl.isProtected) {
    problems.push('inheritance from the parent directory is not blocked');
  }

  // Every token is recognised by now; policy decides which are acceptable.
  for (const token of dacl.controlTokens) {
    if (!PERMITTED_CONTROL_FLAGS.has(token)) {
      problems.push(`the DACL carries the unexpected control flag '${token}'`);
    }
  }

  for (const ace of dacl.aces) {
    if (ace.inherited) problems.push(`an inherited access-control entry for ${ace.label} is present`);
  }

  if (dacl.aces.length === 0) {
    problems.push('the DACL contains no access-control entries');
  } else if (dacl.aces.length > 1) {
    const extra = dacl.aces.filter((ace) => ace.trusteeSid !== expectedSid);
    if (extra.length === 0) {
      problems.push(`the DACL contains ${String(dacl.aces.length)} entries; exactly one is permitted`);
    }
    for (const ace of extra) {
      problems.push(`grants access to ${describeTrustee(ace)}`);
    }
  }

  for (const ace of dacl.aces) {
    if (ace.type !== ACCESS_ALLOWED) {
      problems.push(
        ace.type === 'D'
          ? `contains a deny entry for ${ace.label}`
          : `contains an unsupported entry type '${ace.type}' for ${ace.label}`,
      );
      continue;
    }

    if (ace.trusteeSid !== expectedSid) {
      if (dacl.aces.length === 1) problems.push(`grants access to ${describeTrustee(ace)}`);
      continue;
    }

    if (!FULL_ACCESS_RIGHTS.has(ace.rights)) {
      problems.push(`grants the current user '${ace.rights}' rather than full access`);
    }

    const flags = new Set(ace.flagTokens.filter((token) => token !== 'ID'));
    if (shape === 'directory') {
      if (!flags.has('OI')) problems.push('the directory entry is missing object inheritance (OI)');
      if (!flags.has('CI')) problems.push('the directory entry is missing container inheritance (CI)');
      for (const token of flags) {
        if (!DIRECTORY_ACE_FLAGS.has(token)) {
          problems.push(`the directory entry carries the unexpected flag '${token}'`);
        }
      }
    } else if (flags.size > 0) {
      problems.push(`the file entry carries unexpected inheritance flags '${[...flags].join('')}'`);
    }
  }

  if (!dacl.aces.some((ace) => ace.type === ACCESS_ALLOWED && ace.trusteeSid === expectedSid)) {
    problems.push(`does not grant access to the current user (${expectedSid})`);
  }

  return { secure: problems.length === 0, problems: [...new Set(problems)] };
}
