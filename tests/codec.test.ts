import { describe, expect, it } from 'vitest';
import { decodeEnvelope, encodeEnvelope, QueryCacheEncodeError } from '../src/codec.js';

const SIGNATURE = 'SELECT * FROM items\0[]';
const roundTrip = (rows: unknown[]) => decodeEnvelope(encodeEnvelope(SIGNATURE, rows))!.rows;

describe('codec', () => {
  it('round-trips SQLite primitives', () => {
    const rows = [{ id: 'a', count: 3, ratio: 1.5, missing: null }];
    expect(roundTrip(rows)).toEqual(rows);
  });

  it('round-trips Date values produced by a mapper', () => {
    const rows = [{ created_at: new Date('2026-09-11T10:00:00.000Z') }];
    const decoded = roundTrip(rows) as { created_at: Date }[];
    expect(decoded[0].created_at).toBeInstanceOf(Date);
    expect(decoded[0].created_at.toISOString()).toBe('2026-09-11T10:00:00.000Z');
  });

  it('round-trips Uint8Array blobs', () => {
    const rows = [{ blob: new Uint8Array([0, 1, 254, 255]) }];
    const decoded = roundTrip(rows) as { blob: Uint8Array }[];
    expect(decoded[0].blob).toBeInstanceOf(Uint8Array);
    expect([...decoded[0].blob]).toEqual([0, 1, 254, 255]);
  });

  it('round-trips BigInt values', () => {
    const rows = [{ big: 9007199254740993n }];
    const decoded = roundTrip(rows) as { big: bigint }[];
    expect(decoded[0].big).toBe(9007199254740993n);
  });

  it('round-trips nested structures and arrays', () => {
    const rows = [{ tags: ['a', 'b'], nested: { deep: { when: new Date(0) } } }];
    const decoded = roundTrip(rows) as any[];
    expect(decoded[0].tags).toEqual(['a', 'b']);
    expect(decoded[0].nested.deep.when).toBeInstanceOf(Date);
  });

  it('does not mistake user data shaped like an encoding marker', () => {
    const rows = [{ marker: { $powersyncType: 'date', value: 'not a date' } }];
    expect(roundTrip(rows)).toEqual(rows);
  });

  it('round-trips an empty result', () => {
    expect(roundTrip([])).toEqual([]);
  });

  it('throws QueryCacheEncodeError for values it cannot represent', () => {
    expect(() => encodeEnvelope(SIGNATURE, [{ fn: () => 1 }])).toThrow(QueryCacheEncodeError);
    const circular: any = {};
    circular.self = circular;
    expect(() => encodeEnvelope(SIGNATURE, [circular])).toThrow(QueryCacheEncodeError);
  });

  it('carries the query signature inside the encoded bytes', () => {
    const decoded = decodeEnvelope(encodeEnvelope(SIGNATURE, [{ id: 1 }]));
    expect(decoded?.signature).toBe(SIGNATURE);
    expect(decoded?.rows).toEqual([{ id: 1 }]);
  });

  it('rejects bytes that are not an envelope', () => {
    // A record written by an older format: a bare rows array.
    expect(decodeEnvelope(new TextEncoder().encode('[{"id":1}]'))).toBeUndefined();
    expect(decodeEnvelope(new TextEncoder().encode('{"signature":"s"}'))).toBeUndefined();
    expect(decodeEnvelope(new TextEncoder().encode('null'))).toBeUndefined();
  });

  it('does not mistake row data shaped like the envelope', () => {
    const rows = [{ signature: 'not the real one', rows: ['decoy'] }];
    expect(roundTrip(rows)).toEqual(rows);
  });
});
