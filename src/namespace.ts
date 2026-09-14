import { fingerprintKey } from './crypto.js';
import { toHex } from './keys.js';

/**
 * Identity bucket for cached entries. Every input is known synchronously when the
 * database is constructed — no database open, no credentials, no platform storage —
 * so the namespace resolves long before the persisted read completes.
 *
 * @internal
 */
export interface CacheNamespaceInputs {
  databaseName: string;
  schemaJson: unknown;
  version: string;
  encryptionKey: string | undefined;
  subtle: SubtleCrypto;
}

export async function computeCacheNamespace(inputs: CacheNamespaceInputs): Promise<string> {
  const schemaDigest = await inputs.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(inputs.schemaJson))
  );
  const schemaHash = toHex(new Uint8Array(schemaDigest).subarray(0, 8));
  const keyFingerprint = inputs.encryptionKey
    ? await fingerprintKey(inputs.subtle, inputs.encryptionKey)
    : '-';

  return [inputs.databaseName, schemaHash, keyFingerprint, inputs.version].join('|');
}
