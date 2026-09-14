import { describe, expect, it } from 'vitest';
import {
  createAesGcmCrypto,
  createPlaintextCrypto,
  deriveCacheKey,
  fingerprintKey
} from '../src/crypto.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('fingerprintKey', () => {
  it('is stable and 32 hex characters', async () => {
    const a = await fingerprintKey(crypto.subtle, 'secret');
    const b = await fingerprintKey(crypto.subtle, 'secret');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs per key', async () => {
    expect(await fingerprintKey(crypto.subtle, 'a')).not.toBe(await fingerprintKey(crypto.subtle, 'b'));
  });

  it('does not contain the key', async () => {
    expect(await fingerprintKey(crypto.subtle, 'hunter2')).not.toContain('hunter2');
  });
});

describe('plaintext crypto', () => {
  it('passes payloads through unchanged', async () => {
    const plain = createPlaintextCrypto();
    const sealed = await plain.seal(bytes('rows'));
    expect(sealed.iv).toBeUndefined();
    expect(new TextDecoder().decode(await plain.open(sealed.payload, sealed.iv))).toBe('rows');
  });
});

describe('AES-GCM crypto', () => {
  const keyFor = (namespace: string) => () => deriveCacheKey(crypto.subtle, 'passphrase', namespace);

  it('round-trips a payload', async () => {
    const aes = createAesGcmCrypto(crypto.subtle, keyFor('ns'));
    const sealed = await aes.seal(bytes('sensitive rows'));
    expect(sealed.iv).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(await aes.open(sealed.payload, sealed.iv))).toBe('sensitive rows');
  });

  it('produces ciphertext that is not the plaintext', async () => {
    const aes = createAesGcmCrypto(crypto.subtle, keyFor('ns'));
    const sealed = await aes.seal(bytes('sensitive rows'));
    expect(new TextDecoder().decode(sealed.payload)).not.toContain('sensitive');
  });

  it('uses a fresh IV per call', async () => {
    const aes = createAesGcmCrypto(crypto.subtle, keyFor('ns'));
    const first = await aes.seal(bytes('same'));
    const second = await aes.seal(bytes('same'));
    expect(toArray(first.iv!)).not.toEqual(toArray(second.iv!));
    expect(toArray(first.payload)).not.toEqual(toArray(second.payload));
  });

  it('cannot open a payload sealed under a different namespace', async () => {
    const a = createAesGcmCrypto(crypto.subtle, keyFor('ns-a'));
    const b = createAesGcmCrypto(crypto.subtle, keyFor('ns-b'));
    const sealed = await a.seal(bytes('rows'));
    await expect(b.open(sealed.payload, sealed.iv)).rejects.toThrow();
  });
});

const toArray = (input: Uint8Array) => [...input];
