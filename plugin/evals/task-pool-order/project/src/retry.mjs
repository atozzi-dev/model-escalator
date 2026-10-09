/**
 * Wraps a task so that it is retried when it fails.
 *
 * - The task runs at most `attempts` times in total (so `attempts - 1` retries).
 * - Before retry number n (1-based) it waits `baseDelayMs * 2 ** (n - 1)` milliseconds,
 *   using the injected `sleep(ms)` function, which returns a promise.
 * - Resolves with the first successful result; if every attempt fails, rejects with the
 *   error of the last attempt.
 */
export function withRetry(task, { attempts = 3, baseDelayMs = 100, sleep } = {}) {
  return async () => {
    let lastError
    for (let attempt = 1; attempt < attempts; attempt++) {
      try {
        return await task()
      } catch (error) {
        lastError = error
        await sleep(baseDelayMs * 2 ** attempt)
      }
    }
    throw lastError
  }
}
