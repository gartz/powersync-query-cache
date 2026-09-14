import { QueryCacheInvalidation } from '../types.js';

/**
 * Cross-context invalidation and platform flush hooks.
 *
 * Writes are deliberately not coordinated between tabs — two tabs writing the same key
 * both wrote a valid result, so last-writer-wins is fine. Invalidation is different: a
 * tab that stays open across a logout must drop its in-memory layer, or it keeps
 * serving the previous identity's rows.
 *
 * @internal
 */

export interface InvalidationChannel {
  subscribe(handler: (event: QueryCacheInvalidation) => void): () => void;
  publish(event: QueryCacheInvalidation): void;
  close(): void;
}

export function createInvalidationChannel(name: string): InvalidationChannel {
  if (typeof BroadcastChannel === 'undefined') {
    // Older browsers and some webviews: caching still works, it just is not shared.
    return {
      subscribe: () => () => {},
      publish: () => {},
      close: () => {}
    };
  }

  const channel = new BroadcastChannel(name);

  return {
    subscribe(handler) {
      const listener = (event: MessageEvent<QueryCacheInvalidation>) => handler(event.data);
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    publish(event) {
      channel.postMessage(event);
    },
    close() {
      channel.close();
    }
  };
}

/**
 * Runs `flush` when the page is going away, so debounced writes are not lost.
 * `pagehide` fires on bfcache navigations too, where `beforeunload` does not.
 */
export function registerFlushTriggers(flush: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const onPageHide = () => flush();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  };

  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
