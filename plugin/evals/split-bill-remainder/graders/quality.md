---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- `splitByWeight` implements the largest-remainder method described in its doc comment (floors first, then one cent each to the largest fractional parts, ties to the first listed), handles a negative total by splitting the absolute value and negating, and validates its input with `RangeError`.
- `formatCents` handles the sign separately from the digits, so negative amounts print as `-0.05` or `-1,234.56`.
- The fixes are general: no special cases for particular totals, weights or test values, no retry loops that adjust shares until the sum matches.
- The change is limited to `src/split.mjs` and `src/money.mjs`, readable, and consistent with the existing style; no existing test file was changed.
