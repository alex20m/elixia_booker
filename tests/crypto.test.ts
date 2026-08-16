import { describe, expect, it } from 'vitest';
import { DecryptionError, decryptJson, encryptJson, importEncryptionKey } from '../lib/auth/crypto';

/**
 * This module is the only thing standing between a KV leak and every user's
 * gym session. The tests assert the specific properties that matter, not just
 * that a round trip works.
 */

const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes of 0x00
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='; // a different 32 bytes

const tokens = { accessToken: 'secret-token', refreshToken: 'secret-refresh', expiresAtMs: 1, updatedAtMs: 2 };

describe('importEncryptionKey', () => {
  it('accepts a 32-byte base64 key', async () => {
    await expect(importEncryptionKey(KEY_A)).resolves.toBeDefined();
  });

  it('rejects a key of the wrong length, naming the fix', async () => {
    // A short key silently weakening the cipher is exactly the sort of thing
    // that goes unnoticed until it matters.
    await expect(importEncryptionKey(btoa('too-short'))).rejects.toThrow(/32 bytes/);
    await expect(importEncryptionKey(btoa('too-short'))).rejects.toThrow(/openssl rand/);
  });
});

describe('encryptJson / decryptJson', () => {
  it('round-trips a value', async () => {
    const key = await importEncryptionKey(KEY_A);
    const sealed = await encryptJson(key, tokens);
    await expect(decryptJson(key, sealed)).resolves.toEqual(tokens);
  });

  it('leaves no plaintext in the sealed output', async () => {
    const key = await importEncryptionKey(KEY_A);
    const sealed = await encryptJson(key, tokens);

    expect(sealed).not.toContain('secret-token');
    expect(sealed).not.toContain('secret-refresh');
    expect(sealed).not.toContain('accessToken');
  });

  it('produces a different ciphertext every time, even for identical input', async () => {
    // A fresh IV per record is mandatory: reusing one under the same key breaks
    // GCM's confidentiality *and* its integrity guarantee. Identical output here
    // would mean the IV was fixed.
    const key = await importEncryptionKey(KEY_A);
    const first = await encryptJson(key, tokens);
    const second = await encryptJson(key, tokens);

    expect(first).not.toBe(second);
    await expect(decryptJson(key, first)).resolves.toEqual(tokens);
    await expect(decryptJson(key, second)).resolves.toEqual(tokens);
  });

  it('refuses a record sealed under a different key', async () => {
    const sealed = await encryptJson(await importEncryptionKey(KEY_A), tokens);
    const otherKey = await importEncryptionKey(KEY_B);

    await expect(decryptJson(otherKey, sealed)).rejects.toThrow(DecryptionError);
  });

  it('refuses a tampered record rather than returning altered data', async () => {
    // GCM authenticates, so a flipped byte must fail loudly. Silently returning
    // attacker-influenced plaintext would be far worse than an error.
    const key = await importEncryptionKey(KEY_A);
    const sealed = await encryptJson(key, tokens);

    const bytes = atob(sealed).split('');
    bytes[bytes.length - 3] = String.fromCharCode(bytes[bytes.length - 3]!.charCodeAt(0) ^ 0xff);
    const tampered = btoa(bytes.join(''));

    await expect(decryptJson(key, tampered)).rejects.toThrow(DecryptionError);
  });

  it('reports a truncated record as malformed, not as a key mismatch', async () => {
    // Both fail, but an operator staring at a corrupted namespace needs to know
    // whether the data is broken or the key is wrong — those have different
    // fixes, and conflating them sends you hunting the wrong problem.
    const key = await importEncryptionKey(KEY_A);

    await expect(decryptJson(key, btoa('short'))).rejects.toThrow(/too short/);
    await expect(decryptJson(key, btoa('short'))).rejects.not.toThrow(/wrong key/);
  });

  it('rejects a record that is not base64 at all', async () => {
    const key = await importEncryptionKey(KEY_A);
    await expect(decryptJson(key, 'not base64 !!!')).rejects.toThrow(DecryptionError);
  });

  it('round-trips values containing non-ASCII text', async () => {
    const key = await importEncryptionKey(KEY_A);
    const value = { name: 'Jyväskylä — Kuntosali 🏋️' };
    await expect(decryptJson(key, await encryptJson(key, value))).resolves.toEqual(value);
  });
});
