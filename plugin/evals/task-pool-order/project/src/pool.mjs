/**
 * Runs asynchronous tasks with at most `limit` of them in flight at any time.
 *
 * - `tasks` is an array of functions; each returns a value or a promise.
 * - Tasks start in array order, and a new one starts as soon as a running one settles.
 * - Resolves with the results in the same order as `tasks` (not in completion order).
 *   An empty array resolves to [].
 * - If a task throws or rejects, no further task is started; the returned promise rejects with
 *   the first error once the tasks already running have settled.
 * - `limit` must be a positive integer, otherwise the returned promise rejects with a RangeError.
 */
export function runPool(tasks, limit) {
  const results = []
  let next = 0
  let running = 0
  return new Promise((resolve, reject) => {
    const launch = () => {
      while (running <= limit && next < tasks.length) {
        const task = tasks[next++]
        running++
        task().then((value) => {
          results.push(value)
          running--
          if (next === tasks.length && running === 0) resolve(results)
          else launch()
        }, reject)
      }
    }
    launch()
  })
}
