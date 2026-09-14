# powersync-query-cache

A persistent two-layer (memory → IndexedDB) cache of watched query results. Screens paint instantly on refresh and back-navigation before the local database has opened, then reconcile to the live result.

## Installation

```bash
npm add powersync-query-cache
```

For web applications with IndexedDB support, also install the browser storage adapter:

```bash
npm add powersync-query-cache
```

The package ships both the plugin and the storage adapter in a single npm dependency.

## Quick start

```ts
import { PowerSyncDatabase } from '@powersync/web';
import { QueryCachePlugin, CACHE_SOURCE } from 'powersync-query-cache';
import { IndexedDbQueryCacheStorage } from 'powersync-query-cache/idb';

const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'app.db' },
  plugins: [
    new QueryCachePlugin({
      storage: new IndexedDbQueryCacheStorage()
    })
  ]
});

// Watch a query
const watched = db.query({ sql: 'SELECT * FROM todos' }).watch();

// Access the result and its provenance
console.log(watched.state.data);           // The rows
console.log(watched.state.source);         // 'placeholder' | 'cache' | 'live'
console.log(watched.state.isLoading);      // false when cached result is painted
```

Once the query resolves against the live database, `source` flips to `'live'` and stays there.

## Per-query control

Opt out of caching for a query:

```ts
db.query({
  sql: 'SELECT * FROM todos',
  extensions: { cache: false }
});
```

Or override the TTL:

```ts
db.query({
  sql: 'SELECT * FROM todos',
  extensions: { cache: { ttlMs: 60_000 } }  // Cache for 1 minute instead of 7 days
});
```

The same options apply to `watch()` and `differentialWatch()`:

```ts
watched.updateSettings({
  query: { sql, parameters },
  extensions: { cache: false }
});
```

## Encryption

When the database is opened with an `encryptionKey`, cached payloads are encrypted with AES-GCM using a key derived from it via HKDF-SHA256. 

Pass the encryption key **in the plugin options**:

```ts
new QueryCachePlugin({
  storage: new IndexedDbQueryCacheStorage(),
  encryptionKey: 'your-encryption-key'
})
```

The SDK does **not** expose the database encryption key to plugins. If you are using a database encryption key, pass it to the plugin separately.

**If your encryption key comes from a user passphrase:** HKDF-SHA256 does not stretch the key. Supply an already-stretched `CryptoKey` instead:

```ts
import { getHashedPassphraseKey } from 'your-crypto-lib';

const stretchedKey = await getHashedPassphraseKey(passphrase, salt);

new QueryCachePlugin({
  storage: new IndexedDbQueryCacheStorage(),
  encryption: { getKey: () => stretchedKey }
})
```

Key rotation is automatic: when the encryption key or plugin version changes, old cached entries are pruned on the next `pruneForeign()` call.

## Provenance and cache age

`WatchedQueryState` carries two fields reporting the result's origin:

- `source: 'placeholder' | 'cache' | 'live'` — where the data came from.
- `cachedAt: Date | null` — when the cached result was written, or `null` if not from cache.

```ts
if (watched.state.source === 'cache') {
  const ageMs = Date.now() - watched.state.cachedAt!.getTime();
  console.log(`Painted from cache, ${ageMs}ms old`);
}
```

For React, the cache metadata is available via:

```ts
import { getCacheMeta } from 'powersync-query-cache';

const meta = getCacheMeta(queryState);
console.log(meta?.cachedAt, meta?.ttlMs);
```

## Defaults

- **TTL:** 604,800,000 ms (7 days)
- **Memory budget:** 8,388,608 bytes (8 MiB)
- **Persistent budget:** 52,428,800 bytes (50 MiB)
- **Max entry size:** 1,048,576 bytes (1 MiB)
- **Debounce:** 1500 ms before writes reach storage
- **Encryption:** AES-GCM-256, 12-byte IV, HKDF-SHA256 salt = namespace

## Lifecycle

Cached entries are bound to:
- The database name
- The schema
- A cache version (configurable, bump to invalidate everything)
- The encryption key fingerprint (when applicable)

They are:
- **Cleared** by `disconnectAndClear()` — logs out, switches users, etc.
- **Pruned** when any of the identity inputs change — schema upgrade, key rotation, etc.
- **Evicted** least-recently-used once any layer's byte budget is exceeded, regardless of TTL.
- **Dropped** once past their TTL.

The memory layer is per–database instance and never encrypted. The persistent layer (IndexedDB) survives page reloads and browser restarts.

## Requirements

- **@powersync/common:** >= 2.3.0 (the version shipping the watched-query plugin API). Until published upstream, install the PowerSync SDK from the fork at `github.com/gartz/powersync-js` branch `persistent-query-cache`.
- **React Native:** Requires a WebCrypto polyfill. Node.js has no bundled storage adapter — implement `QueryCacheStorage` or the cache will run memory-only.
- **Browsers:** IndexedDB is required for the persistent layer. Older browsers without IndexedDB fall back to memory-only caching.

## Limitations

- **Not cached:** The legacy `db.watch(sql, parameters)` API (its result shape cannot be serialized) and `runQueryOnce()` one-shot queries.
- **Encryption:** The SDK does not expose its database encryption key to plugins. If you need the cache encrypted with the same key, pass it separately to the plugin.

## TypeScript

The cache plugin and all storage adapters are fully typed. Import types as needed:

```ts
import { CacheSourceMeta, QueryCachePluginOptions } from 'powersync-query-cache';
import type { IndexedDbQueryCacheStorageOptions } from 'powersync-query-cache/idb';
```
