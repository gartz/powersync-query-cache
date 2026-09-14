import { describe, expect, it } from 'vitest';
import { computeCacheNamespace } from '../src/namespace.js';

describe('computeCacheNamespace', () => {
  const base = {
    databaseName: 'app.db',
    schemaJson: { tables: [{ name: 'items' }] },
    version: '1',
    encryptionKey: undefined as string | undefined,
    subtle: crypto.subtle
  };

  it('is stable for identical inputs', async () => {
    expect(await computeCacheNamespace(base)).toBe(await computeCacheNamespace({ ...base }));
  });

  it('changes with the database name', async () => {
    expect(await computeCacheNamespace(base)).not.toBe(
      await computeCacheNamespace({ ...base, databaseName: 'other.db' })
    );
  });

  it('changes with the schema', async () => {
    expect(await computeCacheNamespace(base)).not.toBe(
      await computeCacheNamespace({ ...base, schemaJson: { tables: [{ name: 'other' }] } })
    );
  });

  it('changes with the cache version', async () => {
    expect(await computeCacheNamespace(base)).not.toBe(await computeCacheNamespace({ ...base, version: '2' }));
  });

  it('changes when the encryption key rotates', async () => {
    const first = await computeCacheNamespace({ ...base, encryptionKey: 'key-1' });
    const second = await computeCacheNamespace({ ...base, encryptionKey: 'key-2' });
    expect(first).not.toBe(second);
  });

  it('does not contain the encryption key', async () => {
    expect(await computeCacheNamespace({ ...base, encryptionKey: 'hunter2' })).not.toContain('hunter2');
  });
});
