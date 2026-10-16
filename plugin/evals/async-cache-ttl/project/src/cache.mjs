import { createInflight } from './inflight.mjs'
import { createLru } from './lru.mjs'

/**
 * Async cache with a TTL, stale-while-revalidate, de-duplicated loads and LRU eviction.
 *
 *   createCache({ load, ttlMs, staleMs = 0, maxEntries = Infinity, now = Date.now })
 *
 * `load(key)` returns a value or a promise. `now()` is the clock in milliseconds.
 *
 * `get(key)` returns a promise of the value:
 *  - The age of an entry is measured from the moment its load COMPLETED, not from when it started.
 *  - age < ttlMs: the entry is fresh; it is returned and no load happens.
 *  - ttlMs <= age < ttlMs + staleMs: the entry is stale; it is returned immediately and one background
 *    refresh starts (none if a load for the key is already in progress). If the refresh fails the stale
 *    entry is kept and the error is ignored; the next `get` tries again.
 *  - otherwise the entry is missing (an expired entry is dropped). Concurrent `get`s of the same key
 *    share a single load. If it rejects, every waiter rejects with that error and nothing is stored:
 *    the next `get` loads again.
 *  - Every `get` that returns a stored entry, and every load that completes, makes the key the most
 *    recently used one.
 *  - After a value is stored, the least recently used entries are dropped while more than `maxEntries`
 *    are stored. Loads in progress are not entries.
 *
 * `invalidate(key)` drops the stored entry and forgets the load in progress for the key: its waiters
 * still receive the value, but it is not stored. The next `get` loads again. `clear()` does the same
 * for every key. `size` is the number of stored entries.
 */
export function createCache({ load, ttlMs, staleMs = 0, maxEntries = Infinity, now = Date.now }) {
  const entries = new Map()
  const lru = createLru()
  const inflight = createInflight()

  function store(key, value, storedAt) {
    entries.set(key, { value, storedAt })
    lru.touch(key)
    while (entries.size > maxEntries) {
      const victim = lru.evict()
      if (victim === undefined) break
      entries.delete(victim)
    }
  }

  function fetch(key) {
    const startedAt = now()
    return inflight.get(key) ?? inflight.start(key, () => load(key), (value) => store(key, value, startedAt))
  }

  function get(key) {
    const entry = entries.get(key)
    if (entry) {
      const age = now() - entry.storedAt
      if (age <= ttlMs) {
        lru.touch(key)
        return Promise.resolve(entry.value)
      }
      if (age < ttlMs + staleMs) {
        fetch(key)
        return Promise.resolve(entry.value)
      }
      entries.delete(key)
      lru.delete(key)
    }
    return fetch(key)
  }

  function invalidate(key) {
    entries.delete(key)
    lru.delete(key)
  }

  function clear() {
    for (const key of entries.keys()) lru.delete(key)
    entries.clear()
    inflight.cancelAll()
  }

  return {
    get,
    invalidate,
    clear,
    get size() {
      return entries.size
    },
  }
}
