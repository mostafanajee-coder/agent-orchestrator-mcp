import { describe, expect, it } from 'vitest';

import {
  REDACTED_PATH,
  REDACTED_VALUE,
  redactSensitiveDetail,
  redactSensitiveText,
} from '../../src/security/redaction.js';

describe('Phase 9 redaction contract', () => {
  it('redacts credentials and absolute paths while preserving safe identifiers', () => {
    const value = redactSensitiveText(
      'Bearer bearer-value token=token-value token_id=token-id C:\\AgentProjects\\private /var/lib/private',
      ['custom-secret'],
      { redactAbsolutePaths: true },
    );
    expect(value).toContain(`Bearer ${REDACTED_VALUE}`);
    expect(value).toContain(`token=${REDACTED_VALUE}`);
    expect(value).toContain('token_id=token-id');
    expect(value).toContain(REDACTED_PATH);
    expect(value).not.toContain('bearer-value');
    expect(value).not.toContain('C:\\AgentProjects\\private');
    expect(value).not.toContain('/var/lib/private');
  });

  it('redacts sensitive nested fields and bounds recursion without hiding token IDs', () => {
    const detail = redactSensitiveDetail({
      token: 'secret-token',
      token_id: 'safe-token-id',
      nested: { nonce: 'secret-nonce', note: 'safe' },
    });
    expect(detail).toEqual({
      token: REDACTED_VALUE,
      token_id: 'safe-token-id',
      nested: { nonce: REDACTED_VALUE, note: 'safe' },
    });
  });
});
