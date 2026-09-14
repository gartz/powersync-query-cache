import { QueryCacheTouch } from './types.js';

/**
 * Per-key trailing debounce.
 *
 * The timer starts on the first schedule for a key and is NOT reset by later ones —
 * only the task is replaced. A query emitting continuously therefore still persists
 * every `delayMs`, instead of starving until it goes quiet.
 *
 * @internal
 */
export class DebouncedWriteScheduler {
  private readonly pending = new Map<string, { task: () => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly delayMs: number) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  schedule(key: string, task: () => void): void {
    const existing = this.pending.get(key);
    if (existing) {
      existing.task = task;
      return;
    }

    const timer = setTimeout(() => {
      const entry = this.pending.get(key);
      this.pending.delete(key);
      this.run(entry?.task);
    }, this.delayMs);

    this.pending.set(key, { task, timer });
  }

  /** Runs every pending task now and clears their timers. */
  flush(): void {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    for (const entry of entries) {
      this.run(entry.task);
    }
  }

  cancel(key: string): void {
    const entry = this.pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
    }
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  private run(task: (() => void) | undefined): void {
    try {
      task?.();
    } catch {
      // The cache is best-effort; a failed write must never escape into a query.
    }
  }
}

/**
 * Coalesces LRU touches so a cache hit does not cost a storage write.
 *
 * @internal
 */
export class TouchBuffer {
  private readonly touches = new Map<string, number>();

  get size(): number {
    return this.touches.size;
  }

  add(key: string, lastUsedAt: number): void {
    this.touches.set(key, lastUsedAt);
  }

  drain(): QueryCacheTouch[] {
    const drained: QueryCacheTouch[] = [];
    for (const [key, lastUsedAt] of this.touches) {
      drained.push({ key, lastUsedAt });
    }
    this.touches.clear();
    return drained;
  }
}
