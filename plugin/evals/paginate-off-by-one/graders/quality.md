---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- `paginate` computes the page count by rounding up and slices from `(page - 1) * pageSize`; `describePage` reports the last item index as `first + items.length - 1`.
- The fixes address the cause, not specific test inputs (no special cases for particular lengths or page numbers).
- The change is small and limited to `src/paginate.mjs` and `src/format.mjs`; no unrelated rewrites, renames or new dependencies; the style matches the surrounding code.
- No existing test file was changed.
