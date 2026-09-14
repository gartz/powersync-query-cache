# powersync-query-cache

A persistent two-layer (memory → IndexedDB) cache of watched query results. Screens paint instantly on refresh and back-navigation before the local database has opened, then reconcile to the live result.

## Installation

```bash
npm add powersync-query-cache
```

The package ships both the plugin and the browser (IndexedDB) storage adapter, the
latter under the `powersync-query-cache/idb` entry point.

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

The same options apply to `watch()` and `differentialWatch()`, and to a later
`updateSettings()` on an existing watched query. Note that `updateSettings` takes a
`WatchCompatibleQuery`, not a raw `{ sql, parameters }` object:

```ts
watched.updateSettings({
  query: {
    compile: () => ({ sql: 'SELECT * FROM todos WHERE done = ?', parameters: [0] }),
    execute: ({ sql, parameters }) => db.getAll(sql, parameters)
  },
  extensions: { cache: false }
});
```

Extensions declared on a `db.query({ ... })` definition stay in force across
`updateSettings()` calls; per-call `extensions` override them key by key.

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

Key rotation is automatic: when the encryption key or plugin version changes, the
identity bucket changes with it, so old entries no longer match any query and are
pruned the next time the plugin opens.

The namespace also embeds a fingerprint of the encryption key, derived with HKDF-SHA256
under a fixed salt. The key itself is never written anywhere. HKDF does not stretch,
though — if your key comes from a user passphrase, use `encryption.getKey` above so the
passphrase is not recoverable from the stored namespace by dictionary search.

## Provenance and cache age

`WatchedQueryState.source` reports where the data came from:

- `'placeholder'` — the configured placeholder, no query has resolved yet
- `'cache'` — a previously persisted result, painted before the live query resolved
- `'live'` — the current result of the query against the local database

When `source` is `'cache'`, the cache metadata is available via `getCacheMeta()`:

```ts
import { getCacheMeta } from 'powersync-query-cache';

if (watched.state.source === 'cache') {
  const meta = getCacheMeta(watched.state);
  if (meta) {
    const ageMs = Date.now() - meta.cachedAt.getTime();
    console.log(`Painted from cache, ${ageMs}ms old`);
  }
}
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
- **Pruned** at startup when any of the identity inputs change — schema upgrade, key
  rotation, cache-version bump. The bucket is computed once when the database opens, so
  a schema change mid-session takes effect on the next start.
- **Evicted** least-recently-used once any layer's byte budget is exceeded, regardless of TTL.
- **Dropped** once past their TTL.

The memory layer is per–database instance and never encrypted. The persistent layer (IndexedDB) survives page reloads and browser restarts.

## Performance

The whole point of the cache is time-to-first-render. Two moments matter:

- **Cold boot** (page load, refresh): a fresh page has to open the SQLite database
  (backed by IndexedDB in the browser), initialize the PowerSync session, and run the
  first query before anything can render — and that cost grows with database size. The
  cached paint reads one small IndexedDB entry instead, so it stays flat.
- **In-session navigation** (back/forward, route changes): the database is already
  open, but re-mounting a watched query still re-runs the live query. The memory layer
  seeds the re-mounted query's *constructed* state synchronously — the first render
  already has the rows, with no async gap at all.

Measured with the bundled benchmark (`npm run bench:browser`, headless Chromium,
median of 3 runs per mode; a dashboard-shaped watched query — `ORDER BY` over a
non-indexed column with `LIMIT 50` — against ~1 KB rows):

**Cold boot — time to first rows:**

| Database size | Without cache | With cache | Speedup |
| --- | --- | --- | --- |
| 10 MB (8k rows) | 1,261 ms | 84 ms | ~15× |
| 50 MB (38k rows) | 6,650 ms | 86 ms | ~77× |
| 100 MB (74k rows) | 13,020 ms | 68 ms | ~190× |
| 200 MB (148k rows) | 22,739 ms | 66 ms | ~346× |

**In-session navigation (query re-mounted, database already open) — time to first rows:**

| Database size | Without cache | With cache (memory layer) |
| --- | --- | --- |
| 10 MB | 68 ms | 0.17 ms |
| 50 MB | 5,940 ms | 0.35 ms |
| 100 MB | 12,411 ms | 0.44 ms |
| 200 MB | 25,471 ms | 0.13 ms |

Three things to read out of the tables:

- **Without the cache, first render scales with database size** — on cold boot AND on
  every navigation whose query has to scan (the 10 MB nav row is small only because
  that table still fits the warm page cache; past it, re-mounting costs as much as
  booting).
- **The cold-boot cached paint is constant** (~65–90 ms here) regardless of size: it
  never touches SQLite.
- **The navigation cached paint is synchronous** — sub-millisecond and flat, because
  the memory layer fills the watched query's initial state before the first render.
  Pressing back/forward repaints the previous screen instantly; the live result still
  arrives and swaps in (`source` flips `'cache'` → `'live'`).

Numbers were taken inside the test runner, where a "cold boot" is a fresh
`PowerSyncDatabase` instance re-reading pages from IndexedDB (wa-sqlite's page cache is
per-connection), and a "navigation" is tearing down and re-creating the watched query
on the open instance. Absolute times will differ per machine, browser, and query —
re-run `npm run bench:browser` to measure your own; results land in
`tests/benchmark/latest-results.json`.

## Requirements

- **@powersync/common:** >= 2.3.0 (the version shipping the watched-query plugin API). Until published upstream, install the PowerSync SDK from the fork at `github.com/gartz/powersync-js` branch `persistent-query-cache`.
- **React Native:** Requires a WebCrypto polyfill. Node.js has no bundled storage adapter — implement `QueryCacheStorage` or the cache will run memory-only.
- **Browsers:** IndexedDB is required for the persistent layer. Older browsers without IndexedDB fall back to memory-only caching.

## Limitations

- **Not cached:** The legacy `db.watch(sql, parameters)` API (its result shape cannot be serialized) and `runQueryOnce()` one-shot queries.
- **Encryption:** The SDK does not expose its database encryption key to plugins. If you need the cache encrypted with the same key, pass it separately to the plugin.

## Development

The `@powersync/*` entries under `devDependencies` are `file:` paths into a **local
checkout** of the PowerSync SDK, not published packages — the watched-query plugin API
this package is built on has not shipped upstream yet (see **Requirements** above).
Check out the fork's `persistent-query-cache` branch, build it with
`pnpm build:packages`, and make the `file:` paths point at it before `npm install`.

The browser test suite has to allow-list that checkout for Vite. It defaults to
`/powersync-js`; set `POWERSYNC_SDK_PATH` if yours lives elsewhere:

```bash
POWERSYNC_SDK_PATH=~/src/powersync-js npm run test:browser
```

```bash
npm run build        # tsc -b
npm run test:node    # unit tests, no browser
npm run test:browser # IndexedDB + end-to-end tests under Playwright
```

## TypeScript

The cache plugin and all storage adapters are fully typed. Import types as needed:

```ts
import { CacheSourceMeta, QueryCachePluginOptions } from 'powersync-query-cache';
import type { IndexedDbQueryCacheStorageOptions } from 'powersync-query-cache/idb';
```
