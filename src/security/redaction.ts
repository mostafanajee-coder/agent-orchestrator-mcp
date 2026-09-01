const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|]+/g;
const POSIX_ABSOLUTE_PATH = /(^|[^A-Za-z0-9])\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|]*/g;
const SENSITIVE_ASSIGNMENT = /\b(authorization|password|secret|credential|bearer(?:[_-]?token)?|token|access[_-]?token|api[_-]?key|token[_-]?(?:sha256|digest)|digest|lease|lease[_-]?(?:key|mac)|nonce|hmac|mac|private[_-]?key|secret[_-]?key)\b\s*(?:["']\s*)?[:=]\s*(?:["']\s*)?[^,;\s}"']+/gi;
const SENSITIVE_KEY = /^(token|bearer|bearer[_-]?token|authorization|password|secret|credential|access[_-]?token|api[_-]?key|token[_-]?(?:sha256|digest)|digest|lease|lease[_-]?(?:key|mac)|nonce|hmac|mac|private[_-]?key|secret[_-]?key)$/i;

export const REDACTED_VALUE = '[REDACTED]';
export const REDACTED_PATH = '[PATH_REDACTED]';

export interface RedactionOptions {
  readonly redactAbsolutePaths?: boolean;
}

/** Redacts credential-shaped text while preserving safe identifiers. */
export function redactSensitiveText(
  value: string,
  secretValues: readonly string[] = [],
  options: RedactionOptions = {},
): string {
  let redacted = value;
  for (const secret of secretValues) {
    if (secret !== '') redacted = redacted.split(secret).join(REDACTED_VALUE);
  }
  redacted = redacted
    .replace(/Bearer\s+[^\s,;}]+/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED_VALUE}`);
  if (options.redactAbsolutePaths === true) {
    redacted = redacted.replace(WINDOWS_ABSOLUTE_PATH, REDACTED_PATH);
    redacted = redacted.replace(POSIX_ABSOLUTE_PATH, `$1${REDACTED_PATH}`);
  }
  return redacted;
}

/** Recursively redacts sensitive object fields and string values. */
export function redactSensitiveDetail(
  value: unknown,
  secretValues: readonly string[] = [],
  options: RedactionOptions = {},
  depth = 0,
): unknown {
  if (depth > 8) return REDACTED_VALUE;
  if (typeof value === 'string') return redactSensitiveText(value, secretValues, options);
  if (Array.isArray(value)) {
    return value.map((child) => redactSensitiveDetail(child, secretValues, options, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? REDACTED_VALUE
        : redactSensitiveDetail(child, secretValues, options, depth + 1);
    }
    return output;
  }
  return value;
}
