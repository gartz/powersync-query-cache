import { selectEvictions } from './policy.js';

/**
 * In-process layer of the query cache.
 *
 * Keyed by raw query signature: this cache belongs to a single database instance, so it
 * needs no namespace, and a synchronous lookup is what lets a hit paint in the same tick
 * the consumer first renders.
 *
 * @internal
 */
export interface MemoryCacheEntry {
  rows: readonly unknown[];
  /** When the rows were produced. Drives TTL. */
  updatedAt: number;
  /** When the entry was last read or written. Drives eviction. */
  lastUsedAt: number;
  bytes: number;
}

export class MemoryQueryCache {
  private readonly entries = new Map<string, MemoryCacheEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get(signature: string, now: number): MemoryCacheEntry | undefined {
    const entry = this.entries.get(signature);
    if (!entry) {
      return undefined;
    }
    entry.lastUsedAt = now;
    return entry;
  }

  set(signature: string, entry: MemoryCacheEntry): void {
    if (entry.bytes > this.maxBytes) {
      // A single result larger than the whole budget would evict everything else and
      // still not fit; skip it entirely.
      this.delete(signature);
      return;
    }

    this.delete(signature);
    this.entries.set(signature, { ...entry });
    this.bytes += entry.bytes;
    this.evict();
  }

  delete(signature: string): void {
    const existing = this.entries.get(signature);
    if (existing) {
      this.bytes -= existing.bytes;
      this.entries.delete(signature);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private evict(): void {
    if (this.bytes <= this.maxBytes) {
      return;
    }
    const candidates = [...this.entries].map(([key, entry]) => ({
      key,
      lastUsedAt: entry.lastUsedAt,
      bytes: entry.bytes
    }));
    for (const key of selectEvictions(candidates, this.maxBytes)) {
      this.delete(key);
    }
  }
}
