import { describe, expect, it } from 'vitest';
import {
  isSecretKey,
  scrubBody,
  scrubHeaders,
  scrubString,
  scrubUrl,
} from '../discovery/redaction';

/**
 * These guard a security boundary: anything that survives redaction can end up
 * in git history. Each test asserts a *specific* secret is gone, not merely
 * that the output changed.
 *
 * All credentials below are fabricated for testing.
 */

const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJUZXN0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('scrubString', () => {
  it('removes a JWT wherever it appears in free text', () => {
    const out = scrubString(`Bearer ${FAKE_JWT} was rejected`);
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiI');
    expect(out).toContain('<REDACTED_JWT>');
    expect(out).toContain('was rejected'); // surrounding context survives
  });

  it('removes email addresses', () => {
    const out = scrubString('login for alex.mecklin@outlook.com failed');
    expect(out).not.toContain('alex.mecklin@outlook.com');
    expect(out).not.toContain('outlook.com');
    expect(out).toBe('login for <REDACTED_EMAIL> failed');
  });

  it('removes Finnish personal identity codes', () => {
    expect(scrubString('hetu=131052-308T')).not.toContain('131052-308T');
    expect(scrubString('hetu=131052A308T')).toContain('<REDACTED_HETU>');
  });

  it('removes long hex blobs that look like session ids', () => {
    const sessionId = 'a3f5c9d1e7b2486f0a1c3d5e7f9b2d4c';
    const out = scrubString(`sid ${sessionId}`);
    expect(out).not.toContain(sessionId);
    expect(out).toContain('<REDACTED_HEX>');
  });

  it('leaves ordinary text and short ids alone', () => {
    // Over-eager redaction that eats the endpoint names would defeat the point.
    const text = 'GET /api/v1/schedule?centerId=42 returned 200 with 15 classes';
    expect(scrubString(text)).toBe(text);
  });
});

describe('isSecretKey', () => {
  it.each([
    'password',
    'Password',
    'accessToken',
    'refresh_token',
    'Authorization',
    'apiKey',
    'email',
    'firstName',
    'phoneNumber',
    'dateOfBirth',
  ])('treats %s as secret', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(['centerId', 'classId', 'startTime', 'capacity', 'status', 'waitlistCount'])(
    'leaves %s alone',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );
});

describe('scrubBody', () => {
  it('redacts secret values in a JSON body but keeps the field names', () => {
    const body = JSON.stringify({
      email: 'me@example.com',
      password: 'hunter2',
      rememberMe: true,
      centerId: 42,
    });
    const out = scrubBody(body)!;

    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('me@example.com');
    // Field names are the whole point of keeping the capture.
    expect(out).toContain('email');
    expect(out).toContain('password');
    expect(out).toContain('rememberMe');
    expect(out).toContain('42');
  });

  it('redacts tokens nested deep inside a response body', () => {
    const body = JSON.stringify({
      data: { session: { tokens: [{ accessToken: FAKE_JWT }] } },
      meta: { ok: true },
    });
    const out = scrubBody(body)!;

    expect(out).not.toContain(FAKE_JWT);
    expect(out).toContain('accessToken');
    expect(out).toContain('meta');
  });

  it('blanks every leaf under a secret container, even ones no pattern would catch', () => {
    // Recursing into a secret-keyed container preserves the shape, so it must
    // not become a way for an unrecognised value to survive.
    const body = JSON.stringify({
      auth: { scheme: 'custom', opaqueBlob: 'zzz9', nested: { deep: 'qqq1' } },
      centerId: 42,
    });
    const out = scrubBody(body)!;

    expect(out).not.toContain('zzz9');
    expect(out).not.toContain('qqq1');
    expect(out).not.toContain('custom');
    // …while the structure survives for documentation.
    expect(out).toContain('opaqueBlob');
    expect(out).toContain('deep');
    expect(out).toContain('42');
  });

  it('redacts a JWT that appears under an innocuous key name', () => {
    // Key-based redaction alone would miss this; the value sweep must catch it.
    const out = scrubBody(JSON.stringify({ value: FAKE_JWT, note: 'from header' }))!;
    expect(out).not.toContain(FAKE_JWT);
    expect(out).toContain('<REDACTED_JWT>');
  });

  it('redacts form-encoded credentials', () => {
    const out = scrubBody('username=me%40example.com&password=hunter2&centerId=42')!;
    expect(out).not.toContain('hunter2');
    expect(out).toContain('centerId=42');
  });

  it('sweeps HTML bodies for secrets without trying to parse them', () => {
    const out = scrubBody(`<html><body><script>var t="${FAKE_JWT}";</script></body></html>`)!;
    expect(out).not.toContain(FAKE_JWT);
    expect(out).toContain('<html>');
  });

  it('falls back to a text sweep when a JSON-looking body is malformed', () => {
    const out = scrubBody(`{"accessToken": "${FAKE_JWT}", truncated…`)!;
    expect(out).not.toContain(FAKE_JWT);
  });

  it('passes through a null body', () => {
    expect(scrubBody(null)).toBeNull();
  });
});

describe('scrubHeaders', () => {
  it('redacts the Authorization header regardless of casing', () => {
    const out = scrubHeaders({ Authorization: `Bearer ${FAKE_JWT}`, accept: 'application/json' })!;
    expect(out['Authorization']).toBe('<REDACTED>');
    expect(out['accept']).toBe('application/json');
  });

  it('redacts cookies in both directions', () => {
    const out = scrubHeaders({
      cookie: 'sessionId=abc123; theme=dark',
      'set-cookie': 'sessionId=xyz789; HttpOnly',
    })!;
    expect(out['cookie']).toBe('<REDACTED>');
    expect(out['set-cookie']).toBe('<REDACTED>');
  });

  it('keeps header names visible so required headers can be identified', () => {
    // The Worker needs to know x-client-version is sent, just not any secret value.
    const out = scrubHeaders({ 'x-client-version': '3.4.1', 'x-csrf-token': 'abc' })!;
    expect(Object.keys(out)).toContain('x-client-version');
    expect(out['x-client-version']).toBe('3.4.1');
    expect(out['x-csrf-token']).toBe('<REDACTED>');
  });

  it('passes through null headers', () => {
    expect(scrubHeaders(null)).toBeNull();
  });
});

describe('scrubUrl', () => {
  it('redacts a token in the query string but keeps the path and safe params', () => {
    const out = scrubUrl('https://api.example.com/v1/book?access_token=secret123&classId=99');
    expect(out).not.toContain('secret123');
    expect(out).toContain('/v1/book');
    expect(out).toContain('classId=99');
  });

  it('keeps a clean URL byte-identical', () => {
    const url = 'https://api.example.com/v1/schedule?centerId=42&date=2026-03-31';
    expect(scrubUrl(url)).toBe(url);
  });

  it('still sweeps a string that is not a parseable URL', () => {
    const out = scrubUrl(`not-a-url ${FAKE_JWT}`);
    expect(out).not.toContain(FAKE_JWT);
  });
});
