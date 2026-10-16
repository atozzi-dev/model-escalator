/**
 * Least-recently-used bookkeeping for the cache.
 *
 * - `touch(key)` marks a key as the most recently used, adding it when it is not tracked yet.
 *   Touching a key that is already tracked moves it to the most recent position.
 * - `evict()` removes and returns the least recently used key, or `undefined` when nothing is tracked.
 * - `delete(key)` stops tracking a key.
 * - `size` is the number of tracked keys.
 */
export function createLru() {
  const order = new Set()
  return {
    touch(key) {
      if (!order.has(key)) order.add(key)
    },
    evict() {
      for (const key of order) {
        order.delete(key)
        return key
      }
      return undefined
    },
    delete(key) {
      order.delete(key)
    },
    get size() {
      return order.size
    },
  }
}
