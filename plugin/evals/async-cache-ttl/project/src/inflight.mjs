/**
 * Tracks the loads in progress, at most one per key.
 *
 * - `start(key, run, onSuccess)` calls `run()` right away (a synchronous throw becomes a rejection),
 *   remembers the resulting promise as the load of `key` and returns it.
 * - `get(key)` returns the promise of the load in progress for `key`, or `undefined`.
 * - When the load settles, the key is forgotten *if the load is still the current one* for that key,
 *   so a later `start` begins a fresh load. This holds for failures as well as for successes: a
 *   rejected load must not stay registered.
 * - `onSuccess(value)` is called when the load fulfils, only if it is still the current load, and
 *   before the callers waiting on the promise resume.
 * - `cancel(key)` forgets the load of `key` at once. The callers already waiting on its promise still
 *   get the result, but the load is no longer current, so `onSuccess` is not called for it.
 */
export function createInflight() {
  const loads = new Map()
  return {
    get(key) {
      return loads.get(key)
    },
    start(key, run, onSuccess) {
      const promise = new Promise((resolve) => resolve(run()))
      loads.set(key, promise)
      promise.then(
        (value) => {
          loads.delete(key)
          onSuccess?.(value)
        },
        () => {},
      )
      return promise
    },
    cancel(key) {
      loads.delete(key)
    },
    cancelAll() {
      loads.clear()
    },
  }
}
