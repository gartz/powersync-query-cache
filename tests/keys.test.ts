import { describe, expect, it } from 'vitest';
import { persistedKeyFor, toHex } from '../src/keys.js';

describe('toHex', () => {
  it('pads single digit bytes', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

describe('persistedKeyFor', () => {
  it('is 32 hex characters', async () => {
    const key = await persistedKeyFor('ns', 'SELECT 1', crypto.subtle);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs per namespace', async () => {
    const a = await persistedKeyFor('ns-a', 'SELECT 1', crypto.subtle);
    const b = await persistedKeyFor('ns-b', 'SELECT 1', crypto.subtle);
    expect(a).not.toBe(b);
  });

  it('differs per signature', async () => {
    const a = await persistedKeyFor('ns', 'SELECT 1', crypto.subtle);
    const b = await persistedKeyFor('ns', 'SELECT 2', crypto.subtle);
    expect(a).not.toBe(b);
  });
});
