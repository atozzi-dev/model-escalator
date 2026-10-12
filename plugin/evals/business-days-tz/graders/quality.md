---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- Dates are handled as calendar days independent of the local time zone: either everything uses UTC (`Date.UTC`, `getUTCDay`, `setUTCDate` and similar) or pure arithmetic on year, month and day; no mix of UTC parsing with local getters or setters remains.
- `businessDaysBetween` counts start-exclusive and end-inclusive, and is antisymmetric when the end is before the start.
- The fix does not depend on the time zone of the machine (no hard-coded offsets, no forcing `process.env.TZ` in the source) and has no special cases for particular dates.
- The change is focused (mainly `src/bizdays.mjs`), readable and consistent with the existing style; no existing test file was changed.
