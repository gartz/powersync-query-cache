import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebouncedWriteScheduler, TouchBuffer } from '../src/scheduler.js';

describe('DebouncedWriteScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a scheduled task after the delay', () => {
    const scheduler = new DebouncedWriteScheduler(100);
    const task = vi.fn();
    scheduler.schedule('a', task);

    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('collapses rapid writes to one, keeping the latest task', () => {
    const scheduler = new DebouncedWriteScheduler(100);
    const first = vi.fn();
    const second = vi.fn();

    scheduler.schedule('a', first);
    vi.advanceTimersByTime(50);
    scheduler.schedule('a', second);
    vi.advanceTimersByTime(50);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not let a continuously updating key starve', () => {
    const scheduler = new DebouncedWriteScheduler(100);
    const task = vi.fn();

    for (let i = 0; i < 10; i++) {
      scheduler.schedule('a', task);
      vi.advanceTimersByTime(30);
    }

    expect(task).toHaveBeenCalled();
  });

  it('keeps keys independent', () => {
    const scheduler = new DebouncedWriteScheduler(100);
    const a = vi.fn();
    const b = vi.fn();
    scheduler.schedule('a', a);
    scheduler.schedule('b', b);
    vi.advanceTimersByTime(100);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('flush runs pending tasks immediately and clears them', () => {
    const scheduler = new DebouncedWriteScheduler(100);
    const task = vi.fn();
    scheduler.schedule('a', task);

    scheduler.flush();
    expect(task).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(0);

    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('cancelAll drops pending tasks without running them', () => {
    const scheduler = new DebouncedWriteScheduler(100);
    const task = vi.fn();
    scheduler.schedule('a', task);
    scheduler.cancelAll();
    vi.advanceTimersByTime(100);
    expect(task).not.toHaveBeenCalled();
  });

  it('survives a throwing task', () => {
    const scheduler = new DebouncedWriteScheduler(100);
    scheduler.schedule('a', () => {
      throw new Error('boom');
    });
    const ok = vi.fn();
    scheduler.schedule('b', ok);
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });
});

describe('TouchBuffer', () => {
  it('keeps only the latest timestamp per key', () => {
    const buffer = new TouchBuffer();
    buffer.add('a', 1);
    buffer.add('a', 5);
    buffer.add('b', 2);

    expect(buffer.size).toBe(2);
    expect(buffer.drain()).toEqual([
      { key: 'a', lastUsedAt: 5 },
      { key: 'b', lastUsedAt: 2 }
    ]);
    expect(buffer.size).toBe(0);
  });
});
