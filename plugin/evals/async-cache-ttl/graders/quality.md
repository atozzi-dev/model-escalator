---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- `lru.mjs`: `touch` moves an already tracked key to the most recent position. `inflight.mjs`: a load is forgotten when it settles, on failure as well as on success, but only if it is still the current load for that key; `onSuccess` runs only for the current load. `cache.mjs`: freshness is `age < ttlMs`, the age counts from the completion of the load, stale hits refresh in the background without unhandled rejections and touch the key, and `invalidate` also cancels the load in progress.
- The code is not timing-dependent (no arbitrary timeouts or polling) and has no special cases for test values.
- The change stays in `src/cache.mjs`, `src/inflight.mjs` and `src/lru.mjs`, is readable and consistent with the existing style, and the doc comments still match the behaviour; no existing test file was changed.
