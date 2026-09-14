import { toHex } from './keys.js';

/**
 * Payload protection for the persisted cache layer.
 *
 * When the database was opened with an encryption key, the same key protects cached
 * payloads. The key PowerSync passes to SQLite is consumed by the cipher-enabled
 * SQLite build (SQLCipher on React Native, SQLite3 Multiple Ciphers on the web), which
 * derives its page keys internally and never exposes them to JavaScript — so the cache
 * must derive its own key from the same passphrase.
 *
 * HKDF does not stretch. It is the right choice for high-entropy keys; an app whose
 * key is derived from a user passphrase should supply a stretched key through
 * `cache.encryption.getKey`.
 *
 * @internal
 */

const HKDF_INFO = 'powersync-query-cache/v1';
const IV_LENGTH_BYTES = 12;

export interface SealedPayload {
  payload: Uint8Array;
  iv?: Uint8Array;
}

export interface QueryCacheCrypto {
  seal(plain: Uint8Array): Promise<SealedPayload>;
  open(payload: Uint8Array, iv: Uint8Array | undefined): Promise<Uint8Array>;
}

export function createPlaintextCrypto(): QueryCacheCrypto {
  return {
    async seal(plain) {
      return { payload: plain };
    },
    async open(payload) {
      return payload;
    }
  };
}

/**
 * SHA-256 of the encryption key, truncated to 128 bits. Used as an identity input so
 * rotating the key changes the namespace and prunes entries written under the old one.
 * The key itself is never stored.
 */
export async function fingerprintKey(subtle: SubtleCrypto, encryptionKey: string): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(encryptionKey));
  return toHex(new Uint8Array(digest).subarray(0, 16));
}

/**
 * Derives the AES-GCM key.
 *
 * The namespace is the HKDF salt. A salt is not secret and need not be random, and the
 * namespace already binds the database name, schema, key fingerprint and cache version —
 * so using it removes a persisted-salt round trip from the boot path.
 */
export async function deriveCacheKey(
  subtle: SubtleCrypto,
  encryptionKey: string,
  namespace: string
): Promise<CryptoKey> {
  const material = await subtle.importKey('raw', new TextEncoder().encode(encryptionKey), 'HKDF', false, [
    'deriveKey'
  ]);

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(namespace),
      info: new TextEncoder().encode(HKDF_INFO)
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function createAesGcmCrypto(
  subtle: SubtleCrypto,
  keyProvider: () => Promise<CryptoKey>
): QueryCacheCrypto {
  let key: Promise<CryptoKey> | undefined;
  const resolveKey = () => (key ??= keyProvider());

  return {
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
      const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, await resolveKey(), plain as BufferSource);
      return { payload: new Uint8Array(sealed), iv };
    },
    async open(payload, iv) {
      if (!iv) {
        throw new Error('Encrypted cache entry has no IV');
      }
      const opened = await subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        await resolveKey(),
        payload as BufferSource
      );
      return new Uint8Array(opened);
    }
  };
}
