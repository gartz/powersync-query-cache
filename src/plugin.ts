import {
  DatabasePluginContext,
  LogLevels,
  WatchedQueryHooks,
  WatchedQueryPlugin,
  WatchedQueryPluginContext,
  WatchedQueryState
} from '@powersync/common';
import { computeCacheNamespace } from './namespace.js';
import { createQueryCacheManager, QueryCacheManager } from './QueryCacheManager.js';
import { QueryCacheOptions, QueryCacheQueryOption } from './types.js';

export const CACHE_SOURCE = 'cache';

export interface CacheSourceMeta {
  cachedAt: Date;
}

/**
 * Narrows {@link WatchedQueryState.sourceMeta} when the state is showing cached data.
 */
export function getCacheMeta(state: Pick<WatchedQueryState<unknown>, 'source' | 'sourceMeta'>): CacheSourceMeta | undefined {
  return state.source === CACHE_SOURCE ? (state.sourceMeta as CacheSourceMeta) : undefined;
}

/**
 * Options for {@link QueryCachePlugin}. Extends the storage/TTL/budget options with the
 * one input the plugin cannot discover through the public database API:
 * the SQLite encryption key (spec rule 9) — pass it when the database is encrypted so
 * cached payloads are sealed with a key derived from it and pruned on rotation.
 */
export type QueryCachePluginOptions = QueryCacheOptions;

export class QueryCachePlugin implements WatchedQueryPlugin {
  readonly id = 'cache';

  private manager?: QueryCacheManager;

  constructor(private readonly options: QueryCachePluginOptions) {}

  onDatabaseOpen({ db, logger }: DatabasePluginContext): () => Promise<void> {
    this.manager = createQueryCacheManager({
      options: this.options,
      namespace: computeCacheNamespace({
        databaseName: db.database.name,
        schemaJson: db.schema.toJSON(),
        version: String(this.options.version ?? '1'),
        encryptionKey: this.options.encryptionKey,
        subtle: globalThis.crypto.subtle
      }),
      logger
    });

    void this.manager.pruneForeign();

    const disposeCleared = db.registerListener({
      cleared: () => {
        void this.manager?.clear().catch((error) =>
          logger.log({ level: LogLevels.warn, message: 'Query cache clear failed.', error })
        );
      }
    });

    return async () => {
      disposeCleared();
      await this.manager?.close();
      this.manager = undefined;
    };
  }

  onWatchedQueryCreate(context: WatchedQueryPluginContext): WatchedQueryHooks | undefined {
    const manager = this.manager;
    // Spec rule 8 guarantees onDatabaseOpen ran before any query hooks, so a missing
    // manager means the plugin was disposed — ignore the query either way.
    if (!manager?.enabled || !context.dataIsArray) {
      return undefined;
    }
    const resolved = manager.resolveForQuery(context.extensionOptions as QueryCacheQueryOption | undefined);
    if (!resolved.enabled) {
      return undefined;
    }

    const signature = context.signature;

    return {
      seedInitial: () => {
        const hit = manager.peek(signature, resolved.ttlMs);
        return hit && { data: hit.rows, source: CACHE_SOURCE, sourceMeta: { cachedAt: hit.cachedAt } };
      },
      onLink: (seed, signal) => {
        void manager.hydrate(signature, resolved.ttlMs, signal).then((hit) => {
          if (hit) {
            seed({ data: hit.rows, source: CACHE_SOURCE, sourceMeta: { cachedAt: hit.cachedAt } });
          }
        });
      },
      onResult: (rows, info) => {
        if (info.dataIsArray) {
          // The TTL is a read-side decision (peek/hydrate compare against it), so the
          // write does not carry one.
          manager.record(signature, rows as unknown[], { hasSynced: info.hasSynced });
        }
      }
    };
  }

  /**
   * Drains pending cache writes and resolves once they have reached storage.
   *
   * Writes are debounced, so without this a page that is about to go away (or a test
   * about to assert on storage) can lose the last emission. The plugin also flushes on
   * the platform's own triggers and on database close.
   */
  flush(): Promise<void> {
    return this.manager?.flush() ?? Promise.resolve();
  }
}
