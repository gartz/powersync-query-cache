import { toHex } from './keys.js';

/**
 * Encodes a persisted cache entry's plaintext to bytes.
 *
 * The same codec runs whether or not the payload is encrypted, so a cached result
 * round-trips identically in both modes. Structured clone is deliberately not used:
 * ciphertext must be bytes, and two encodings preserving different types would be a
 * behavioural difference between an encrypted and an unencrypted database.
 *
 * @internal
 */

const MARKER = '$powersyncType';

export class QueryCacheEncodeError extends Error {
  constructor(cause: unknown) {
    super(`Query result could not be encoded for the cache: ${String(cause)}`);
    this.name = 'QueryCacheEncodeError';
  }
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// `function`, not an arrow: `this` is the holder of `key`, which is the only way to see
// a Date before its toJSON() turns it into a string.
function replacer(this: any, key: string, value: unknown): unknown {
  const raw = this?.[key];

  if (raw instanceof Date) {
    return { [MARKER]: 'date', value: raw.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { [MARKER]: 'bytes', value: toHex(value) };
  }
  if (typeof value === 'bigint') {
    return { [MARKER]: 'bigint', value: value.toString() };
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`unsupported value of type ${typeof value}`);
  }
  if (value !== null && typeof value === 'object' && MARKER in (value as object)) {
    // User data that happens to look like one of our markers. Escaped as an opaque
    // JSON string, not a nested object: JSON.stringify's replacer is re-entrant — it
    // is called again for every key of whatever a previous call returned — so a
    // shallow-copied object still carrying `$powersyncType` as its own key would be
    // re-examined on that second pass and wrapped again, forever. A string value has
    // no keys for the replacer to walk into, which breaks the loop. Anything nested
    // inside marker-shaped user data is plain JSON from here down; that is an edge
    // case within an edge case.
    return { [MARKER]: 'raw', value: JSON.stringify(value) };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !(MARKER in (value as object))) {
    return value;
  }
  const tagged = value as { [MARKER]: string; value: unknown };
  switch (tagged[MARKER]) {
    case 'date':
      return new Date(tagged.value as string);
    case 'bytes':
      return fromHex(tagged.value as string);
    case 'bigint':
      return BigInt(tagged.value as string);
    case 'raw':
      return JSON.parse(tagged.value as string);
    default:
      return value;
  }
}

/**
 * The plaintext of one persisted entry: the rows, together with the query signature
 * they were written for.
 *
 * The signature lives INSIDE this envelope on purpose. Stored beside the payload it
 * would put the raw SQL and every parameter value on disk in cleartext, next to the
 * ciphertext they describe — which is precisely what hashing the persisted key exists
 * to prevent. Sealed in here, the collision check costs one decrypt that a read
 * performs anyway.
 */
export interface QueryCacheEnvelope {
  signature: string;
  rows: unknown[];
}

export function encodeEnvelope(signature: string, rows: readonly unknown[]): Uint8Array {
  let json: string | undefined;
  try {
    json = JSON.stringify({ signature, rows }, replacer);
  } catch (error) {
    throw new QueryCacheEncodeError(error);
  }
  if (json === undefined) {
    throw new QueryCacheEncodeError('result serialized to undefined');
  }
  return new TextEncoder().encode(json);
}

/**
 * @returns the envelope, or undefined when the bytes are not one — a record written by
 * an older format, or anything else that does not decode to the expected shape. The
 * caller treats that exactly like a signature mismatch: delete the entry and miss.
 */
export function decodeEnvelope(bytes: Uint8Array): QueryCacheEnvelope | undefined {
  const json = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(json, reviver) as Partial<QueryCacheEnvelope> | null;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.signature !== 'string' || !Array.isArray(parsed.rows)) {
    return undefined;
  }
  return { signature: parsed.signature, rows: parsed.rows };
}
