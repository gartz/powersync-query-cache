/**
 * Key construction for the query cache.
 *
 * The memory layer keys on the raw signature: it is per-database-instance and
 * in-process, so it needs neither a namespace nor a hash, and a synchronous lookup is
 * what lets a cache hit paint in the same tick the consumer first renders.
 *
 * The persisted layer keys on a hash, because its keys are written to disk next to
 * (possibly encrypted) payloads — raw SQL and parameter values must not be readable
 * there.
 *
 * @internal
 */

/** NUL cannot appear in SQL text, so it separates fields unambiguously. */
export const SIGNATURE_SEPARATOR = '\0';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Hashes the namespaced signature to 128 bits.
 *
 * Collisions are not a correctness concern: entries carry their signature and a read
 * discards any entry whose signature does not match the requesting query.
 */
export async function persistedKeyFor(
  namespace: string,
  signature: string,
  subtle: SubtleCrypto
): Promise<string> {
  const input = new TextEncoder().encode(`${namespace}${SIGNATURE_SEPARATOR}${signature}`);
  const digest = await subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(digest).subarray(0, 16));
}
