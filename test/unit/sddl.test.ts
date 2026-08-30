import { describe, expect, it } from 'vitest';

import {
  evaluateDescriptor,
  parseControlTokens,
  parseDescriptor,
  resolveTrustee,
} from '../../src/security/sddl.js';

const USER = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-9-9-9-500';
const HEAD = `O:${USER}G:${USER}`;

/** Captured from the real hardened state root on Windows. */
const REAL_USER = 'S-1-5-21-69046223-1458400334-3307106631-1001';
const REAL_DIRECTORY = `O:${REAL_USER}G:${REAL_USER}D:PAI(A;OICI;FA;;;${REAL_USER})`;
const REAL_LEASE_KEY = `O:${REAL_USER}G:${REAL_USER}D:PAI(A;;FA;;;${REAL_USER})`;

/** Captured from a real directory before hardening. */
const REAL_INHERITED =
  `O:${REAL_USER}G:${REAL_USER}D:AI(A;OICIID;0x1301bf;;;S-1-5-21-1462791045-1280380522-3850395714-3952280373)(A;OICIID;FA;;;${REAL_USER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`;

function problems(sddl: string, shape: 'directory' | 'file' = 'directory'): string {
  return evaluateDescriptor(sddl, USER, shape).problems.join(' | ');
}

describe('parseDescriptor', () => {
  it('reads owner and a canonical protected DACL', () => {
    const result = parseDescriptor(REAL_DIRECTORY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.ownerSid).toBe(REAL_USER);
    expect(result.descriptor.dacl?.isProtected).toBe(true);
    expect(result.descriptor.dacl?.aces).toHaveLength(1);
  });

  it('does not mistake the AI flag for protection', () => {
    const result = parseDescriptor(REAL_INHERITED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.dacl?.autoInherited).toBe(true);
    expect(result.descriptor.dacl?.isProtected).toBe(false);
  });

  it('reports a missing DACL rather than inventing one', () => {
    const result = parseDescriptor(`${HEAD}S:AI`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.dacl).toBeNull();
  });

  it.each([
    ['an unterminated entry', `${HEAD}D:P(A;;FA;;;${USER}`],
    ['too few fields', `${HEAD}D:P(A;;FA;${USER})`],
    ['an empty trustee', `${HEAD}D:P(A;;FA;;;)`],
    ['trailing junk', `${HEAD}D:P(A;;FA;;;${USER})garbage`],
    ['an odd-length flag string', `${HEAD}D:P(A;OIC;FA;;;${USER})`],
    ['an unknown flag token', `${HEAD}D:P(A;ZZ;FA;;;${USER})`],
    ['an empty descriptor', '   '],
  ])('refuses to parse %s', (_label, sddl) => {
    expect(parseDescriptor(sddl).ok).toBe(false);
  });

  it('never lets unparsed syntax become a pass', () => {
    // The malformed second entry must not be silently skipped: skipping it
    // would hide whoever it grants access to.
    const sddl = `${HEAD}D:P(A;;FA;;;${USER})(A;;FA;;;`;
    expect(parseDescriptor(sddl).ok).toBe(false);
    expect(evaluateDescriptor(sddl, USER, 'directory').secure).toBe(false);
    expect(problems(sddl)).toContain('could not be parsed');
  });
});

describe('resolveTrustee', () => {
  it.each([
    ['WD', 'S-1-1-0'],
    ['BU', 'S-1-5-32-545'],
    ['AU', 'S-1-5-11'],
    ['IU', 'S-1-5-4'],
    ['SY', 'S-1-5-18'],
  ])('resolves %s without a localized name', (token, sid) => {
    expect(resolveTrustee(token).sid).toBe(sid);
  });
});

describe('evaluateDescriptor: canonical descriptors pass', () => {
  it('accepts the real captured Windows directory', () => {
    expect(evaluateDescriptor(REAL_DIRECTORY, REAL_USER, 'directory')).toEqual({
      secure: true,
      problems: [],
    });
  });

  it('accepts the real captured lease.key', () => {
    expect(evaluateDescriptor(REAL_LEASE_KEY, REAL_USER, 'file')).toEqual({
      secure: true,
      problems: [],
    });
  });

  it('accepts the numeric spelling of full access', () => {
    expect(evaluateDescriptor(`${HEAD}D:P(A;OICI;0x1f01ff;;;${USER})`, USER, 'directory').secure).toBe(
      true,
    );
  });
});

describe('evaluateDescriptor: owner', () => {
  it('rejects a descriptor owned by someone else', () => {
    const sddl = `O:${OTHER}G:${USER}D:P(A;OICI;FA;;;${USER})`;
    expect(evaluateDescriptor(sddl, USER, 'directory').secure).toBe(false);
    expect(problems(sddl)).toContain('is owned by');
  });

  it('rejects a descriptor with no owner', () => {
    const sddl = `G:${USER}D:P(A;OICI;FA;;;${USER})`;
    expect(problems(sddl)).toContain('names no owner');
  });
});

describe('evaluateDescriptor: DACL shape', () => {
  it('rejects a NULL DACL', () => {
    expect(problems(`${HEAD}S:AI`)).toContain('no DACL');
  });

  it('rejects an unprotected DACL', () => {
    expect(problems(`${HEAD}D:AI(A;OICI;FA;;;${USER})`)).toContain('inheritance');
  });

  it('rejects an inherited entry even for the current user', () => {
    expect(problems(`${HEAD}D:PAI(A;OICIID;FA;;;${USER})`)).toContain('inherited');
  });

  it('rejects an empty DACL', () => {
    expect(problems(`${HEAD}D:P`)).toContain('no access-control entries');
  });

  it('rejects read-only rights for the current user', () => {
    expect(problems(`${HEAD}D:P(A;OICI;FR;;;${USER})`)).toContain('rather than full access');
  });

  it('rejects a deny entry', () => {
    expect(problems(`${HEAD}D:P(A;OICI;FA;;;${USER})(D;;FA;;;WD)`)).toContain('deny entry');
  });

  it.each([['OA'], ['XA'], ['ZA'], ['QQ']])('rejects the unsupported entry type %s', (type) => {
    expect(problems(`${HEAD}D:P(A;OICI;FA;;;${USER})(${type};;FA;;;${USER})`)).toContain(
      'unsupported entry type',
    );
  });

  it('rejects a second entry for the current user', () => {
    const text = problems(`${HEAD}D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;${USER})`);
    expect(text).toContain('exactly one is permitted');
  });

  it('rejects a second entry for a foreign SID', () => {
    expect(problems(`${HEAD}D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;${OTHER})`)).toContain(
      'grants access to',
    );
  });

  it.each([
    ['WD', 'Everyone'],
    ['BU', 'BUILTIN'],
    ['AU', 'Authenticated Users'],
    ['IU', 'INTERACTIVE'],
  ])('rejects the broad identity %s', (token, label) => {
    expect(problems(`${HEAD}D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;${token})`)).toContain(label);
  });

  it.each([
    ['S-1-1-0', 'Everyone'],
    ['S-1-5-32-545', 'BUILTIN'],
  ])('rejects the broad identity %s given as a raw SID', (sid, label) => {
    expect(problems(`${HEAD}D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;${sid})`)).toContain(label);
  });

  it('rejects SYSTEM and Administrators', () => {
    expect(problems(`${HEAD}D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`)).toContain(
      'grants access to',
    );
  });

  it('rejects a descriptor that does not grant the current user', () => {
    expect(problems(`${HEAD}D:P(A;OICI;FA;;;${OTHER})`)).toContain('does not grant access');
  });

  it('rejects the real unhardened directory', () => {
    expect(evaluateDescriptor(REAL_INHERITED, REAL_USER, 'directory').secure).toBe(false);
  });
});

describe('evaluateDescriptor: inheritance flags', () => {
  it('rejects a directory entry missing OI', () => {
    expect(problems(`${HEAD}D:P(A;CI;FA;;;${USER})`)).toContain('missing object inheritance');
  });

  it('rejects a directory entry missing CI', () => {
    expect(problems(`${HEAD}D:P(A;OI;FA;;;${USER})`)).toContain('missing container inheritance');
  });

  it('rejects a directory entry with no inheritance flags at all', () => {
    const text = problems(`${HEAD}D:P(A;;FA;;;${USER})`);
    expect(text).toContain('missing object inheritance');
    expect(text).toContain('missing container inheritance');
  });

  it('rejects a directory entry carrying an unexpected flag', () => {
    expect(problems(`${HEAD}D:P(A;OICIIO;FA;;;${USER})`)).toContain("unexpected flag 'IO'");
  });

  it.each([['OI'], ['CI'], ['OICI']])('rejects a file entry carrying %s', (flags) => {
    expect(problems(`${HEAD}D:P(A;${flags};FA;;;${USER})`, 'file')).toContain(
      'unexpected inheritance flags',
    );
  });

  it('accepts a file entry with no inheritance flags', () => {
    expect(evaluateDescriptor(`${HEAD}D:P(A;;FA;;;${USER})`, USER, 'file').secure).toBe(true);
  });
});

describe('ACE field count is exact', () => {
  it('accepts the canonical six-field directory entry', () => {
    expect(evaluateDescriptor(REAL_DIRECTORY, REAL_USER, 'directory').secure).toBe(true);
  });

  it('accepts the canonical six-field file entry', () => {
    expect(evaluateDescriptor(REAL_LEASE_KEY, REAL_USER, 'file').secure).toBe(true);
  });

  it.each([
    ['five', `${HEAD}D:P(A;OICI;FA;;${USER})`],
    ['seven', `${HEAD}D:P(A;OICI;FA;;;${USER};extra)`],
    ['eight', `${HEAD}D:P(A;OICI;FA;;;${USER};extra;more)`],
  ])('rejects an entry with %s fields', (_label, sddl) => {
    // A seventh field marks a conditional/resource ACE, which this policy does
    // not model and must not silently accept.
    expect(parseDescriptor(sddl).ok).toBe(false);
    expect(evaluateDescriptor(sddl, USER, 'directory').secure).toBe(false);
  });
});

describe('DACL control flags are fully parsed', () => {
  it('accepts the canonical PAI form captured from Windows', () => {
    expect(evaluateDescriptor(REAL_DIRECTORY, REAL_USER, 'directory').secure).toBe(true);
  });

  it('accepts a bare P form', () => {
    expect(evaluateDescriptor(`${HEAD}D:P(A;OICI;FA;;;${USER})`, USER, 'directory').secure).toBe(
      true,
    );
  });

  it('tokenises known control flags', () => {
    expect(parseControlTokens('PAI')).toEqual(['P', 'AI']);
    expect(parseControlTokens('AIP')).toEqual(['AI', 'P']);
    expect(parseControlTokens('')).toEqual([]);
  });

  it.each([['PXYZ'], ['Q'], ['PAIX'], ['X'], ['PA']])(
    'refuses to parse the unknown control sequence %s',
    (flags) => {
      expect(parseControlTokens(flags)).toBeUndefined();
    },
  );

  it.each([['PXYZ'], ['Q'], ['PAIX']])('rejects a descriptor whose control is %s', (flags) => {
    const sddl = `${HEAD}D:${flags}(A;OICI;FA;;;${USER})`;
    expect(parseDescriptor(sddl).ok).toBe(false);
    expect(evaluateDescriptor(sddl, USER, 'directory').secure).toBe(false);
  });

  it('rejects a known but unpermitted control flag', () => {
    // AR is recognised syntax, but is not part of the canonical shape.
    const result = evaluateDescriptor(`${HEAD}D:PAIAR(A;OICI;FA;;;${USER})`, USER, 'directory');
    expect(result.secure).toBe(false);
    expect(result.problems.join(' ')).toContain("unexpected control flag 'AR'");
  });
});
