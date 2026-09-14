import { QueryCacheInvalidation } from '../../src/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createInvalidationChannel, registerFlushTriggers } from '../../src/idb/broadcast.js';

describe('invalidation channel', () => {
  it('delivers messages to other subscribers', async () => {
    const name = `channel-${crypto.randomUUID()}`;
    const publisher = createInvalidationChannel(name);
    const subscriber = createInvalidationChannel(name);

    const received: QueryCacheInvalidation[] = [];
    subscriber.subscribe((event) => received.push(event));

    publisher.publish({ type: 'all' });
    await vi.waitFor(() => expect(received).toEqual([{ type: 'all' }]));

    publisher.close();
    subscriber.close();
  });

  it('carries the namespace for scoped invalidations', async () => {
    const name = `channel-${crypto.randomUUID()}`;
    const publisher = createInvalidationChannel(name);
    const subscriber = createInvalidationChannel(name);

    const received: QueryCacheInvalidation[] = [];
    subscriber.subscribe((event) => received.push(event));

    publisher.publish({ type: 'namespace', namespace: 'ns-1' });
    await vi.waitFor(() => expect(received).toEqual([{ type: 'namespace', namespace: 'ns-1' }]));

    publisher.close();
    subscriber.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const name = `channel-${crypto.randomUUID()}`;
    const publisher = createInvalidationChannel(name);
    const subscriber = createInvalidationChannel(name);

    const received: QueryCacheInvalidation[] = [];
    const unsubscribe = subscriber.subscribe((event) => received.push(event));
    unsubscribe();

    publisher.publish({ type: 'all' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(0);

    publisher.close();
    subscriber.close();
  });
});

describe('registerFlushTriggers', () => {
  it('flushes on pagehide and stops after disposal', () => {
    const flush = vi.fn();
    const dispose = registerFlushTriggers(flush);

    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);

    dispose();
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
