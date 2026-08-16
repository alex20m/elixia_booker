/**
 * Encryption at rest for stored Elixia sessions.
 *
 * This app holds other people's gym sessions. A KV namespace full of plaintext
 * bearer tokens is a breach waiting to happen — anyone with read access to the
 * namespace (a leaked API token, a misconfigured binding, a support engineer)
 * would be able to act as every user. So tokens are sealed with AES-GCM under a
 * key that lives only in Worker secrets, never in KV.
 *
 * AES-GCM is authenticated, so a tampered record fails to decrypt rather than
 * silently yielding attacker-chosen plaintext. A fresh 96-bit IV per record is
 * mandatory: GCM catastrophically loses confidentiality *and* integrity if an
 * IV is reused under the same key, so it is generated per encryption and never
 * derived from the record.
 *
 * Uses WebCrypto only, which exists in both Workers and Node 18+.
 */

/** AES-GCM standard IV length. 96 bits is the size the mode is designed for. */
const IV_BYTES = 12;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  // Allocated over an explicit ArrayBuffer: WebCrypto's BufferSource excludes
  // SharedArrayBuffer-backed views, which the bare constructor allows.
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Import the app's encryption key from a base64 secret.
 *
 * Generate one with:
 *   openssl rand -base64 32
 */
export async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (AES-256), got ${raw.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Seal a JSON-serialisable value. Output is base64(iv ‖ ciphertext ‖ tag). */
export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );

  const combined = new Uint8Array(new ArrayBuffer(iv.length + ciphertext.length));
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64(combined);
}

/**
 * Open a sealed value.
 *
 * Throws DecryptionError on anything malformed or tampered with — never returns
 * a partial or guessed result, because a caller that silently got `null` here
 * would treat a corrupted session as "no session" and quietly stop booking.
 */
export async function decryptJson<T>(key: CryptoKey, blob: string): Promise<T> {
  let combined: Uint8Array;
  try {
    combined = base64ToBytes(blob);
  } catch {
    throw new DecryptionError('stored record is not valid base64');
  }

  if (combined.length <= IV_BYTES) {
    throw new DecryptionError('stored record is too short to contain an IV and ciphertext');
  }

  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    // Either the key is wrong or the record was tampered with. Both mean the
    // same thing operationally: this session is unusable and needs re-linking.
    throw new DecryptionError('could not decrypt stored record — wrong key or tampered data');
  }

  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new DecryptionError('decrypted record is not valid JSON');
  }
}
