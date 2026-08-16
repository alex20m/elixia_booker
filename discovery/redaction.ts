/**
 * Redaction primitives for discovery output.
 *
 * Raw captures hold live bearer tokens, session cookies and personal data.
 * These functions strip the values while preserving the *shape* — endpoint
 * paths, field names, header names, status codes — which is all docs/api.md
 * needs.
 *
 * Deliberately over-eager. A false positive costs a field name in the docs; a
 * false negative leaks a credential into git history. When in doubt, redact.
 *
 * Kept separate from redact.ts so it can be unit tested without running the CLI.
 */

export const PLACEHOLDER = '<REDACTED>';

/** Header names whose values are always credentials. */
export const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'proxy-authorization',
]);

/** JSON/form keys whose values are secret or personal. Matched as substrings. */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'auth',
  'credential',
  'apikey',
  'api_key',
  'sessionid',
  'session_id',
  'email',
  'phone',
  'mobile',
  'ssn',
  'socialsecurity',
  'personalid',
  'firstname',
  'lastname',
  'fullname',
  'birth',
  'address',
];

/** Value-level patterns applied to any string that survives key-based redaction. */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // JWTs — three base64url segments.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '<REDACTED_JWT>'],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<REDACTED_EMAIL>'],
  // Finnish personal identity codes (DDMMYY[+-A]NNNC).
  [/\b\d{6}[+\-A]\d{3}[0-9A-Z]\b/g, '<REDACTED_HETU>'],
  // Long opaque hex blobs — session ids, refresh tokens.
  [/\b[A-Fa-f0-9]{32,}\b/g, '<REDACTED_HEX>'],
];

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

export function scrubString(s: string): string {
  let out = s;
  for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Blank every scalar leaf, keeping object keys and array structure.
 *
 * Used for values sitting under a secret-looking key. Replacing the whole
 * subtree with a placeholder would be safe but would throw away the shape —
 * and the shape (`{ tokens: [{ accessToken, expiresIn }] }`) is exactly what
 * docs/api.md is being written from. Recursing keeps the field names while
 * guaranteeing no value under a secret key survives, including ones no pattern
 * would have recognised on their own.
 */
function redactAllLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAllLeaves);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactAllLeaves(v)]),
    );
  }
  // null carries no information, so it is left as-is to keep nullability visible.
  return value === null ? null : PLACEHOLDER;
}

/** Recursively redact a parsed JSON value: by key name first, then by value pattern. */
export function scrubJson(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        isSecretKey(k) ? redactAllLeaves(v) : scrubJson(v),
      ]),
    );
  }
  return value;
}

/**
 * Bodies may be JSON, form-encoded or HTML. Parse what we can so redaction is
 * key-aware; otherwise sweep the raw text for value patterns.
 */
export function scrubBody(body: string | null): string | null {
  if (body === null) return null;

  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(scrubJson(JSON.parse(trimmed)), null, 2);
    } catch {
      /* not valid JSON after all — fall through to the text sweep */
    }
  }

  // Form-encoded: has '=' and no angle brackets to suggest markup.
  if (trimmed.includes('=') && !trimmed.includes('<')) {
    try {
      const params = new URLSearchParams(trimmed);
      const scrubbed = new URLSearchParams();
      for (const [k, v] of params) scrubbed.set(k, isSecretKey(k) ? PLACEHOLDER : scrubString(v));
      return scrubbed.toString();
    } catch {
      /* fall through */
    }
  }

  return scrubString(body);
}

export function scrubHeaders(
  headers: Record<string, string> | null,
): Record<string, string> | null {
  if (!headers) return null;
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      SECRET_HEADERS.has(k.toLowerCase()) ? PLACEHOLDER : scrubString(v),
    ]),
  );
}

/** Query strings routinely carry tokens and member ids. Redact by param name. */
export function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      const current = url.searchParams.get(key) ?? '';
      url.searchParams.set(key, isSecretKey(key) ? PLACEHOLDER : scrubString(current));
    }
    return url.toString();
  } catch {
    return scrubString(raw);
  }
}
