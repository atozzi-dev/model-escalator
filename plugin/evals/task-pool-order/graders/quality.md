---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- `runPool` stores each result at its task's index, keeps at most `limit` tasks running (`running < limit`), resolves `[]` for an empty list, treats synchronous throws and plain return values like promises, stops starting tasks after the first failure and rejects with that first error only once the running tasks have settled, and rejects with `RangeError` for an invalid limit.
- `withRetry` makes exactly `attempts` attempts, waits `baseDelayMs * 2 ** (n - 1)` before retry n, and does not wait after the last attempt.
- The code is not timing-dependent (no arbitrary timeouts or polling) and has no special cases for test values.
- The change is limited to `src/pool.mjs` and `src/retry.mjs`, readable and consistent with the existing style; no existing test file was changed.
